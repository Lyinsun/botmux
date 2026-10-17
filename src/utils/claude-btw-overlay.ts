/**
 * Relay Claude Code's `/btw` side answer back to the IM thread.
 *
 * Claude Code answers `/btw <question>` in a dismissible overlay above the
 * composer. The answer is never written to the session transcript, so the
 * usual final-output path cannot see it — without this guard a Feishu user
 * who sends `/btw` only gets a streaming card and has to open the web
 * terminal to read the reply.
 *
 * The overlay (Claude Code v2.1.x) looks like this while answering:
 *
 *     ▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔
 *         /btw what is 1+1?
 *           ✽ Answering…
 *         Esc to close
 *
 * and once the answer has finished:
 *
 *         /btw what is 1+1?
 *           1 + 1 equals 2.
 *         ↑/↓ to scroll · c to copy · f to fork · Esc to close
 *
 * Completion is read from the *rendered screen*, line by line. The raw PTY
 * stream is not usable for that: Claude Code repaints differentially (cursor
 * moves, skipped unchanged cells), so footer words need not arrive as one
 * contiguous string, and a whitespace-insensitive substring match also hits
 * answer text or the echoed question that merely mention the shortcuts.
 *
 * Pressing `c` in the finished overlay makes Claude Code emit the complete,
 * unwrapped answer as an OSC 52 clipboard sequence. That escape sequence is
 * written in one piece, so it *is* taken from the raw stream. It is the
 * primary capture path: not limited to the viewport and keeps the original
 * Markdown. Reading the rendered overlay is the fallback.
 *
 * The guard is armed only by botmux's own `/btw` passthrough, so it never
 * inspects arbitrary screens. The caller disarms it on a timeout or respawn.
 */

export type ClaudeBtwScreenAction =
  | { kind: 'pass' }
  /** Our overlay finished answering: press `c` to copy the answer. */
  | { kind: 'copy' };

export type ClaudeBtwDataAction =
  | { kind: 'pass' }
  /** The copied answer arrived as OSC 52. One-shot: the guard is disarmed,
   *  so the question is carried here rather than read back from the guard. */
  | { kind: 'answer'; text: string; question: string };

type Phase = 'idle' | 'answering' | 'copying';

// Keep enough raw bytes for a long answer's OSC 52 payload (base64 inflates
// text by 4/3).
const RAW_TAIL_LIMIT = 512 * 1024;

// Body may be split across chunks; only a terminated sequence is accepted.
// Inside tmux, Claude Code may wrap it in a DCS passthrough
// (`\x1bPtmux;\x1b\x1b]52;c;…\x07\x1b\\`), which still contains `\x1b]52;`.
const OSC52_RE = /\x1b\]52;[^;\x07\x1b]*;([A-Za-z0-9+/=\r\n]*)(?:\x07|\x1b\\)/g;

export class ClaudeBtwCaptureGuard {
  private phase: Phase = 'idle';
  private answeringSeen = false;
  private rawTail = '';
  private _question = '';

  /** Arm right before a `/btw <question>` passthrough is written. */
  arm(question: string): void {
    this.phase = 'answering';
    this.answeringSeen = false;
    this.rawTail = '';
    this._question = question;
  }

  isArmed(): boolean {
    return this.phase !== 'idle';
  }

  get question(): string {
    return this._question;
  }

  /** Whether `c` has been pressed and the guard waits for the OSC 52 copy. */
  isCopying(): boolean {
    return this.phase === 'copying';
  }

  /** The caller pressed `c`; from now on look for the clipboard sequence. */
  markCopyRequested(): void {
    if (this.phase !== 'answering') return;
    this.phase = 'copying';
    this.rawTail = '';
  }

  /** The copy produced nothing and the overlay is still answering: wait for
   *  the finished footer again instead of giving up. */
  revertToAnswering(): void {
    if (this.phase !== 'copying') return;
    this.phase = 'answering';
    this.rawTail = '';
  }

  disarm(): void {
    this.phase = 'idle';
    this.answeringSeen = false;
    this.rawTail = '';
    this._question = '';
  }

  /**
   * Inspect the rendered screen. `copy` requires our own overlay (question
   * matches) to have been seen in its answering state first and to now show
   * the finished footer — so no overlay at all (old CLI, command error) can
   * never lead to a `c` landing in the composer.
   */
  inspectScreen(screen: string): ClaudeBtwScreenAction {
    if (this.phase !== 'answering') return { kind: 'pass' };
    const overlay = parseClaudeBtwOverlay(screen);
    if (!overlay || !sameQuestion(overlay.question, this._question)) return { kind: 'pass' };
    if (overlay.state === 'answering') {
      this.answeringSeen = true;
      return { kind: 'pass' };
    }
    return this.answeringSeen ? { kind: 'copy' } : { kind: 'pass' };
  }

  /** Inspect a raw PTY chunk for the OSC 52 copy (copying phase only). */
  inspectData(data: string): ClaudeBtwDataAction {
    if (this.phase !== 'copying') return { kind: 'pass' };
    this.rawTail = (this.rawTail + data).slice(-RAW_TAIL_LIMIT);
    const text = extractOsc52Text(this.rawTail);
    if (text === undefined) return { kind: 'pass' };
    const question = this._question;
    this.disarm();
    return { kind: 'answer', text, question };
  }
}

/** The screen shows only the first visual row of a long question, and
 *  display snapshots may collapse spaces; compare whitespace-free prefixes. */
function sameQuestion(onScreen: string, armed: string): boolean {
  const a = onScreen.replace(/\s+/g, '');
  const b = armed.replace(/\s+/g, '');
  if (!a || !b) return false;
  return a.length <= b.length ? b.startsWith(a) : a.startsWith(b);
}

/** Decode the last complete OSC 52 clipboard payload in `raw`, if any. */
export function extractOsc52Text(raw: string): string | undefined {
  let last: string | undefined;
  OSC52_RE.lastIndex = 0;
  for (let m: RegExpExecArray | null; (m = OSC52_RE.exec(raw)); ) last = m[1];
  if (last === undefined) return undefined;
  const b64 = last.replace(/\s+/g, '');
  if (!b64) return undefined;
  const text = Buffer.from(b64, 'base64').toString('utf8').trim();
  return text || undefined;
}

/** The `/btw` question, or undefined when `content` is not a `/btw <question>`
 *  line (bare `/btw` has nothing to answer). */
export function claudeBtwQuestion(content: string): string | undefined {
  const m = /^\s*\/btw\s+([\s\S]*\S)\s*$/.exec(content);
  return m ? m[1] : undefined;
}

export interface ClaudeBtwOverlay {
  state: 'answering' | 'done';
  question: string;
  answer: string;
}

const QUESTION_LINE_RE = /^(\s*)\/btw\s+(.*\S)\s*$/;
// Whole-line footer templates. Finished: an optional navigation hint
// ("↑/↓ to scroll" / "⇧←/→ to browse"), then the copy/fork/clear shortcuts;
// right after `c` the copy hint briefly reads "Copied to clipboard".
// Answering: just "Esc to close".
const DONE_FOOTER_RE = /^(\s*)(?:\S[^·]* · )?(?:c to copy|Copied to clipboard) · (?:f to fork · )?(?:x to clear history · )?Esc to close\s*$/;
const ANSWERING_FOOTER_RE = /^(\s*)Esc to close\s*$/;
const BORDER_RE = /^\s*▔{8,}\s*$/;

/**
 * Read the `/btw` overlay from a rendered screen.
 *
 * The footer must be a whole line in one of the two templates. The question
 * is the *shallowest-indented* `/btw` line between the overlay border and
 * the footer (the overlay also lists earlier questions at the same depth;
 * the last of those is current), and must sit at the footer's indentation —
 * a `/btw` example inside an answer is indented deeper and cannot hijack it.
 */
export function parseClaudeBtwOverlay(screen: string): ClaudeBtwOverlay | undefined {
  const lines = screen.split('\n').map(l => l.replace(/\s+$/, ''));
  let footerAt = -1;
  let done = false;
  let footerIndent = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const d = DONE_FOOTER_RE.exec(lines[i]);
    const a = d ? undefined : ANSWERING_FOOTER_RE.exec(lines[i]);
    if (d || a) {
      footerAt = i;
      done = !!d;
      footerIndent = (d ?? a)![1].length;
      break;
    }
  }
  if (footerAt < 0) return undefined;

  let questionAt = -1;
  let questionIndent = Infinity;
  for (let i = footerAt - 1; i >= 0; i--) {
    if (BORDER_RE.test(lines[i])) break;
    const m = QUESTION_LINE_RE.exec(lines[i]);
    // Strictly shallower wins; on a tie keep the lower (later) line.
    if (m && m[1].length < questionIndent) {
      questionAt = i;
      questionIndent = m[1].length;
    }
  }
  if (questionAt < 0 || questionIndent !== footerIndent) return undefined;

  const question = QUESTION_LINE_RE.exec(lines[questionAt])![2];
  if (!done) return { state: 'answering', question, answer: '' };
  // Answer lines are indented deeper than the question line.
  const answerIndent = questionIndent + 2;
  const answer = lines.slice(questionAt + 1, footerAt)
    .map(l => (l.slice(0, answerIndent).trim() === '' ? l.slice(answerIndent) : l.trimStart()))
    .join('\n')
    .trim();
  return { state: 'done', question, answer };
}

/** Whether `screen` still shows a `/btw` overlay (so Esc closes the overlay
 *  instead of interrupting the running turn). */
export function claudeBtwOverlayVisible(screen: string): boolean {
  return parseClaudeBtwOverlay(screen) !== undefined;
}

import { stripAnsiForLog } from './crash-log.js';

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
 * Pressing `c` in the finished overlay makes Claude Code emit the complete,
 * unwrapped answer as an OSC 52 clipboard sequence. That is the primary
 * capture path: it is not limited to the visible viewport and keeps the
 * original Markdown. Reading the rendered overlay ({@link parseClaudeBtwOverlay})
 * is the fallback for terminals where no OSC 52 arrives.
 *
 * The guard is armed only by botmux's own `/btw` passthrough, so it never
 * inspects arbitrary screens. The caller disarms it on a timeout or respawn.
 */

export type ClaudeBtwCaptureAction =
  | { kind: 'pass' }
  /** The answer finished rendering: press `c` to copy it. */
  | { kind: 'copy' }
  /** The copied answer arrived as OSC 52. One-shot: the guard is disarmed,
   *  so the question is carried here rather than read back from the guard. */
  | { kind: 'answer'; text: string; question: string };

type Phase = 'idle' | 'answering' | 'copying';

// Keep enough raw bytes for a long answer's OSC 52 payload (base64 inflates
// text by 4/3); the plain tail only needs to hold the footer.
const RAW_TAIL_LIMIT = 512 * 1024;
const PLAIN_TAIL_LIMIT = 4_096;

// Body may be split across chunks; only a terminated sequence is accepted.
// Inside tmux, Claude Code may wrap it in a DCS passthrough
// (`\x1bPtmux;\x1b\x1b]52;c;…\x07\x1b\\`), which still contains `\x1b]52;`.
const OSC52_RE = /\x1b\]52;[^;\x07\x1b]*;([A-Za-z0-9+/=\r\n]*)(?:\x07|\x1b\\)/g;

export class ClaudeBtwCaptureGuard {
  private phase: Phase = 'idle';
  private plainTail = '';
  private rawTail = '';
  private _question = '';

  /** Arm right before a `/btw <question>` passthrough is written. */
  arm(question: string): void {
    this.phase = 'answering';
    this.plainTail = '';
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

  disarm(): void {
    this.phase = 'idle';
    this.plainTail = '';
    this.rawTail = '';
    this._question = '';
  }

  inspect(data: string): ClaudeBtwCaptureAction {
    if (this.phase === 'answering') {
      const plain = stripAnsiForLog(data).replace(/\s+/g, '').toLowerCase();
      this.plainTail = (this.plainTail + plain).slice(-PLAIN_TAIL_LIMIT);
      // "c to copy" only appears in the overlay footer once the answer is
      // complete; the in-progress footer is just "Esc to close". The tail
      // starts empty at arm time, so an earlier overlay cannot match.
      if (/ctocopy.*esctoclose/.test(this.plainTail)) {
        this.plainTail = '';
        return { kind: 'copy' };
      }
      return { kind: 'pass' };
    }
    if (this.phase === 'copying') {
      this.rawTail = (this.rawTail + data).slice(-RAW_TAIL_LIMIT);
      const text = extractOsc52Text(this.rawTail);
      if (text !== undefined) {
        const question = this._question;
        this.disarm();
        return { kind: 'answer', text, question };
      }
    }
    return { kind: 'pass' };
  }
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
const FOOTER_RE = /\bEsc to close\s*$/;
const DONE_FOOTER_RE = /\bc to copy\b/;

/**
 * Read the `/btw` overlay from a rendered screen. Uses the last `/btw` line
 * (the overlay also lists earlier questions above it) and the indented
 * lines below it up to the "Esc to close" footer.
 */
export function parseClaudeBtwOverlay(screen: string): ClaudeBtwOverlay | undefined {
  const lines = screen.split('\n').map(l => l.replace(/\s+$/, ''));
  let footerAt = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (FOOTER_RE.test(lines[i])) { footerAt = i; break; }
  }
  if (footerAt < 0) return undefined;
  let questionAt = -1;
  for (let i = footerAt - 1; i >= 0; i--) {
    if (QUESTION_LINE_RE.test(lines[i])) { questionAt = i; break; }
  }
  if (questionAt < 0) return undefined;
  const [, indent, question] = QUESTION_LINE_RE.exec(lines[questionAt])!;
  const body = lines.slice(questionAt + 1, footerAt);
  // Answer lines are indented deeper than the question line.
  const answerIndent = indent.length + 2;
  const answer = body
    .map(l => (l.slice(0, answerIndent).trim() === '' ? l.slice(answerIndent) : l.trimStart()))
    .join('\n')
    .trim();
  const done = DONE_FOOTER_RE.test(lines[footerAt]);
  return { state: done ? 'done' : 'answering', question, answer: done ? answer : '' };
}

/** Whether `screen` still shows a `/btw` overlay (so Esc closes the overlay
 *  instead of interrupting the running turn). */
export function claudeBtwOverlayVisible(screen: string): boolean {
  return parseClaudeBtwOverlay(screen) !== undefined;
}

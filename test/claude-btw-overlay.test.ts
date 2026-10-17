import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ClaudeBtwCaptureGuard,
  claudeBtwOverlayVisible,
  claudeBtwQuestion,
  extractOsc52Text,
  parseClaudeBtwOverlay,
} from '../src/utils/claude-btw-overlay.js';

// Screens and byte shapes captured from Claude Code v2.1.300 in tmux.
const ANSWERING_CHUNK = [
  '\x1b[38;5;153m▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔\x1b[39m\r\n',
  '    \x1b[1m\x1b[38;5;220m/btw \x1b[0m\x1b[38;5;246mwhat is 1+1? answer in two short sentences\x1b[39m\r\n',
  '      \x1b[38;5;220m✽\x1b[39m \x1b[38;5;220mAnswering…\x1b[39m\r\n',
  '    \x1b[38;5;246mEsc to close\x1b[39m\r\n',
].join('');
const DONE_CHUNK = [
  '      1 + 1 equals 2. This is the basic sum of two ones.\r\n',
  '    \x1b[38;5;246m↑/↓ to scroll · c to copy · f to fork · Esc to close\x1b[39m\r\n',
].join('');

const DONE_SCREEN = [
  '✻ Cogitated for 7s · done 1:06 PM · 1 shell still running',
  '▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔',
  '    /btw what is 1+1? answer in two short sentences',
  '    /btw list three months, one per line',
  '      January: named after Janus.',
  '      February: the shortest month.',
  '        - nested detail',
  '      March: first month of the old Roman year.',
  '    ⇧←/→ to browse · c to copy · f to fork · x to clear history · Esc to close',
].join('\n');

function osc52(text: string, terminator = '\x07'): string {
  return `\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}${terminator}`;
}

describe('claudeBtwQuestion', () => {
  it('returns the question of a /btw line', () => {
    expect(claudeBtwQuestion('/btw what is 1+1?')).toBe('what is 1+1?');
    expect(claudeBtwQuestion('  /btw  多行\n问题  ')).toBe('多行\n问题');
  });

  it('ignores bare /btw and other commands', () => {
    expect(claudeBtwQuestion('/btw')).toBeUndefined();
    expect(claudeBtwQuestion('/btw   ')).toBeUndefined();
    expect(claudeBtwQuestion('/btwx hi')).toBeUndefined();
    expect(claudeBtwQuestion('please /btw hi')).toBeUndefined();
    expect(claudeBtwQuestion('/compact')).toBeUndefined();
  });
});

describe('extractOsc52Text', () => {
  it('decodes BEL- and ST-terminated payloads, keeping the last one', () => {
    expect(extractOsc52Text(`noise${osc52('first')}more${osc52('第二个答案', '\x1b\\')}`)).toBe('第二个答案');
  });

  it('decodes a tmux DCS-wrapped payload', () => {
    const b64 = Buffer.from('wrapped', 'utf8').toString('base64');
    expect(extractOsc52Text(`\x1bPtmux;\x1b\x1b]52;c;${b64}\x07\x1b\\`)).toBe('wrapped');
  });

  it('waits for the terminator', () => {
    const full = osc52('answer');
    expect(extractOsc52Text(full.slice(0, -1))).toBeUndefined();
  });
});

describe('ClaudeBtwCaptureGuard', () => {
  it('does nothing until armed', () => {
    const guard = new ClaudeBtwCaptureGuard();
    expect(guard.inspect(ANSWERING_CHUNK + DONE_CHUNK)).toEqual({ kind: 'pass' });
    expect(guard.isArmed()).toBe(false);
  });

  it('asks to copy only once the finished footer renders', () => {
    const guard = new ClaudeBtwCaptureGuard();
    guard.arm('what is 1+1?');
    expect(guard.inspect(ANSWERING_CHUNK)).toEqual({ kind: 'pass' });
    expect(guard.inspect(DONE_CHUNK)).toEqual({ kind: 'copy' });
  });

  it('detects the footer when it is split across chunks', () => {
    const guard = new ClaudeBtwCaptureGuard();
    guard.arm('q');
    const cut = DONE_CHUNK.indexOf('to copy') + 3;
    expect(guard.inspect(DONE_CHUNK.slice(0, cut))).toEqual({ kind: 'pass' });
    expect(guard.inspect(DONE_CHUNK.slice(cut))).toEqual({ kind: 'copy' });
  });

  it('returns the clipboard answer after the copy request and disarms', () => {
    const guard = new ClaudeBtwCaptureGuard();
    guard.arm('what is 1+1?');
    guard.inspect(DONE_CHUNK);
    guard.markCopyRequested();
    expect(guard.isCopying()).toBe(true);
    const payload = osc52('1 + 1 equals 2.\n\n- **bold** item');
    expect(guard.inspect(payload.slice(0, 10))).toEqual({ kind: 'pass' });
    expect(guard.inspect(payload.slice(10))).toEqual({ kind: 'answer', text: '1 + 1 equals 2.\n\n- **bold** item' });
    expect(guard.isArmed()).toBe(false);
    expect(guard.question).toBe('');
  });

  it('ignores clipboard sequences before the copy request', () => {
    const guard = new ClaudeBtwCaptureGuard();
    guard.arm('q');
    expect(guard.inspect(osc52('stale'))).toEqual({ kind: 'pass' });
    expect(guard.isCopying()).toBe(false);
  });

  it('re-arming forgets a previous overlay footer', () => {
    const guard = new ClaudeBtwCaptureGuard();
    guard.arm('first');
    guard.inspect(DONE_CHUNK.slice(0, DONE_CHUNK.indexOf('Esc')));
    guard.arm('second');
    expect(guard.inspect('Esc to close')).toEqual({ kind: 'pass' });
  });
});

describe('parseClaudeBtwOverlay', () => {
  it('reads the last question and its dedented answer', () => {
    expect(parseClaudeBtwOverlay(DONE_SCREEN)).toEqual({
      state: 'done',
      question: 'list three months, one per line',
      answer: [
        'January: named after Janus.',
        'February: the shortest month.',
        '  - nested detail',
        'March: first month of the old Roman year.',
      ].join('\n'),
    });
  });

  it('reports an in-progress answer without text', () => {
    const screen = [
      '    /btw what is 1+1?',
      '      ✽ Answering…',
      '    Esc to close',
    ].join('\n');
    expect(parseClaudeBtwOverlay(screen)).toEqual({ state: 'answering', question: 'what is 1+1?', answer: '' });
    expect(claudeBtwOverlayVisible(screen)).toBe(true);
  });

  it('returns undefined when no overlay is on screen', () => {
    const screen = [
      '● ok',
      '───────────',
      '❯ /btw typed but not submitted',
      '───────────',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n');
    expect(parseClaudeBtwOverlay(screen)).toBeUndefined();
    expect(claudeBtwOverlayVisible(screen)).toBe(false);
  });
});

describe('/btw relay wiring', () => {
  const worker = readFileSync(resolve(__dirname, '../src/worker.ts'), 'utf8');
  const pool = readFileSync(resolve(__dirname, '../src/core/worker-pool.ts'), 'utf8');

  it('arms the capture from the raw passthrough write, claude-code only', () => {
    const deliver = worker.slice(worker.indexOf('async function deliverRawInput('));
    expect(deliver.slice(0, 6_000)).toContain('if (btwQuestion) armBtwCapture(btwQuestion, msg.turnId);');
    const arm = worker.slice(worker.indexOf('function armBtwCapture('), worker.indexOf('function currentBtwScreen('));
    expect(arm).toContain("lastInitConfig?.cliId !== 'claude-code' || lastInitConfig.adoptMode");
  });

  it('only presses Esc while the overlay is still visible', () => {
    const fn = worker.slice(worker.indexOf('function deliverBtwAnswer('), worker.indexOf('function finishBtwCaptureFromScreen('));
    expect(fn).toMatch(/claudeBtwOverlayVisible\(currentBtwScreen\(\)\)\)\s*\{\s*sendTermActionOnce\(backend, 'esc'\)/);
  });

  it('disarms on CLI respawn', () => {
    expect(worker).toMatch(/disarmEffortConfirm\(\);\n\s*disarmBtwCapture\(\);\n\s*appRunnerControlDecoder\.reset\(\);/);
  });

  it('daemon replies under the /btw turn', () => {
    const region = pool.slice(pool.indexOf("case 'btw_answer':"), pool.indexOf("case 'adopt_preamble':"));
    expect(region).toContain("scopedReply(cardJson, 'interactive', msg.turnId)");
    expect(region).toContain("tr('card.btw_answer'");
  });
});

/**
 * Codex model-migration picker ("Meet <model>: 1. Try new model / 2. Use
 * existing model"). Fixtures below are bytes and screens captured from the
 * real codex-cli 0.162.1 binary (fresh CODEX_HOME with `model = "gpt-5.5"`).
 *
 * See test/worker-codex-model-migration-picker.integration.test.ts for the
 * end-to-end regression through the real worker.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CodexModelMigrationDialogGuard,
  codexModelMigrationSafeKeys,
  isCodexModelMigrationScreen,
} from '../src/utils/codex-model-migration-dialog.js';

// Codex 0.162.1 first paint: skeleton composer under a `loading` banner.
const SKELETON_CHUNK = '\x1b[?2026h\x1b[?2026h\x1b[3;1H\x1b[J\x1b[?25l\x1b[3;1H \x1b[4;1H  \x1b[38;2;99;168;248;49m>_ \x1b[1m\x1b[39;49mOpenAI Codex\x1b[22m\x1b[2m\x1b[2m (v0.162.1)\x1b[5;1H\x1b[22m     \x1b[2mloading\x1b[6;1H\x1b[22m \x1b[7;1H \x1b[8;1H\x1b[1m›\x1b[22m \x1b[2mAsk Codex to do anything\x1b[9;1H\x1b[22m \x1b[10;1H \x1b[39m\x1b[49m\x1b[0m\x1b[8;3H\x1b[?25h\x1b[?2026l';
const DIRECTORY_CHUNK = '\x1b[?2026h\x1b[?25l\x1b[5;6H\x1b[2m/tmp/work\x1b[39m\x1b[49m\x1b[0m\x1b[8;3H\x1b[?25h\x1b[?2026l';
// The picker as streamed: cursor-addressed words, no row layout.
const PICKER_CHUNK = '\x1b[1;2r\x1b[2;1H\r\n\r\n\x1b[r\x1b[8;3H\x1b[3;1H\x1b[J\x1b[?25l\x1b[2;3HMeet\x1b[2;8HGPT-6\x1b[2;14HSol\x1b[4;3HOur\x1b[4;7Hlatest\x1b[4;14HSol\x1b[4;18His\x1b[4;21Hmore\x1b[4;26Hintelligent\x1b[5;3Hcoding.\x1b[7;1H\x1b[7m\x1b[1m› 1. Try new model                                        \x1b[8;3H\x1b[27m\x1b[22m2.\x1b[8;6HUse\x1b[8;10Hexisting\x1b[8;19Hmodel\x1b[10;3H\x1b[1menter/esc\x1b[22m\x1b[2m\x1b[2m confirm · \x1b[22m\x1b[1m^c\x1b[22m\x1b[2m\x1b[2m quit\x1b[39m\x1b[49m\x1b[0m\x1b[?2026l';
// The composer Codex paints after the picker is resolved.
const COMPOSER_CHUNK = '\x1b[1;1H\x1b[J\x1b[?25l\x1b[1;1H \x1b[2;1H  \x1b[38;2;99;168;248;49m>_ \x1b[1m\x1b[39;49mOpenAI Codex\x1b[22m\x1b[2m\x1b[2m (v0.162.1)\x1b[3;1H\x1b[22m     \x1b[2m/tmp/work\x1b[4;1H\x1b[22m \x1b[5;1H \x1b[6;1H\x1b[1m›\x1b[22m \x1b[2mAsk Codex to do anything\x1b[7;1H\x1b[22m \x1b[8;1H \x1b[39m\x1b[49m\x1b[0m\x1b[6;3H\x1b[?25h\x1b[?2026l';

// `tmux capture-pane -p -e` of the rendered picker, before and after Down.
const PICKER_SCREEN = '  Meet GPT-6 Sol\n\n  Our latest Sol is more intelligent and more efficient so your usage limits go further.\n  coding.\n\n\x1b[1;7m› 1. Try new model                                        \n\x1b[0m\x1b[39m\x1b[49m  2. Use existing model\n\n  \x1b[1menter/esc\x1b[0;2m\x1b[39m\x1b[49m confirm · \x1b[0;1m\x1b[39m\x1b[49m^c\x1b[0;2m\x1b[39m\x1b[49m quit\n';
const PICKER_SCREEN_AFTER_DOWN = '  Meet GPT-6 Sol\n\n  Our latest Sol is more intelligent and more efficient so your usage limits go further.\n  coding.\n\n  1. Try new model\n\x1b[1;7m› 2. Use existing model                                   \n\x1b[0m\x1b[39m\x1b[49m\n  \x1b[1menter/esc\x1b[0;2m\x1b[39m\x1b[49m confirm · \x1b[0;1m\x1b[39m\x1b[49m^c\x1b[0;2m\x1b[39m\x1b[49m quit\n';
const COMPOSER_SCREEN = '  >_ OpenAI Codex (v0.162.1)\n     /tmp/work\n\n  permissions: YOLO mode\n\n› Ask Codex to do anything\n\n  GPT-5.5 default · /tmp/work · ← for agents\n';

describe('CodexModelMigrationDialogGuard (stream)', () => {
  it('detects the real cursor-addressed picker chunk', () => {
    expect(new CodexModelMigrationDialogGuard().inspect(PICKER_CHUNK)).toBe(true);
  });

  it('detects the picker when its rows arrive in separate chunks', () => {
    const guard = new CodexModelMigrationDialogGuard();
    const split = PICKER_CHUNK.indexOf('\x1b[8;3H');
    expect(guard.inspect(PICKER_CHUNK.slice(0, split))).toBe(false);
    expect(guard.inspect(PICKER_CHUNK.slice(split))).toBe(true);
  });

  it('ignores the skeleton composer, the resolved composer, the trust dialog and the update picker', () => {
    const guard = new CodexModelMigrationDialogGuard();
    for (const chunk of [
      SKELETON_CHUNK,
      DIRECTORY_CHUNK,
      COMPOSER_CHUNK,
      'Trust this folder?\n› 1. Trust and continue\n  2. Quit',
      '› 1. Update now\n  2. Skip',
    ]) {
      expect(guard.inspect(chunk), JSON.stringify(chunk.slice(0, 40))).toBe(false);
    }
  });

  it('requires the numbered option rows, not just the words', () => {
    const guard = new CodexModelMigrationDialogGuard();
    expect(guard.inspect('You can Try new model now or Use existing model later.')).toBe(false);
  });

  it('forgets menu words once matched and after a respawn reset', () => {
    const guard = new CodexModelMigrationDialogGuard();
    expect(guard.inspect(PICKER_CHUNK)).toBe(true);
    // A later composer redraw must not inherit the matched words.
    expect(guard.inspect(COMPOSER_CHUNK)).toBe(false);
    expect(guard.inspect('1. Try new model')).toBe(false);
    guard.reset();
    expect(guard.inspect('2. Use existing model')).toBe(false);
  });
});

describe('Codex model-migration picker (rendered screen)', () => {
  it('recognises the rendered picker and the resolved composer', () => {
    expect(isCodexModelMigrationScreen(PICKER_SCREEN)).toBe(true);
    expect(isCodexModelMigrationScreen(PICKER_SCREEN_AFTER_DOWN)).toBe(true);
    expect(isCodexModelMigrationScreen(COMPOSER_SCREEN)).toBe(false);
  });

  it('always navigates to "Use existing model" before confirming', () => {
    // Enter on the default row would accept the new model.
    expect(codexModelMigrationSafeKeys(PICKER_SCREEN)).toEqual(['Down', 'Enter']);
    expect(codexModelMigrationSafeKeys(PICKER_SCREEN_AFTER_DOWN)).toEqual(['Enter']);
    expect(codexModelMigrationSafeKeys('› 1. Use existing model\n  2. Try new model')).toEqual(['Enter']);
    expect(codexModelMigrationSafeKeys('  1. Use existing model\n› 2. Try new model')).toEqual(['Up', 'Enter']);
  });

  it('fails closed when the highlighted row is unknown', () => {
    expect(codexModelMigrationSafeKeys('  1. Try new model\n  2. Use existing model')).toBeUndefined();
    expect(codexModelMigrationSafeKeys('› 1. Try new model\n› 2. Use existing model')).toBeUndefined();
    expect(codexModelMigrationSafeKeys(COMPOSER_SCREEN)).toBeUndefined();
  });

  it('does not treat prose or unrelated numbered lists as the picker', () => {
    expect(isCodexModelMigrationScreen('› You can Try new model or Use existing model later.')).toBe(false);
    expect(isCodexModelMigrationScreen('1. Try new model\n\nsome text\n\n2. Use existing model')).toBe(false);
    expect(isCodexModelMigrationScreen('› 1. Update now\n  2. Skip')).toBe(false);
  });
});

describe('worker wiring', () => {
  const workerSource = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');

  function slice(startMarker: string, endMarker: string): string {
    const start = workerSource.indexOf(startMarker);
    const end = workerSource.indexOf(endMarker, start);
    expect(start, startMarker).toBeGreaterThan(-1);
    expect(end, endMarker).toBeGreaterThan(start);
    return workerSource.slice(start, end);
  }

  it('observes the stream before the one-shot trust latch without consuming the chunk', () => {
    const helper = slice('function handleVisibleStartupInteraction(', 'const APP_RUNNER_OSC_CLI_IDS');
    const notice = helper.indexOf('\n  noticeCodexModelMigrationDialog(data);\n');
    expect(notice).toBeGreaterThan(-1);
    expect(notice).toBeLessThan(helper.indexOf('if (trustHandled) return false;'));
    // A coalesced read can carry the picker AND the composer replacing it.
    expect(helper).not.toMatch(/if \(noticeCodexModelMigrationDialog\(/);
  });

  it('never drops ready evidence from the stream alone', () => {
    // A stream match must not strand startup: only the screen gate holds.
    const notice = slice('function noticeCodexModelMigrationDialog(', 'function resolveCodexModelMigrationDialogOnScreen(');
    expect(notice).toContain('): void {');
    expect(notice).not.toMatch(/idleDetector\??\.reset\(/);
  });

  it('holds the first screen-idle while the picker owns the input surface', () => {
    const idle = slice("idleDetector.onIdle(async (evidenceSource) => {\n      log('Prompt detected (idle)');", 'drainBridgesThenMarkReady(evidenceSource);\n    });');
    const gate = idle.indexOf("if (evidenceSource === 'screen' && await codexModelMigrationHoldsFirstPrompt(idleBackend)) return;");
    expect(gate).toBeGreaterThan(-1);
    // Before any path that can mark the prompt ready.
    expect(gate).toBeLessThan(idle.indexOf('markReadyFromEvidence(evidenceSource)'));
    expect(gate).toBeLessThan(idle.indexOf('const busyGuardedIdle'));
    // Drain the async renderer before reading the screen, then decide from it.
    const helper = slice('async function codexModelMigrationHoldsFirstPrompt(', 'function handleVisibleStartupInteraction(');
    expect(helper.indexOf("await renderer.writeAndFlush('')")).toBeGreaterThan(-1);
    expect(helper.indexOf("await renderer.writeAndFlush('')"))
      .toBeLessThan(helper.indexOf('resolveCodexModelMigrationDialogOnScreen()'));
  });

  it('re-checks a pending picker on the startup screen tick and resets state per spawn', () => {
    const screenUpdates = slice('function startScreenUpdates()', 'function stopScreenUpdates()');
    expect(screenUpdates).toContain('if (codexModelMigrationPending) resolveCodexModelMigrationDialogOnScreen();');
    expect(workerSource).toMatch(/codexModelMigrationGuard\.reset\(\);\n\s*codexModelMigrationPending = false;\n\s*codexModelMigrationLastActionAt = 0;\n\s*codexModelMigrationAttempts = 0;\n\s*codexModelMigrationLimitNotified = false;/);
  });
});

describe('resolveCodexModelMigrationDialogOnScreen (extracted from worker.ts)', () => {
  const workerSource = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');

  function extract(name: string): string {
    const start = workerSource.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`${name} not found in worker.ts`);
    const open = workerSource.indexOf('{', workerSource.indexOf(')', start));
    let depth = 0;
    for (let i = open; i < workerSource.length; i++) {
      if (workerSource[i] === '{') depth++;
      else if (workerSource[i] === '}' && --depth === 0) return workerSource.slice(start, i + 1);
    }
    throw new Error(`${name} brace match failed`);
  }

  function load(globals: Record<string, unknown>) {
    const source = [
      'let codexModelMigrationPending = false;',
      'let codexModelMigrationLastActionAt = 0;',
      'let codexModelMigrationAttempts = 0;',
      'let codexModelMigrationLimitNotified = false;',
      workerSource.match(/const CODEX_MODEL_MIGRATION_RETRY_MS = [^;]+;/)![0],
      workerSource.match(/const CODEX_MODEL_MIGRATION_MAX_ATTEMPTS = [^;]+;/)![0],
      extract('codexModelMigrationDialogApplies'),
      extract('resolveCodexModelMigrationDialogOnScreen'),
      'return { resolve: resolveCodexModelMigrationDialogOnScreen, state: () => ({ pending: codexModelMigrationPending, attempts: codexModelMigrationAttempts }) };',
    ].join('\n');
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None },
    });
    const names = Object.keys(globals);
    // eslint-disable-next-line no-new-func
    return new Function(...names, outputText)(...names.map(name => globals[name])) as {
      resolve: () => boolean;
      state: () => { pending: boolean; attempts: number };
    };
  }

  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(10_000); });
  afterEach(() => { vi.useRealTimers(); });

  function harness(screens: string[], cliId = 'codex') {
    const sendSpecialKeys = vi.fn(() => true);
    const send = vi.fn();
    const reset = vi.fn();
    let index = 0;
    const api = load({
      lastInitConfig: { cliId },
      awaitingFirstPrompt: true,
      backend: { sendSpecialKeys },
      backendScreenEvidenceIsAuthoritativeForMutation: () => true,
      captureBackendScreen: () => screens[Math.min(index++, screens.length - 1)],
      idleDetector: { reset },
      isCodexModelMigrationScreen,
      codexModelMigrationSafeKeys,
      log: () => {},
      send,
      t: (key: string) => key,
      cliName: () => 'Codex',
      currentBotmuxTurnId: 'om_test',
    });
    return { api, sendSpecialKeys, send, reset };
  }

  it('selects "Use existing model" and holds the first prompt while the picker is visible', () => {
    const { api, sendSpecialKeys, reset } = harness([PICKER_SCREEN]);
    expect(api.resolve()).toBe(true);
    expect(reset).toHaveBeenCalled();
    expect(sendSpecialKeys).toHaveBeenCalledWith('Down', 'Enter');
    expect(api.state()).toEqual({ pending: true, attempts: 1 });
  });

  it('releases once the composer is back', () => {
    const { api, sendSpecialKeys } = harness([PICKER_SCREEN, COMPOSER_SCREEN]);
    expect(api.resolve()).toBe(true);
    expect(api.resolve()).toBe(false);
    expect(sendSpecialKeys).toHaveBeenCalledTimes(1);
    expect(api.state().pending).toBe(false);
  });

  it('throttles retries, stops after three attempts and notifies once', () => {
    const { api, sendSpecialKeys, send } = harness([PICKER_SCREEN]);
    expect(api.resolve()).toBe(true);
    expect(api.resolve()).toBe(true);
    expect(sendSpecialKeys, 'retry within the throttle window').toHaveBeenCalledTimes(1);
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(1_000);
      expect(api.resolve()).toBe(true);
    }
    expect(sendSpecialKeys).toHaveBeenCalledTimes(3);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toMatchObject({ type: 'user_notify', message: 'worker.codex_model_migration_unresolved' });
  });

  it('spends the budget on an unreadable selection and then notifies instead of guessing', () => {
    const unreadable = PICKER_SCREEN.replace('› 1. Try new model', '  1. Try new model');
    expect(isCodexModelMigrationScreen(unreadable)).toBe(true);
    const { api, sendSpecialKeys, send } = harness([unreadable]);
    for (let i = 0; i < 4; i++) {
      expect(api.resolve()).toBe(true);
      vi.advanceTimersByTime(1_000);
    }
    expect(sendSpecialKeys).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('reads tmux captures whose rows end with CRLF', () => {
    const crlf = PICKER_SCREEN.replace(/\n/g, '\r\n');
    const { api, sendSpecialKeys } = harness([crlf]);
    expect(api.resolve()).toBe(true);
    expect(sendSpecialKeys).toHaveBeenCalledWith('Down', 'Enter');
  });

  it('is inert for other CLIs', () => {
    const { api, sendSpecialKeys, reset } = harness([PICKER_SCREEN], 'claude-code');
    expect(api.resolve()).toBe(false);
    expect(sendSpecialKeys).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
  });
});

/**
 * Regression: Codex's one-time model-migration picker must not swallow the
 * first Lark message.
 *
 * Codex 0.162 paints a skeleton composer (`› Ask Codex to do anything`)
 * before initialization, then — once per CODEX_HOME whenever the configured
 * model has an unacknowledged upgrade — replaces it with a modal picker:
 *
 *   Meet GPT-6 Sol
 *   › 1. Try new model
 *     2. Use existing model
 *   enter/esc confirm · ^c quit
 *
 * The idle detector latched ready evidence from the skeleton composer, so two
 * quiet seconds on the picker declared the first prompt ready. The first
 * message was then pasted into the picker (discarded) and its submit Enter
 * confirmed the default row, silently switching the user's global model to
 * the new one; the message never reached the model and the queue blocked on
 * `submit_unconfirmed`. (CI: every first Codex session of a run, because
 * scripts/run-e2e.ts pins `model = "gpt-5.5"`.)
 *
 * The fake CLI below reproduces the real 0.162.1 key semantics measured with
 * the actual binary: Enter/Esc confirm the highlighted row, Down/Up move, a
 * digit picks its row directly, and a bracketed paste while the picker is
 * active is dropped.
 */
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { expect, it } from 'vitest';
import { spawnNodeTsScript } from './helpers/ts-runner.js';
import { probeTmuxFunctional } from '../src/setup/ensure-tmux.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';

const tmuxAvailable = probeTmuxFunctional().ok;

// `stream`: the picker bytes are recognisable in the PTY stream (real Codex).
// `screen-only`: labels and row numbers are painted separately, so only the
// rendered screen shows the picker — exercises the first-idle screen gate.
for (const backendType of ['pty', 'tmux'] as const) {
  for (const paint of ['stream', 'screen-only'] as const) {
    it.skipIf(backendType === 'tmux' && !tmuxAvailable)(
      `keeps the configured model and submits the first message once after the migration picker (${backendType}, ${paint})`,
      () => runMigrationPickerScenario(backendType, paint),
      60_000,
    );
  }
}

async function runMigrationPickerScenario(backendType: 'tmux' | 'pty', paint: 'stream' | 'screen-only'): Promise<void> {
  const sessionId = randomUUID();
  const botmuxDir = join(homedir(), '.botmux');
  mkdirSync(botmuxDir, { recursive: true, mode: 0o700 });
  chmodSync(botmuxDir, 0o700);
  const root = mkdtempSync(join(backendType === 'tmux' ? '/tmp' : tmpdir(), 'bmx-migration-'));
  const dataDir = join(root, 'data');
  mkdirSync(dataDir);
  const eventsFile = join(root, 'events');
  const cliPidFile = join(root, 'cli-pid');
  const fakeCli = join(root, 'fake-codex');
  writeFileSync(eventsFile, '');
  writeFileSync(fakeCli, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const codexDir = path.join(require('node:os').homedir(), '.codex');
fs.mkdirSync(path.join(codexDir, 'sessions'), {recursive:true});
const sid = '11111111-2222-4333-8444-666666666666';
fs.openSync(path.join(codexDir, 'sessions', 'rollout-2026-10-15T00-00-00-' + sid + '.jsonl'), 'a');
fs.writeFileSync(${JSON.stringify(cliPidFile)}, String(process.pid));
const event = (line) => fs.appendFileSync(${JSON.stringify(eventsFile)}, line + '\\n');
let state = 'skeleton';
let selected = 1;
let composerInput = '';
const skeleton = '\\x1b[?2004h\\x1b[2J\\x1b[H  >_ OpenAI Codex (v0.162.1)\\r\\n     loading\\r\\n\\r\\n\\x1b[1m›\\x1b[22m \\x1b[2mAsk Codex to do anything\\x1b[22m';
const row = (n, label) => (selected === n ? '\\x1b[7m\\x1b[1m› ' : '\\x1b[27m\\x1b[22m  ') + n + '. ' + label + '\\x1b[0m';
// Cursor-addressed like the real TUI: words of the non-selected row are
// placed individually, so the stream never carries the row layout.
const options = ${JSON.stringify(paint)} === 'stream'
  ? () => '\\x1b[7;1H' + row(1, 'Try new model') + '\\x1b[8;1H' + row(2, 'Use existing model')
  : () => '\\x1b[7;6HTry new model\\x1b[8;6HUse existing model'
    + '\\x1b[7;1H' + (selected === 1 ? '› ' : '  ') + '1.\\x1b[8;1H' + (selected === 2 ? '› ' : '  ') + '2.';
const picker = () => '\\x1b[2J\\x1b[2;3HMeet\\x1b[2;8HGPT-6\\x1b[2;14HSol'
  + '\\x1b[4;3HOur\\x1b[4;7Hlatest\\x1b[4;14HSol\\x1b[4;18His\\x1b[4;21Hbetter.'
  + options()
  + '\\x1b[10;3H\\x1b[1menter/esc\\x1b[22m\\x1b[2m confirm · ^c quit\\x1b[0m';
const composer = '\\x1b[2J\\x1b[H  >_ OpenAI Codex (v0.162.1)\\r\\n     /tmp/work\\r\\n\\r\\n› Ask Codex to do anything\\r\\n\\r\\n  gpt-5.5 default · /tmp/work';
// Output produced by one input event is written at once, so a Down+Enter
// delivered together yields ONE read holding the picker repaint and the
// composer that replaced it (the coalesced shape seen under load).
let pending = '';
const choose = (n) => {
  event('choice:' + (n === 1 ? 'try-new-model' : 'use-existing-model'));
  state = 'composer';
  pending += composer;
};
process.stdin.setRawMode(true);
process.stdin.on('data', (buffer) => {
  let data = buffer.toString();
  if (state !== 'picker') {
    if (state === 'composer') {
      composerInput += data;
      const match = composerInput.match(/\\x1b\\[200~([\\s\\S]*?)\\x1b\\[201~[^\\r]*\\r/);
      if (match) {
        composerInput = composerInput.slice(composerInput.indexOf(match[0]) + match[0].length);
        event('submitted:' + match[1]);
        fs.appendFileSync(path.join(codexDir, 'history.jsonl'), JSON.stringify({session_id:sid, text:match[1], ts:Date.now()/1000})+'\\n');
      }
    }
    return;
  }
  const paste = data.match(/\\x1b\\[200~([\\s\\S]*?)\\x1b\\[201~/);
  if (paste) {
    event('paste-into-picker:' + paste[1]);
    data = data.replace(paste[0], '');
  }
  for (let i = 0; i < data.length && state === 'picker';) {
    const seq = data.slice(i, i + 3);
    if (seq === '\\x1b[B' || seq === '\\x1bOB') { selected = 2; pending += picker(); i += 3; continue; }
    if (seq === '\\x1b[A' || seq === '\\x1bOA') { selected = 1; pending += picker(); i += 3; continue; }
    const ch = data[i++];
    if (ch === '1' || ch === '2') choose(Number(ch));
    else if (ch === '\\r' || ch === '\\n' || ch === '\\x1b') choose(selected);
  }
  if (pending) { process.stdout.write(pending); pending = ''; }
});
process.stdout.write(skeleton);
// Redraw after tmux subscribes to pipe-pane so the worker observes the
// skeleton composer, then present the picker the way Codex 0.162 does.
for (const delay of [200, 400, 700]) setTimeout(() => process.stdout.write(skeleton), delay);
setTimeout(() => { state = 'picker'; process.stdout.write('\\x1b[2;6H/tmp/work' + picker()); }, 1000);
setInterval(() => {}, 1000);
`);
  chmodSync(fakeCli, 0o755);
  const messages: WorkerToDaemon[] = [];
  const logs: string[] = [];
  let child: ChildProcess | undefined;
  const events = () => readFileSync(eventsFile, 'utf8').split('\n').filter(Boolean);
  const waitFor = async (condition: () => boolean, timeoutMs = 20_000) => {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
      if (Date.now() >= deadline || child?.exitCode != null) {
        throw new Error(`events=${JSON.stringify(events())}\n${logs.join('')}`);
      }
      await new Promise(r => setTimeout(r, 25));
    }
  };
  try {
    const spawnOptions: SpawnOptions = {
      cwd: resolve('.'),
      env: { ...process.env, TMUX_TMPDIR: root, SESSION_DATA_DIR: dataDir, BOTMUX_SESSION_ID: sessionId, LARK_APP_ID: 'app_test', LARK_APP_SECRET: 'secret' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    };
    child = spawnNodeTsScript(resolve('src/worker.ts'), [], spawnOptions);
    child.on('message', m => messages.push(m as WorkerToDaemon));
    child.stdout?.on('data', b => logs.push(b.toString()));
    child.stderr?.on('data', b => logs.push(b.toString()));
    child.send({
      type: 'init', sessionId, chatId: 'oc_test', rootMessageId: 'om_root',
      workingDir: dataDir, cliId: 'codex', cliPathOverride: fakeCli,
      backendType,
      prompt: 'first-message-after-migration-picker', turnId: 'om_test', larkAppId: 'app_test', larkAppSecret: 'secret',
    } satisfies DaemonToWorker);

    await waitFor(() => events().some(line => line.startsWith('choice:')));
    await waitFor(() => messages.some(m => m.type === 'turn_input_committed' && m.turnId === 'om_test'));

    const seen = events();
    const detail = `events=${JSON.stringify(seen)}\n${logs.join('')}`;
    expect(seen.filter(line => line.startsWith('paste-into-picker:')), detail).toEqual([]);
    // Keep the user's configured model: never confirm "Try new model".
    expect(seen.filter(line => line.startsWith('choice:')), detail).toEqual(['choice:use-existing-model']);
    const submitted = seen.filter(line => line.startsWith('submitted:'));
    expect(submitted, detail).toHaveLength(1);
    expect(submitted[0]!.match(/first-message-after-migration-picker/g), detail).toHaveLength(1);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(r => child!.once('exit', () => r()));
      child.kill('SIGKILL');
      await Promise.race([exited, new Promise(r => setTimeout(r, 2_000))]);
    }
    if (existsSync(cliPidFile)) {
      try { process.kill(Number(readFileSync(cliPidFile, 'utf8')), 'SIGKILL'); } catch { /* exited */ }
    }
    if (backendType === 'tmux') {
      try { execFileSync('tmux', ['kill-server'], { env: { ...process.env, TMUX_TMPDIR: root }, stdio: 'ignore' }); } catch { /* exited */ }
    }
    rmSync(root, { recursive: true, force: true });
  }
}

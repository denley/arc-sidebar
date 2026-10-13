// Minimal Chrome DevTools Protocol harness for driving a throwaway headless
// Chromium with the extension loaded. Used by tools/test.mjs and
// tools/screenshot.mjs; not part of the extension itself.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch({ extDir, port = 9333, headless = true, args = [] } = {}) {
  const userDataDir = mkdtempSync(join(tmpdir(), 'arc-sidebar-test-'));
  // The real binary, not the /usr/bin/chromium wrapper, so the user's
  // chromium-flags.conf (extra --load-extension etc.) stays out of tests.
  const proc = spawn(process.env.CHROMIUM_BIN || '/usr/lib/chromium/chromium', [
    ...(headless ? ['--headless=new'] : []),
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    `--load-extension=${resolve(extDir)}`,
    `--disable-extensions-except=${resolve(extDir)}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    '--window-size=1280,900',
    ...args,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d; });

  let version;
  for (let i = 0; i < 100; i++) {
    try {
      version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      break;
    } catch { await sleep(100); }
  }
  if (!version) throw new Error(`chromium did not start:\n${stderr}`);

  const browser = await connect(version.webSocketDebuggerUrl);
  const close = async () => {
    try { await browser.send('Browser.close'); } catch {}
    proc.kill();
    await sleep(300);
    rmSync(userDataDir, { recursive: true, force: true });
  };
  return { browser, close, port, stderr: () => stderr };
}

export async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let nextId = 1;
  const pending = new Map();
  const listeners = new Set();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? rej(new Error(`${msg.error.message} ${msg.error.data || ''}`)) : res(msg.result);
    } else {
      for (const l of listeners) l(msg);
    }
  };
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const id = nextId++;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
  return { send, on: (fn) => listeners.add(fn), ws };
}

// Attach to a target and return an evaluator bound to its session.
export async function attach(browser, targetId) {
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  const evaluate = async (expression) => {
    const r = await browser.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    }, sessionId);
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    return r.result.value;
  };
  return { sessionId, evaluate, send: (m, p) => browser.send(m, p, sessionId) };
}

export async function waitForTarget(browser, pred, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const { targetInfos } = await browser.send('Target.getTargets');
    const t = targetInfos.find(pred);
    if (t) return t;
    await sleep(100);
  }
  throw new Error('target not found');
}

export { sleep };

// Tiny Chrome DevTools Protocol driver shared by the browser tests (no external dependencies).
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Use $CHROME if set, otherwise the first Chrome/Edge found on this machine.
const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
];
export const CHROME = process.env.CHROME || CHROME_CANDIDATES.find(p => existsSync(p)) || CHROME_CANDIDATES[0];
export const APP_URL = process.env.APP_URL || 'http://localhost:8917/';
export const sleep = ms => new Promise(r => setTimeout(r, ms));

// MediaPipe's WASM prints routine info lines ("INFO: Created TensorFlow Lite XNNPACK delegate") via console.error.
const isMediaPipeInfo = a => /^(INFO|I\d{4}|W\d{4})/.test(String(a?.value ?? ''));

export async function launch({ port = 9333, extraArgs = [] } = {}) {
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'eyetest-'))}`,
    '--autoplay-policy=no-user-gesture-required', ...extraArgs, 'about:blank',
  ], { stdio: 'ignore' });

  let ws;
  for (let i = 0; i < 50 && !ws; i++) {
    try {
      const page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === 'page');
      if (page) ws = new WebSocket(page.webSocketDebuggerUrl);
    } catch { /* not up yet */ }
    if (!ws) await sleep(200);
  }
  if (!ws) throw new Error('Chrome did not start');
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let msgId = 0;
  const pending = new Map(), problems = [];
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') problems.push(`exception: ${m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text}`);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error' && !isMediaPipeInfo(m.params.args[0])) {
      problems.push(`console.error: ${m.params.args.map(a => a.value ?? a.description).join(' ')}`);
    }
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') problems.push(`log: ${m.params.entry.text} ${m.params.entry.url || ''}`);
  };
  const send = (method, params = {}) => new Promise(res => { const id = ++msgId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  await send('Runtime.enable'); await send('Log.enable');

  const evaluate = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(`page eval failed: ${r.result.exceptionDetails.exception?.description}`);
    return r.result?.result?.value;
  };
  const text = id => evaluate(`document.getElementById(${JSON.stringify(id)}).textContent`);
  const waitFor = async (expr, ms, label) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (await evaluate(expr)) return true; await sleep(200); }
    throw new Error(`timeout waiting for: ${label}`);
  };
  const close = () => { ws.close(); chrome.kill(); };
  return { send, evaluate, text, waitFor, problems, close };
}

export function reporter() {
  const results = [];
  const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); };
  const finish = () => {
    const failed = results.filter(r => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} checks passed`);
    return failed ? 1 : 0;
  };
  return { check, finish };
}

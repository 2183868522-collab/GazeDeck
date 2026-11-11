// DOM/audio doubles exercise module wiring without a browser, camera or user data.
// They do not verify pixel layout or physical gesture recognition.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mountGazeDeck } from '../src/gazedeck-ui.js';
import { DECK_GESTURES } from '../src/gazedeck-flow.js';
import { buildGazeCalibration } from '../src/gaze-slider.js';
import { FEATURE_NAMES } from '../src/features.js';
import { REST_LABEL, UNKNOWN_LABEL } from '../src/classifier.js';

function harness(t, calibrated = false, lifecycle = {}) {
  const oldAudio = globalThis.Audio, oldInterval = globalThis.setInterval;
  const intervals = [], nodes = new Map(), events = [];
  class Node {
    constructor() {
      this.innerHTML = ''; this.textContent = ''; this.value = ''; this.style = {}; this.dataset = {};
      const classes = new Set();
      this.classList = { toggle: (name, value) => value ? classes.add(name) : classes.delete(name), contains: name => classes.has(name) };
    }
    querySelector(selector) { if (!nodes.has(selector)) nodes.set(selector, new Node()); return nodes.get(selector); }
    querySelectorAll() { return []; }
    replaceChildren() { this.innerHTML = ''; }
    addEventListener() {}
    focus() {}
  }
  const audios = [];
  globalThis.Audio = class {
    constructor() { this.dataset = {}; this.paused = true; this.readyState = 0; this._currentTime = 0; this.seekWrites = []; audios.push(this); }
    get currentTime() { return this._currentTime; }
    set currentTime(value) { this._currentTime = value; this.seekWrites.push(value); }
    pause() { this.paused = true; }
    play() { this.paused = false; return Promise.resolve(); }
    removeAttribute() {}
    load() {}
  };
  globalThis.setInterval = callback => { intervals.push(callback); return intervals.length; };
  t.after(() => { globalThis.Audio = oldAudio; globalThis.setInterval = oldInterval; });
  const root = new Node();
  const env = {
    user: 'test-only', gestures: [...DECK_GESTURES], labels: [...DECK_GESTURES], camera: true, baseline: true,
    engineSettings: { refractoryMs: 700, minMargin: .2 },
    sliderSettings: { enabled: true, dwellMs: 100, smoothingMs: 0, deadZone: .2 },
    calibration: calibrated ? buildGazeCalibration({ left: [-.2], center: [0], right: [.2] }) : null,
  };
  const ui = mountGazeDeck(root, { environment: () => env, onLog: (...args) => events.push(args), ...lifecycle });
  root.querySelector('#deckBlueFeedback').checked = true;
  const manual = command => root.onclick({ target: { closest: () => ({ disabled: false, dataset: { deckCommand: command }, hasAttribute: () => false }) } });
  const complete = () => root.onclick({ target: { closest: () => ({ disabled: false, dataset: { deckComplete: 'demo' }, hasAttribute: key => key === 'data-deck-complete' }) } });
  const q = id => root.querySelector(`#${id}`);
  const predict = (label, t, margin = 1) => ui.prediction({ label, margin }, t);
  return { root, ui, q, env, events, intervals, audios, manual, complete, predict };
}

test('UI binds recognizer to active tab only, distinguishes manual and live, and gates low confidence/cooldown', t => {
  const h = harness(t);
  h.predict('右看', 0); assert.equal(h.events.length, 0);
  h.ui.setActive(true); h.predict('右看', 1000, .1);
  assert.match(h.q('deckLastAction').textContent, /置信度不足/);
  h.predict('右看', 1100); assert.match(h.q('deckScreen').innerHTML, /2 · 设备连接与校准/);
  h.predict('左看', 1200); assert.match(h.q('deckLastAction').textContent, /冷却中/);
  h.complete(); h.predict('上看', 2000); assert.match(h.q('deckScreen').innerHTML, /4 · 音轨管理/);
  h.predict('下看', 3000); assert.ok(h.ui.isAdjusting());
  h.root.oninput({ target: { id: 'deckRange', value: '85' } });
  h.predict('下看', 4000); assert.equal(h.ui.isAdjusting(), false);
  assert.match(h.q('deckScreen').innerHTML, /当前选中：演示曲目 5/);
  h.predict('双眨', 5000); assert.match(h.q('deckScreen').innerHTML, /当前选中：演示曲目 1/);
  h.manual('长眨'); assert.match(h.q('deckLastAction').textContent, /手动模拟/);
  h.ui.setActive(false); const count = h.events.length;
  h.predict('上看', 7000); assert.equal(h.events.length, count);
  assert.ok(h.audios.every(audio => audio.paused));
});

test('continuous raw eye frames move popup but classifier does not double-step left/right, observation freezes it', t => {
  const h = harness(t, true); h.ui.setActive(true); h.manual('右看'); h.complete();
  h.manual('左看'); h.manual('右看'); assert.ok(h.ui.isAdjusting());
  const raw = Array(FEATURE_NAMES.length).fill(0);
  raw[FEATURE_NAMES.indexOf('irisXA')] = .2; raw[FEATURE_NAMES.indexOf('irisXB')] = .2;
  const now = performance.now();
  for (let dt = 0; dt <= 500; dt += 100) h.ui.frame(raw, now + dt);
  const moved = Number(h.q('deckRange').value); assert.ok(moved > 70);
  h.predict('右看', now + 1000); assert.equal(Number(h.q('deckRange').value), moved);
  h.manual('长眨');
  h.root.oninput({ target: { id: 'deckRange', value: '0' } });
  h.ui.frame(raw, now + 1500); assert.equal(Number(h.q('deckRange').value), moved);
  h.manual('上看'); assert.ok(h.ui.isAdjusting());
  h.manual('长眨'); h.manual('双眨'); assert.equal(h.ui.isAdjusting(), false);
  assert.match(h.q('deckScreen').innerHTML, /音量 <b>70%/);
});

test('closest rejected action is opt-in, logged, reversible live and never rewrites classifier output', t => {
  const h = harness(t); h.ui.setActive(true);
  const rejected = Object.freeze({ label: UNKNOWN_LABEL, guess: '右看', margin: 1, distance: 9 });
  h.ui.prediction(rejected, 1000);
  assert.match(h.q('deckScreen').innerHTML, /1 · 启动界面/);
  assert.match(h.q('deckLastAction').textContent, /未知（最像「右看」）.*拒识/);
  h.env.useClosestGuess = true;
  h.ui.prediction(rejected, 2000);
  assert.match(h.q('deckScreen').innerHTML, /2 · 设备连接与校准/);
  assert.match(h.q('deckLastAction').textContent, /未知（最像「右看」），按最像动作处理/);
  assert.equal(h.q('deckSuccessGlow').dataset.direction, 'right');
  assert.equal(rejected.label, UNKNOWN_LABEL);
  h.complete(); h.env.useClosestGuess = false;
  h.ui.prediction({ label: UNKNOWN_LABEL, guess: '上看', margin: 1 }, 3000);
  assert.match(h.q('deckScreen').innerHTML, /3 · 主界面/);
  h.env.useClosestGuess = 'true';
  h.ui.prediction({ label: UNKNOWN_LABEL, guess: '上看', margin: 1 }, 4000);
  assert.match(h.q('deckScreen').innerHTML, /3 · 主界面/);
});

test('closest-action fallback retains confidence, cooldown, binding and natural rejection', async t => {
  const h = harness(t); h.ui.setActive(true); h.env.useClosestGuess = true;
  const guess = (label, time, margin = 1) => h.ui.prediction({ label: UNKNOWN_LABEL, guess: label, margin }, time);
  guess('右看', 1000, .1); assert.match(h.q('deckLastAction').textContent, /置信度不足/);
  guess(REST_LABEL, 1100); assert.match(h.q('deckScreen').innerHTML, /1 · 启动界面/);
  guess(undefined, 1200); assert.match(h.q('deckLastAction').textContent, /拒识/);
  guess(UNKNOWN_LABEL, 1300); assert.match(h.q('deckLastAction').textContent, /拒识/);
  guess('未绑定动作', 1400); assert.match(h.q('deckLastAction').textContent, /未映射/);
  guess('右看', 1500); assert.match(h.q('deckScreen').innerHTML, /2 · 设备连接与校准/);
  guess('左看', 1600); assert.match(h.q('deckLastAction').textContent, /冷却中/);
  h.complete();
  h.env.gestures = h.env.gestures.map(g => g === '上看' ? '抬眼' : g);
  h.env.labels = [...h.env.gestures];
  await h.root.onchange({ target: { dataset: { deckBinding: '上看' }, value: '抬眼' } });
  guess('抬眼', 3000); assert.match(h.q('deckScreen').innerHTML, /4 · 音轨管理/);
  h.ui.setActive(false); const count = h.events.length;
  guess('下看', 4000); assert.equal(h.events.length, count);
});

test('closest actions preserve continuous-slider deduplication and observation controls', t => {
  const h = harness(t, true); h.ui.setActive(true); h.env.useClosestGuess = true;
  h.manual('右看'); h.complete(); h.manual('左看'); h.manual('右看');
  const guess = (label, time) => h.ui.prediction({ label: UNKNOWN_LABEL, guess: label, margin: 1 }, time);
  const opening = Number(h.q('deckRange').value);
  guess('右看', 1000);
  assert.equal(Number(h.q('deckRange').value), opening, 'classified gaze must not add a second slider step');
  assert.match(h.q('deckLastAction').textContent, /按最像动作处理.*不重复步进/);
  guess('长眨', 2000); assert.match(h.q('deckLastAction').textContent, /观察/);
  guess('下看', 3000); assert.ok(h.ui.isAdjusting());
  assert.match(h.q('deckLastAction').textContent, /观察模式中/);
  guess('长眨', 4000); guess('下看', 5000);
  assert.equal(h.ui.isAdjusting(), false);
});

test('renamed gesture binding can be reassigned and switching user clears the session', async t => {
  const h = harness(t); h.ui.setActive(true); h.manual('右看'); h.complete();
  h.env.gestures = h.env.gestures.map(g => g === '上看' ? '抬眼' : g);
  h.env.labels = [...h.env.gestures];
  await h.root.onchange({ target: { dataset: { deckBinding: '上看' }, value: '抬眼' } });
  h.predict('抬眼', 1000); assert.match(h.q('deckScreen').innerHTML, /4 · 音轨管理/);
  h.ui.resetForUser(); assert.match(h.q('deckScreen').innerHTML, /1 · 启动界面/);
  assert.match(h.q('deckLastAction').textContent, /用户已切换/);
  assert.equal(h.q('deckEvents').innerHTML, '');
});

test('typed commands execute the same flow, label their source, reject unknown text and work inside a popup', t => {
  const h = harness(t); h.ui.setActive(true);
  const type = text => {
    h.q('deckCommandInput').value = text;
    h.root.onsubmit({ target: { id: 'deckCommandForm' }, preventDefault() {} });
  };
  type('RIGHT'); assert.match(h.q('deckScreen').innerHTML, /2 · 设备连接与校准/);
  assert.match(h.q('deckLastAction').textContent, /手动输入/);
  type('constructor'); assert.match(h.q('deckLastAction').textContent, /无效指令/);
  assert.equal(h.q('deckCommandInput').ariaInvalid, 'true');
  h.complete(); type('左看'); type('右看'); assert.ok(h.ui.isAdjusting());
  type('左看'); type('上看'); assert.ok(h.ui.isAdjusting());
  assert.equal(Number(h.q('deckRange').value), 70);
  type('左看'); type('下看'); assert.equal(h.ui.isAdjusting(), false);
  assert.match(h.q('deckScreen').innerHTML, /音量 <b>65%/);
  type('长眨'); type('上看'); assert.match(h.q('deckLastAction').textContent, /观察模式中/);
  type('observe'); type('up'); assert.match(h.q('deckScreen').innerHTML, /3 · 主界面/);
});

test('edge feedback only marks accepted real-eye operations, respects disable and clears on exit', t => {
  const h = harness(t); h.ui.setActive(true);
  const glow = h.q('deckSuccessGlow');
  h.manual('左看'); assert.equal(glow.classList.contains('is-pulsing'), false);
  h.predict('上看', 1000, .1); assert.equal(glow.classList.contains('is-pulsing'), false);
  h.predict('上看', 2000); assert.ok(glow.classList.contains('is-pulsing'));
  assert.equal(glow.dataset.direction, 'up');
  assert.equal(glow.dataset.tone, 'blue');
  h.ui.setActive(false); assert.equal(glow.classList.contains('is-pulsing'), false);
  h.ui.setActive(true); h.q('deckBlueFeedback').checked = false;
  h.predict('右看', 3000); assert.equal(glow.classList.contains('is-pulsing'), false);
});

test('four gaze directions route to a single blue edge while long/double blinks route to all orange edges', t => {
  const h = harness(t); h.ui.setActive(true); h.manual('右看'); h.complete();
  const glow = h.q('deckSuccessGlow'); let timestamp = 1000;
  for (const [gesture, edge] of [['上看', 'up'], ['下看', 'down'], ['左看', 'left'], ['右看', 'right']]) {
    h.ui.setActive(true); h.predict(gesture, timestamp); timestamp += 1000;
    assert.equal(glow.dataset.direction, edge); assert.equal(glow.dataset.tone, 'blue');
    assert.ok(glow.classList.contains('is-pulsing'));
    h.manual('上看'); // Return to home without generating eye feedback.
  }
  for (const gesture of ['双眨', '长眨']) {
    h.ui.setActive(true); h.predict(gesture, timestamp); timestamp += 1000;
    assert.equal(glow.dataset.direction, 'all'); assert.equal(glow.dataset.tone, 'orange');
    assert.ok(glow.classList.contains('is-pulsing'));
  }
});

test('workspace activation and return control delegate to the app without stopping its camera source', t => {
  const active = []; let exited = false;
  const h = harness(t, false, { onActive: value => active.push(value), onExit: () => { exited = true; } });
  h.ui.setActive(true);
  h.root.onclick({ target: { closest: () => ({ disabled: false, dataset: {}, hasAttribute: attribute => attribute === 'data-deck-exit' }) } });
  assert.equal(exited, true);
  h.ui.setActive(false); assert.deepEqual(active, [true, false]);
  assert.equal(h.env.camera, true);
});

test('audio bindings never write currentTime for navigation/volume undo, only for explicit seeks', async t => {
  const h = harness(t); h.ui.setActive(true); h.manual('右看'); h.complete();
  const file = Object.assign(new Blob(['test-audio']), { name: 'local-test.wav' });
  await h.root.onchange({ target: { id: 'deckFiles', files: [file], dataset: {}, hasAttribute: () => false } });
  const [a, b] = h.audios;
  a.readyState = b.readyState = 1; a.duration = b.duration = 240;
  a.currentTime = 30; b.currentTime = 10; a.seekWrites = []; b.seekWrites = [];
  h.manual('左看'); a.currentTime = 45; b.currentTime = 25;
  h.manual('右看'); h.root.oninput({ target: { id: 'deckRange', value: '20' } });
  a.seekWrites = []; b.seekWrites = [];
  h.manual('下看'); assert.equal(a.volume, .2);
  a.currentTime = 60; b.currentTime = 40; a.seekWrites = []; b.seekWrites = [];
  h.manual('双眨'); assert.equal(a.volume, .7);
  h.manual('上看'); h.manual('双眨');
  assert.equal(a.currentTime, 60); assert.equal(b.currentTime, 40);
  assert.deepEqual(a.seekWrites, []); assert.deepEqual(b.seekWrites, []);
  h.manual('上看'); h.manual('下看'); h.manual('右看');
  h.root.oninput({ target: { id: 'deckRange', value: '100' } }); h.manual('下看');
  assert.equal(a.currentTime, 100); assert.deepEqual(b.seekWrites, []);
  a.currentTime = 107; a.seekWrites = [];
  h.manual('双眨'); assert.equal(a.currentTime, 67); assert.deepEqual(a.seekWrites, [67]);
  h.manual('左看'); assert.equal(a.paused, false);
  h.ui.setActive(false); assert.equal(a.paused, false, 'navigation away does not pause audio');
  a.currentTime = 75; a.seekWrites = []; h.ui.setActive(true);
  assert.equal(a.currentTime, 75); assert.deepEqual(a.seekWrites, []);
  URL.revokeObjectURL(a.dataset.trackUrl);
});

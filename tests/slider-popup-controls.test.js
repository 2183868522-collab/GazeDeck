// Execute the original slider's actual handlers against DOM/audio-free doubles.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { SLIDER_GESTURES } from '../src/gaze-slider.js';

const app = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
function sourceFunction(name) {
  const start = app.indexOf(`function ${name}(`);
  const end = app.indexOf('\nfunction ', start + 1);
  assert.ok(start >= 0 && end > start);
  return app.slice(start, end);
}
function setup(id = 'volume') {
  const elements = new Map(), commits = [], rendered = [], changes = [];
  const controller = { value: 20, pause() {} };
  const session = { controller, initialValue: 70, lastCommandT: -Infinity, target: {
    id, label: id, unit: '%', persist: false,
    set: value => changes.push(value), commit: value => commits.push(value),
  } };
  const context = vm.createContext({
    gazeSliderSession: session, SLIDER_GESTURES,
    profile: { gazeSlider: { settings: { timeoutMs: 20000, confirmGesture: '长眨', cancelGesture: '上看' } } },
    engine: { settings: { minMargin: .2, refractoryMs: 700 } },
    classifier: { labels: () => ['上看', '下看'], predict: seg => seg },
    segmenter: { reset() {} }, mode: 'gaze-slider',
    performance: { now: () => 1000 }, setTimeout: () => 1, clearTimeout() {},
    renderGazeSlider: snapshot => rendered.push(snapshot), renderMusic() {},
    log() {}, persist() {}, setCaptureWorkspace() {}, setStatus() {},
    document: { body: { classList: { remove() {} } } },
    tracks: [{ name: 'test-track' }], selectedTrackIndex: 0,
    REST_LABEL: '自然', UNKNOWN_LABEL: '未知',
    $: id => { if (!elements.has(id)) elements.set(id, { textContent: '', classList: { add() {}, remove() {} } }); return elements.get(id); },
  });
  vm.runInContext(['armGazeSliderTimeout', 'restoreGazeSlider', 'handleGazeSliderSegment', 'finishGazeSlider'].map(sourceFunction).join('\n'), context);
  return { context, session, controller, commits, changes, rendered };
}

test('legacy volume/BPM/effect/track popups restore on up without closing, keep and close on down', () => {
  for (const id of ['volume', 'bpm', 'effect', 'track']) {
    const h = setup(id);
    h.context.handleGazeSliderSegment({ frames: { label: '上看', margin: 1 } }, 1000);
    assert.equal(h.controller.value, 70, id); assert.equal(h.changes.at(-1), 70, id);
    assert.equal(h.context.gazeSliderSession, h.session, id); assert.equal(h.context.mode, 'gaze-slider', id);
    assert.deepEqual(h.commits, [], id);
    h.controller.value = 40;
    h.context.handleGazeSliderSegment({ frames: { label: '下看', margin: 1 } }, 2000);
    assert.equal(h.context.gazeSliderSession, null, id); assert.equal(h.context.mode, 'idle', id);
    assert.deepEqual(h.commits, [40], id);
  }
});

test('old long-blink confirm mapping cannot bypass the new scheme and low confidence does not execute', () => {
  const h = setup();
  h.context.handleGazeSliderSegment({ frames: { label: '长眨', margin: 1 } }, 1000);
  h.context.handleGazeSliderSegment({ frames: { label: '下看', margin: .1 } }, 2000);
  assert.equal(h.context.gazeSliderSession, h.session); assert.deepEqual(h.commits, []);
  h.context.handleGazeSliderSegment({ frames: { label: '上看', margin: 1 } }, 3000);
  h.context.handleGazeSliderSegment({ frames: { label: '下看', margin: 1 } }, 3100);
  assert.equal(h.context.gazeSliderSession, h.session, 'refractory period blocks an immediate second command');
});

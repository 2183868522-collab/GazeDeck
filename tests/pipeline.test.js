// Run with: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractFeatures, NUM_FEATURES, BLENDSHAPE_CHANNELS } from '../src/features.js';
import { computeBaseline, normalise } from '../src/baseline.js';
import { Segmenter, activityOf } from '../src/segmenter.js';
import { GestureClassifier, REST_LABEL, UNKNOWN_LABEL, dtw, resample } from '../src/classifier.js';
import { GestureEngine, PAUSE_ACTION, nextGridTime } from '../src/engine.js';
import { mulberry32, GESTURES, makeStream, restStream } from './synthetic.js';

function segmentsOf(stream, baseline, seg = new Segmenter()) {
  const out = [];
  for (const { frame, t } of stream) {
    const s = seg.push({ raw: frame, normalized: normalise(frame, baseline), timestampMs: t });
    if (s) out.push(s);
  }
  return out;
}

function timedGesture(fps, activeMs = 600, irregular = false) {
  const seg = new Segmenter({ onThreshold: 2.5, offThreshold: 1.5, minOffMs: 120, minDurationMs: 20 });
  const raw = new Float32Array(NUM_FEATURES);
  const active = Float32Array.from(raw, () => 4);
  let t = 0, result = null, i = 0;
  const push = normalized => {
    result ||= seg.push({ raw, normalized, timestampMs: t });
    const base = 1000 / fps;
    t += irregular ? base * (i++ === 7 ? 2 : [0.7, 1.3, 1, 1.15, 0.85][i % 5]) : base;
  };
  for (let elapsed = 0; elapsed < 200; elapsed += 1000 / fps) push(raw);
  for (let elapsed = 0; elapsed < activeMs; elapsed += 1000 / fps) push(active);
  for (let elapsed = 0; elapsed < 400; elapsed += 1000 / fps) push(raw);
  return result;
}

test('segment duration follows timestamps at 24, 30 and 60 fps', () => {
  for (const fps of [24, 30, 60]) {
    const s = timedGesture(fps);
    assert.ok(s, `${fps} fps produced a segment`);
    assert.ok(Math.abs(s.durationMs - 600) <= 1000 / fps + 1, `${fps} fps duration=${s.durationMs}`);
    assert.equal(s.rawFrames.length, s.frames.length);
    assert.equal(s.timestampsMs.length, s.frames.length);
  }
});

test('segment duration tolerates irregular frame intervals and a dropped frame', () => {
  const s = timedGesture(30, 600, true);
  assert.ok(s);
  assert.ok(Math.abs(s.durationMs - 600) < 70, `duration=${s.durationMs}`);
});

test('timestamp rollback resets the in-progress segment', () => {
  const seg = new Segmenter({ minOffMs: 100 });
  const raw = new Float32Array(NUM_FEATURES);
  const active = Float32Array.from(raw, () => 4);
  seg.push({ raw, normalized: active, timestampMs: 1000 });
  assert.equal(seg.isActive, true);
  assert.equal(seg.push({ raw, normalized: active, timestampMs: 900 }), null);
  assert.equal(seg.isActive, false);
});

test('extractFeatures: geometry on a synthetic face', () => {
  const lm = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  // Eye A: corners at x=0.30 and 0.40, eyelids ±0.015 → EAR = 0.03/0.10 = 0.3
  lm[33] = { x: 0.30, y: 0.40 }; lm[133] = { x: 0.40, y: 0.40 };
  for (const [a, b] of [[160, 144], [158, 153], [159, 145]]) { lm[a] = { x: 0.35, y: 0.385 }; lm[b] = { x: 0.35, y: 0.415 }; }
  lm[263] = { x: 0.70, y: 0.40 }; lm[362] = { x: 0.60, y: 0.40 };
  for (const [a, b] of [[385, 380], [387, 373], [386, 374]]) { lm[a] = { x: 0.65, y: 0.39 }; lm[b] = { x: 0.65, y: 0.41 }; }
  // Iris indices deliberately "swapped": 473 sits in eye A; the code must assign by proximity.
  lm[473] = { x: 0.36, y: 0.40 }; lm[468] = { x: 0.65, y: 0.40 };
  lm[1] = { x: 0.5, y: 0.55 }; lm[234] = { x: 0.2, y: 0.5 }; lm[454] = { x: 0.8, y: 0.5 }; lm[152] = { x: 0.5, y: 0.8 };
  const bs = [{ categoryName: 'eyeBlinkLeft', score: 0.42 }];
  const f = extractFeatures(lm, bs);
  assert.equal(f.length, NUM_FEATURES);
  assert.ok(Math.abs(f[0] - 0.42) < 1e-6, 'blendshape copied');
  const k = BLENDSHAPE_CHANNELS.length;
  assert.ok(Math.abs(f[k] - 0.3) < 1e-6, `EAR A = ${f[k]}`);
  assert.ok(Math.abs(f[k + 1] - 0.2) < 1e-6, `EAR B = ${f[k + 1]}`);
  assert.ok(Math.abs(f[k + 2] - 0.1) < 1e-5, `iris A x offset = ${f[k + 2]}`); // (0.36-0.35)/0.10
  assert.ok(Math.abs(f[k + 6]) < 1e-6, 'centred nose → yaw 0');
  assert.equal(extractFeatures(lm.slice(0, 100), bs), null);
});

test('baseline: rest frames normalise to small activity', () => {
  const rng = mulberry32(1);
  const rest = restStream(rng, 5000).map(s => s.frame);
  const b = computeBaseline(rest, BLENDSHAPE_CHANNELS.length);
  const acts = restStream(rng, 3000).map(s => activityOf(normalise(s.frame, b)));
  const mean = acts.reduce((a, x) => a + x, 0) / acts.length;
  assert.ok(mean < 1.5, `mean rest activity ${mean.toFixed(2)} should be ~1`);
});

test('segmenter: one segment per gesture, duration close to truth, double blink kept whole', () => {
  const rng = mulberry32(2);
  const b = computeBaseline(restStream(rng, 5000).map(s => s.frame), BLENDSHAPE_CHANNELS.length);
  assert.equal(segmentsOf(restStream(rng, 10000), b).length, 0, 'no false segments at rest');
  for (const [name, gen] of Object.entries(GESTURES)) {
    const script = gen(rng);
    const segs = segmentsOf(makeStream(script, rng), b);
    assert.equal(segs.length, 1, `${name}: got ${segs.length} segments`);
    const truth = script.reduce((s, [, ms]) => s + ms, 0);
    assert.ok(Math.abs(segs[0].durationMs - truth) < 120, `${name}: duration ${segs[0].durationMs.toFixed(0)} vs ${truth.toFixed(0)}`);
  }
});

test('dtw: identical sequences have zero distance; resample keeps endpoints', () => {
  const a = [[0], [1], [2], [3]].map(x => Float32Array.from(x));
  assert.equal(dtw(a, a, 2), 0);
  const r = resample(a, 7);
  assert.equal(r.length, 7); assert.equal(r[0][0], 0); assert.equal(r[6][0], 3);
});

test('classifier: few-shot (5 per class) separates short/long/double blink and left/right', () => {
  const rng = mulberry32(3);
  const b = computeBaseline(restStream(rng, 5000).map(s => s.frame), BLENDSHAPE_CHANNELS.length);
  const sample = (label) => { const [s] = segmentsOf(makeStream(GESTURES[label](rng), rng), b); return { label, ...s }; };
  const train = Object.keys(GESTURES).flatMap(l => Array.from({ length: 5 }, () => sample(l)));
  const clf = new GestureClassifier();
  clf.fit(train);
  const loo = clf.leaveOneOut();
  assert.ok(loo.accuracy >= 0.9, `LOO accuracy ${loo.accuracy}`);

  let correct = 0, total = 0;
  for (const label of Object.keys(GESTURES)) for (let i = 0; i < 20; i++) {
    const s = sample(label);
    if (clf.predict(s.frames, s.durationMs).label === label) correct++;
    total++;
  }
  assert.ok(correct / total >= 0.9, `held-out accuracy ${correct}/${total}`);
});

test('classifier: an action never recorded is rejected, not mapped to a command', () => {
  const rng = mulberry32(4);
  const b = computeBaseline(restStream(rng, 5000).map(s => s.frame), BLENDSHAPE_CHANNELS.length);
  const sample = (script) => segmentsOf(makeStream(script, rng), b)[0];
  const train = ['长眨', '左看'].flatMap(l => Array.from({ length: 6 }, () => ({ label: l, ...sample(GESTURES[l](rng)) })));
  const clf = new GestureClassifier();
  clf.fit(train);
  const weird = sample([['right', 2500]]); // long look right — nothing like the training set
  assert.equal(clf.predict(weird.frames, weird.durationMs).label, UNKNOWN_LABEL);
});

test('engine: rest ignored, refractory enforced, pause only answers pause gesture', () => {
  const e = new GestureEngine({ refractoryMs: 500 });
  const map = { '长眨': PAUSE_ACTION, '左看': 'prev' };
  assert.equal(e.decide({ label: REST_LABEL, margin: 1 }, map, 0).fired, false);
  assert.equal(e.decide({ label: '左看', margin: 1 }, map, 0).fired, true);
  assert.equal(e.decide({ label: '左看', margin: 1 }, map, 200).fired, false, 'refractory');
  assert.equal(e.decide({ label: '长眨', margin: 1 }, map, 1000).action, PAUSE_ACTION);
  assert.equal(e.paused, true);
  assert.equal(e.decide({ label: '左看', margin: 1 }, map, 2000).fired, false, 'paused');
  assert.equal(e.decide({ label: '长眨', margin: 1 }, map, 3000).fired, true, 'can always unpause');
  assert.equal(e.paused, false);
});

test('nextGridTime: snaps to the next eighth note', () => {
  // 120 bpm, eighths → 0.25 s grid starting at t=10
  assert.equal(nextGridTime(10.0, 10, 120, 2), 10.0);
  assert.ok(Math.abs(nextGridTime(10.26, 10, 120, 2) - 10.5) < 1e-9);
  assert.ok(Math.abs(nextGridTime(10.5, 10, 120, 2) - 10.5) < 1e-9);
  assert.equal(nextGridTime(9, 10, 120, 2), 10);
});

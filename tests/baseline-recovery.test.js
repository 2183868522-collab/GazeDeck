import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultProfile, addBaseline, activateBaseline, baselineSampleSummary,
  restoreRecordedBaseline, repairLegacyBaselineSelection, materialiseSample,
  saveProfile, loadProfile,
} from '../src/profile.js';

function recordedProfile() {
  const p = defaultProfile();
  p.id = 'recorded-user'; p.name = '羊驼';
  const baseline = addBaseline(p, { mean: [1, 2], std: [1, 2], numFrames: 514 });
  p.samples = Array.from({ length: 187 }, (_, i) => ({
    id: `sample-${i}`, label: i % 2 ? '左看' : '长眨',
    baselineId: baseline.id, sessionId: p.activeSessionId,
    encoding: i % 2 ? 'raw-v2' : 'normalized-v1', durationMs: 600,
    frames: i % 2 ? [{ offsetMs: 0, values: [2, 4] }] : [[1, 1]],
  }));
  p.eyeCalibration = { baselineId: baseline.id, applied: false, gains: {} };
  p.gazeSlider.calibration = { baselineId: baseline.id, left: -1, center: 0, right: 1 };
  return p;
}

test('repairs the old zero-count regression and preserves all 187 samples byte-for-byte', () => {
  const p = recordedProfile();
  const oldId = p.activeBaselineId;
  const savedSamples = JSON.stringify(p.samples);
  const before = materialiseSample(p, p.samples[1]);
  addBaseline(p, { mean: [4, 5], std: [2, 3], numFrames: 200 });
  assert.equal(p.samples.filter(s => s.baselineId === p.activeBaselineId).length, 0);
  const repair = repairLegacyBaselineSelection(p);
  assert.equal(repair.recovery.sampleCount, 187);
  assert.equal(p.activeBaselineId, oldId);
  assert.equal(JSON.stringify(p.samples), savedSamples);
  assert.deepEqual(materialiseSample(p, p.samples[1]), before);
  assert.equal(p.baselines.length, 2, 'the new calibration is also retained');
  assert.equal(baselineSampleSummary(p).find(item => item.active).sampleCount, 187);
});

test('recording a pending calibration does not change the live sample environment or sessions', () => {
  const p = recordedProfile();
  const oldId = p.activeBaselineId, oldSession = p.activeSessionId;
  const savedSamples = structuredClone(p.samples);
  const pending = addBaseline(p, { mean: [3, 4], std: [1, 2], numFrames: 120 }, {}, { activate: false });
  assert.notEqual(pending.id, oldId);
  assert.equal(p.activeBaselineId, oldId);
  assert.equal(p.activeSessionId, oldSession);
  assert.equal(p.sessions.length, 1);
  assert.deepEqual(p.samples, savedSamples);
  assert.equal(baselineSampleSummary(p).find(item => item.active).sampleCount, 187);
});

test('an explicitly enabled empty environment can be selected and restored without losing data', () => {
  const p = recordedProfile();
  repairLegacyBaselineSelection(p);
  const oldId = p.activeBaselineId;
  const oldEye = structuredClone(p.eyeCalibration), oldGaze = structuredClone(p.gazeSlider.calibration);
  const pending = addBaseline(p, { mean: [3, 4], std: [1, 2], numFrames: 120 }, {}, { activate: false });
  p.pendingBaselineId = pending.id;
  activateBaseline(p, pending.id, { reason: 'confirmed-new-calibration' });
  assert.equal(p.pendingBaselineId, null);
  assert.equal(repairLegacyBaselineSelection(p).changed, false);
  assert.equal(p.activeBaselineId, pending.id, 'one-time recovery must not undo a later deliberate choice');
  p.eyeCalibration = { baselineId: pending.id, applied: true, gains: { irisYA: 1.2 } };
  p.gazeSlider.calibration = { baselineId: pending.id, left: -0.3, center: 0, right: 0.3 };
  assert.equal(restoreRecordedBaseline(p).sampleCount, 187);
  assert.equal(p.activeBaselineId, oldId);
  assert.deepEqual(p.eyeCalibration, oldEye);
  assert.deepEqual(p.gazeSlider.calibration, oldGaze);
  assert.equal(p.samples.length, 187);
});

test('recovery cannot silently replace a nonempty current environment', () => {
  const p = recordedProfile();
  const before = structuredClone(p);
  assert.equal(restoreRecordedBaseline(p), null);
  assert.deepEqual(p, before);
  assert.throws(() => activateBaseline(p, 'missing-baseline'), /找不到/);
  assert.deepEqual(p, before);
});

test('recovered environment and all samples survive saving and reloading', () => {
  const data = new Map();
  globalThis.localStorage = {
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: key => data.delete(key), keys: () => [...data.keys()],
  };
  const p = recordedProfile();
  const oldId = p.activeBaselineId, samples = JSON.stringify(p.samples);
  addBaseline(p, { mean: [4, 5], std: [2, 3], numFrames: 200 });
  repairLegacyBaselineSelection(p);
  assert.equal(saveProfile(p), true);
  const restored = loadProfile();
  assert.equal(restored.activeBaselineId, oldId);
  assert.equal(JSON.stringify(restored.samples), samples);
  assert.equal(restored.baselineRecoveryNotice.sampleCount, 187);
  assert.equal(repairLegacyBaselineSelection(restored).changed, false);
});

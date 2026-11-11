// Multi-user profile store, including migration of the v0.1 single-profile data.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Minimal in-memory stand-in for the browser's localStorage.
class MemoryStorage {
  constructor() { this.m = new Map(); }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
  keys() { return [...this.m.keys()]; }
}
globalThis.localStorage = new MemoryStorage();
const P = await import('../src/profile.js');
beforeEach(() => { globalThis.localStorage = new MemoryStorage(); });

test('v0.1 data is migrated into the first user, unchanged, and the old key kept as backup', () => {
  const legacy = P.defaultProfileV1ForTest();
  legacy.name = '我';
  legacy.baseline = { mean: [1], std: [1], numFrames: 150 };
  legacy.samples = [{ id: 'a', label: '长眨', frames: [[0.1, 0.2]], durationMs: 700, createdAt: 1 }];
  const raw = JSON.stringify(legacy);
  localStorage.setItem('eye-gesture-control/profile/v1', raw);

  const p = P.loadProfile();
  assert.equal(p.name, '我');
  assert.equal(p.samples.length, 1);
  assert.deepEqual(p.samples[0].frames, [[0.1, 0.2]]);
  assert.equal(P.activeBaseline(p).numFrames, 150);
  assert.ok(p.id);
  assert.equal(localStorage.getItem('eye-gesture-control/profile/v1'), raw, 'old key untouched');
  assert.equal(P.listProfiles().length, 1);
  // Loading again must not migrate a second time.
  assert.equal(P.loadProfile().id, p.id);
  assert.equal(P.listProfiles().length, 1);
});

test('empty store creates one fresh user', () => {
  const p = P.loadProfile();
  assert.equal(p.name, '用户 1');
  assert.equal(P.listProfiles().length, 1);
  assert.equal(p.gazeSlider.settings.enabled, true);
  assert.equal(p.gazeSlider.calibration, null);
  assert.equal(p.music.volume, 70);
  assert.equal(p.settings.gazeDeckUseClosestGuess, false);
});

test('closest-action opt-in is saved per user, exported and defaults off for older profiles', () => {
  const first = P.loadProfile();
  first.settings.gazeDeckUseClosestGuess = true;
  P.saveProfile(first);
  assert.equal(P.loadProfile().settings.gazeDeckUseClosestGuess, true);
  const exported = P.validateProfile(JSON.parse(JSON.stringify(first)));
  assert.equal(exported.settings.gazeDeckUseClosestGuess, true);
  const other = P.createProfile('other');
  assert.equal(other.settings.gazeDeckUseClosestGuess, false);
  assert.equal(P.switchProfile(first.id).settings.gazeDeckUseClosestGuess, true);
  assert.equal(P.switchProfile(other.id).settings.gazeDeckUseClosestGuess, false);
  delete exported.settings.gazeDeckUseClosestGuess;
  assert.equal(P.validateProfile(exported).settings.gazeDeckUseClosestGuess, false);
});

test('users are independent; switching and reloading keep the right data', () => {
  const me = P.loadProfile();
  me.samples.push({ id: 's1', label: '长眨', frames: [[1]], durationMs: 600, createdAt: 1 });
  P.saveProfile(me);

  const other = P.createProfile('妈妈');
  assert.equal(other.samples.length, 0, 'new user starts empty');
  assert.equal(P.loadProfile().id, other.id, 'new user becomes active');

  const back = P.switchProfile(me.id);
  assert.equal(back.samples.length, 1);
  assert.equal(P.loadProfile().id, me.id, 'switch persists as active');

  const list = P.listProfiles();
  assert.deepEqual(list.map(u => [u.name, u.samples]), [['用户 1', 1], ['妈妈', 0]]);
});

test('deleting a user removes only that user', () => {
  const a = P.loadProfile();
  const b = P.createProfile('B');
  const active = P.deleteProfile(b.id);
  assert.equal(active.id, a.id);
  assert.deepEqual(P.listProfiles().map(u => u.id), [a.id]);
  assert.ok(!localStorage.keys().some(k => k.endsWith(b.id)));
  const fresh = P.deleteProfile(a.id); // deleting the last user leaves a fresh one, never an empty app
  assert.equal(P.listProfiles().length, 1);
  assert.equal(fresh.samples.length, 0);
});

test('old 150 ms rest-confirmation setting is upgraded, a user-chosen value is kept', () => {
  const old = P.defaultProfile(); delete old.settingsRevision; old.settings.segmenter.minOffMs = 150;
  assert.equal(P.validateProfile(JSON.parse(JSON.stringify(old))).settings.segmenter.minOffMs, 400);
  const custom = P.defaultProfile(); delete custom.settingsRevision; custom.settings.segmenter.minOffMs = 250;
  assert.equal(P.validateProfile(JSON.parse(JSON.stringify(custom))).settings.segmenter.minOffMs, 250);
  const upgraded = P.validateProfile(JSON.parse(JSON.stringify(old)));
  upgraded.settings.segmenter.minOffMs = 150; // user deliberately sets 150 after the upgrade: respect it
  assert.equal(P.validateProfile(JSON.parse(JSON.stringify(upgraded))).settings.segmenter.minOffMs, 150);
});

test('older v2 profiles gain gaze-slider defaults without losing their mappings', () => {
  const old = P.defaultProfile();
  delete old.gazeSlider;
  delete old.eyeCalibration;
  delete old.music.volume;
  old.settingsRevision = 2;
  old.mappings.music['双眨'] = 'accent';
  const upgraded = P.validateProfile(old);
  assert.equal(upgraded.gazeSlider.settings.deadZone, 0.28);
  assert.equal(upgraded.eyeCalibration, null);
  assert.equal(upgraded.music.volume, 70);
  assert.equal(upgraded.mappings.music['双眨'], 'accent');
  assert.equal(upgraded.settingsRevision, 6);
});

test('older camera position defaults widen without replacing chosen thresholds or samples', () => {
  const old = P.defaultProfile();
  old.settingsRevision = 5;
  Object.assign(old.settings.cameraAssist, {
    faceCenterToleranceX: 0.12, faceCenterToleranceY: 0.14,
    faceMinWidth: 0.38, faceMaxWidth: 0.62, faceMaxHeight: 0.78,
  });
  old.samples = [{ id: 'saved', label: '左看', frames: [[1]], durationMs: 600, createdAt: 1 }];
  const upgraded = P.validateProfile(old);
  assert.deepEqual(Object.fromEntries(Object.keys(old.settings.cameraAssist)
    .filter(key => key.startsWith('face') && key !== 'faceGuideEnabled')
    .map(key => [key, upgraded.settings.cameraAssist[key]])), {
    faceCenterToleranceX: 0.15, faceCenterToleranceY: 0.17,
    faceMinWidth: 0.35, faceMaxWidth: 0.65, faceMaxHeight: 0.82,
  });
  assert.deepEqual(upgraded.samples, old.samples);
  const custom = P.defaultProfile();
  custom.settingsRevision = 5;
  custom.settings.cameraAssist.faceCenterToleranceX = 0.20;
  custom.settings.cameraAssist.faceMaxWidth = 0.70;
  const preserved = P.validateProfile(custom);
  assert.equal(preserved.settings.cameraAssist.faceCenterToleranceX, 0.20);
  assert.equal(preserved.settings.cameraAssist.faceMaxWidth, 0.70);
});

test('v1 profile migrates to traceable v2 without pretending normalised samples are raw', () => {
  const old = P.defaultProfileV1ForTest();
  old.baseline = { mean: [1, 2], std: [0.1, 0.2], numFrames: 150 };
  old.samples = [{ id: 'old-sample', label: '长眨', frames: [[1, 2]], durationMs: 600, createdAt: 1 }];
  const migrated = P.validateProfile(old);
  assert.equal(migrated.version, 2);
  assert.equal(migrated.baselines.length, 1);
  assert.equal(migrated.sessions.length, 1);
  assert.equal(migrated.activeBaselineId, migrated.baselines[0].id);
  assert.equal(migrated.activeSessionId, migrated.sessions[0].id);
  assert.equal(migrated.samples[0].encoding, 'normalized-v1');
  assert.equal(migrated.samples[0].baselineId, migrated.activeBaselineId);
  assert.equal(migrated.samples[0].sessionId, migrated.activeSessionId);
  assert.deepEqual(migrated.samples[0].frames, [[1, 2]]);
});

test('v2 sample keeps raw features, timestamps, baseline and session provenance', () => {
  const p = P.defaultProfile();
  P.addBaseline(p, { mean: [1, 2], std: [1, 2], numFrames: 10 });
  const sample = P.createRawSample(p, '长眨', {
    rawFrames: [Float32Array.from([2, 4]), Float32Array.from([3, 6])],
    timestampsMs: [1000, 1041.5], durationMs: 83.25,
  });
  assert.equal(sample.encoding, 'raw-v2');
  assert.equal(sample.baselineId, p.activeBaselineId);
  assert.equal(sample.sessionId, p.activeSessionId);
  assert.deepEqual(sample.frames, [{ offsetMs: 0, values: [2, 4] }, { offsetMs: 41.5, values: [3, 6] }]);
  const materialised = P.materialiseSample(p, sample);
  assert.deepEqual(materialised.frames.map(f => Array.from(f)), [[1, 1], [2, 2]]);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { SustainedBlackFrameDetector } from '../src/black-frame-detector.js';

test('warns only after a camera has supplied near-black frames continuously', () => {
  const detector = new SustainedBlackFrameDetector({ durationMs: 2000 });
  assert.deepEqual(detector.update(0, 100, { cameraActive: true }), { detected: false, changed: false });
  assert.deepEqual(detector.update(1, 1100, { cameraActive: true }), { detected: false, changed: false });
  assert.deepEqual(detector.update(0.5, 2100, { cameraActive: true }), { detected: true, changed: true });
  assert.deepEqual(detector.update(0, 2600, { cameraActive: true }), { detected: true, changed: false });
});

test('brief black frames and dark video files do not trigger a camera warning', () => {
  const detector = new SustainedBlackFrameDetector({ durationMs: 2000 });
  detector.update(0, 0, { cameraActive: true });
  assert.equal(detector.update(0, 1900, { cameraActive: false }).detected, false);
  detector.update(0, 2100, { cameraActive: true });
  assert.equal(detector.update(0, 3000, { cameraActive: true }).detected, false);
});

test('clears the warning only after stable recovery and handles timestamp rollback', () => {
  const detector = new SustainedBlackFrameDetector({ durationMs: 1000, recoveryMs: 800 });
  detector.update(0, 0, { cameraActive: true });
  assert.equal(detector.update(0, 1000, { cameraActive: true }).detected, true);
  assert.equal(detector.update(80, 1100, { cameraActive: true }).detected, true);
  assert.equal(detector.update(80, 1899, { cameraActive: true }).detected, true);
  assert.deepEqual(detector.update(80, 1900, { cameraActive: true }), { detected: false, changed: true });

  detector.update(0, 2000, { cameraActive: true });
  assert.deepEqual(detector.update(0, 500, { cameraActive: true }), { detected: false, changed: false });
  assert.equal(detector.update(0, 1500, { cameraActive: true }).detected, true);
});

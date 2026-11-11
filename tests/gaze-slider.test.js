import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGazeCalibration,
  beginGazeCalibrationRun,
  cancelGazeCalibrationRun,
  normaliseGazePosition,
  GazeSliderController,
} from '../src/gaze-slider.js';

test('cancelling gaze calibration preserves every previously recorded gesture sample', () => {
  const profile = {
    samples: [
      { id: 'left-look', label: '左看', baselineId: 'b1' },
      { id: 'right-look', label: '右看', baselineId: 'b1' },
      { id: 'up-look', label: '上看', baselineId: 'b1' },
    ],
    gestures: ['左看', '右看', '上看'],
    activeBaselineId: 'b1',
    activeSessionId: 's1',
    gazeSlider: { calibration: { baselineId: 'b1', left: -1, center: 0, right: 1 } },
    eyeCalibration: { baselineId: 'b1', applied: true, gains: { irisYA: 1.2 } },
  };
  const expected = structuredClone(profile);
  const run = beginGazeCalibrationRun(profile);

  run.samples.left.push(-0.7);
  profile.samples.length = 0; // simulate an accidental shared clear during cancellation
  profile.gestures.length = 0;
  profile.activeBaselineId = 'wrong';
  profile.gazeSlider.calibration = null;
  profile.eyeCalibration = null;

  cancelGazeCalibrationRun(profile, run);
  assert.deepEqual(profile, expected);
  assert.equal(run.cancelled, true);
});

test('three-point calibration maps left/centre/right even when the camera axis is reversed', () => {
  const calibration = buildGazeCalibration({
    left: [0.18, 0.20, 0.19],
    center: [0.01, 0.00, -0.01],
    right: [-0.17, -0.18, -0.16],
  }, { baselineId: 'b1', minSpan: 0.05 });
  assert.equal(calibration.baselineId, 'b1');
  assert.ok(Math.abs(normaliseGazePosition(calibration.left, calibration) + 1) < 1e-9);
  assert.ok(Math.abs(normaliseGazePosition(calibration.center, calibration)) < 1e-9);
  assert.ok(Math.abs(normaliseGazePosition(calibration.right, calibration) - 1) < 1e-9);
});

test('calibration rejects targets that are too close or on the same side of centre', () => {
  assert.throws(() => buildGazeCalibration({ left: [0], center: [0.01], right: [0.02] }, { minSpan: 0.05 }), /区分/);
  assert.throws(() => buildGazeCalibration({ left: [-0.10], center: [0], right: [-0.20] }, { minSpan: 0.05 }), /方向/);
});

test('slider holds in the centre, waits for dwell, then integrates using real elapsed time', () => {
  const calibration = buildGazeCalibration({ left: [-1], center: [0], right: [1] }, { minSpan: 0.1 });
  const controller = new GazeSliderController(calibration, {
    deadZone: 0.25, hysteresis: 0.04, dwellMs: 300, smoothingMs: 0,
    minRatePerSec: 10, maxRatePerSec: 50,
  }, { min: 0, max: 100, initialValue: 50 });

  assert.equal(controller.updateSignal(0.1, 0).value, 50);
  assert.equal(controller.updateSignal(0.8, 100).value, 50, 'dwell begins');
  assert.equal(controller.updateSignal(0.8, 350).value, 50, 'still inside dwell');
  const moving = controller.updateSignal(0.8, 450);
  assert.ok(moving.value > 50, `value=${moving.value}`);
  const afterHalfSecond = controller.updateSignal(0.8, 950);
  assert.ok(afterHalfSecond.value > moving.value + 5, `value=${afterHalfSecond.value}`);
  assert.equal(controller.updateSignal(0, 1000).zone, 'center');
});

test('slider clamps at bounds and face loss pauses without a jump', () => {
  const calibration = buildGazeCalibration({ left: [-1], center: [0], right: [1] }, { minSpan: 0.1 });
  const controller = new GazeSliderController(calibration, {
    deadZone: 0.2, hysteresis: 0, dwellMs: 0, smoothingMs: 0,
    minRatePerSec: 100, maxRatePerSec: 100,
  }, { min: 0, max: 100, initialValue: 95 });
  controller.updateSignal(1, 0);
  assert.equal(controller.updateSignal(1, 1000).value, 100);
  controller.pause(5000);
  assert.equal(controller.updateSignal(-1, 5100).value, 100, 'new direction starts without applying lost time');
});

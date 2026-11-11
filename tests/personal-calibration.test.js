import test from 'node:test';
import assert from 'node:assert/strict';
import { FEATURE_NAMES } from '../src/features.js';
import { normalise } from '../src/baseline.js';
import { buildPersonalEyeCalibration } from '../src/personal-calibration.js';

const indices = Object.fromEntries(FEATURE_NAMES.map((name, i) => [name, i]));

function frame({ x = 0, y = 0, jitter = 0, earA = 0.25, earB = 0.24 } = {}) {
  const values = new Array(FEATURE_NAMES.length).fill(0);
  values[indices.irisXA] = x + jitter;
  values[indices.irisXB] = x - jitter;
  values[indices.irisYA] = y + jitter;
  values[indices.irisYB] = y - jitter;
  values[indices.earA] = earA;
  values[indices.earB] = earB;
  return values;
}

function calibrationSamples({ weakVertical = false } = {}) {
  const center = Array.from({ length: 16 }, (_, i) => frame({ jitter: (i % 2 ? 1 : -1) * 0.0005 }));
  return {
    center,
    left: Array.from({ length: 16 }, () => frame({ x: -0.015 })),
    right: Array.from({ length: 16 }, () => frame({ x: 0.015 })),
    up: Array.from({ length: 16 }, () => frame({ y: weakVertical ? 0.002 : -0.015 })),
    down: Array.from({ length: 16 }, () => frame({ y: weakVertical ? -0.002 : 0.015 })),
  };
}

const baseline = id => ({ id, mean: new Array(FEATURE_NAMES.length).fill(0), std: new Array(FEATURE_NAMES.length).fill(0.01) });

test('five-direction calibration measures eye geometry and derives bounded axis gains', () => {
  const result = buildPersonalEyeCalibration(calibrationSamples(), baseline('b1'));
  assert.equal(result.baselineId, 'b1');
  assert.deepEqual(result.eyeShape, { eyeAspectRatioA: 0.25, eyeAspectRatioB: 0.24 });
  assert.equal(result.axes.horizontal.status, 'good');
  assert.equal(result.axes.vertical.status, 'good');
  assert.equal(result.gains.irisXA, 1.5, 'gain is capped even for a small but clean range');
  assert.equal(result.applied, false, 'the caller explicitly opts in after checking existing samples');
});

test('weak vertical movement is reported and never amplified', () => {
  const result = buildPersonalEyeCalibration(calibrationSamples({ weakVertical: true }), baseline('b1'));
  assert.equal(result.axes.horizontal.status, 'good');
  assert.equal(result.axes.vertical.status, 'weak');
  assert.equal(result.gains.irisYA, 1);
  assert.equal(result.gains.irisYB, 1);
});

test('personalized gain affects only iris channels on its matching baseline', () => {
  const b = baseline('b1');
  const raw = new Array(FEATURE_NAMES.length).fill(0);
  raw[indices.irisYA] = 0.02;
  const calibrated = { baselineId: 'b1', applied: true, gains: { irisYA: 1.5 } };
  assert.ok(Math.abs(normalise(raw, b, calibrated)[indices.irisYA] - 3) < 1e-6);
  assert.ok(Math.abs(normalise(raw, b, calibrated)[indices.irisXA]) < 1e-6);
  assert.ok(Math.abs(normalise(raw, { ...b, id: 'b2' }, calibrated)[indices.irisYA] - 2) < 1e-6);
});

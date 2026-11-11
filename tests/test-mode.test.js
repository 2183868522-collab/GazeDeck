import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTrials, isSuccessfulPrediction, summariseTrials, shouldPromoteCandidate } from '../src/test-mode.js';

test('test trials contain every selected gesture and negative trials in deterministic random order', () => {
  const a = buildTrials(['长眨', '双眨'], 3, { includeRest: true, seed: 7 });
  const b = buildTrials(['长眨', '双眨'], 3, { includeRest: true, seed: 7 });
  assert.deepEqual(a, b);
  assert.equal(a.filter(x => x.targetLabel === '长眨').length, 3);
  assert.equal(a.filter(x => x.targetLabel === '双眨').length, 3);
  assert.equal(a.filter(x => x.targetLabel === '自然').length, 3);
});

test('summary reports positive and negative success separately and ignores invalid trials', () => {
  const result = summariseTrials([
    { targetLabel: '长眨', actualLabel: '长眨', predictedLabel: '长眨', reviewStatus: 'confirmed' },
    { targetLabel: '长眨', actualLabel: '长眨', predictedLabel: '未知', reviewStatus: 'confirmed' },
    { targetLabel: '自然', actualLabel: '自然', predictedLabel: '自然', reviewStatus: 'confirmed' },
    { targetLabel: '自然', actualLabel: '自然', predictedLabel: '长眨', reviewStatus: 'confirmed' },
    { targetLabel: '双眨', actualLabel: '双眨', predictedLabel: '双眨', reviewStatus: 'invalid' },
  ]);
  assert.equal(result.positive.total, 2);
  assert.equal(result.positive.success, 1);
  assert.equal(result.negative.total, 2);
  assert.equal(result.negative.success, 1);
  assert.equal(result.invalid, 1);
  assert.equal(result.balancedAccuracy, 0.5);
  assert.equal(result.byLabel['长眨'].predictions['未知'], 1);
});

test('natural detection as unknown prevents a false trigger and counts as success', () => {
  const trials = [
    { actualLabel: '自然', predictedLabel: '未知', reviewStatus: 'confirmed' },
    { actualLabel: '自然', predictedLabel: '自然', reviewStatus: 'confirmed' },
    { actualLabel: '自然', predictedLabel: '左看', reviewStatus: 'confirmed' },
    { actualLabel: '左看', predictedLabel: '未知', reviewStatus: 'confirmed' },
  ];
  const result = summariseTrials(trials);
  assert.equal(result.negative.success, 2);
  assert.equal(result.negative.total, 3);
  assert.equal(result.byLabel['自然'].success, 2);
  assert.equal(result.byLabel['自然'].predictions['未知'], 1);
  assert.equal(result.positive.success, 0);
  assert.equal(result.unknown, 2);
  assert.equal(isSuccessfulPrediction('自然', '未知'), true);
  assert.equal(isSuccessfulPrediction('左看', '未知'), false);
});

test('candidate promotion requires improvement without worse negative success', () => {
  assert.equal(shouldPromoteCandidate(
    { balancedAccuracy: 0.6, negative: { rate: 0.8 } },
    { balancedAccuracy: 0.8, negative: { rate: 0.8 } },
  ), true);
  assert.equal(shouldPromoteCandidate(
    { balancedAccuracy: 0.6, negative: { rate: 0.8 } },
    { balancedAccuracy: 0.9, negative: { rate: 0.6 } },
  ), false);
});

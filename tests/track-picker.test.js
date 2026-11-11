import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_TRACKS, TRACK_VALUE_STEP, trackIndexForValue, trackValueForIndex } from '../src/track-picker.js';

test('five tracks use fixed 1–20, 21–40, … 81–100 ranges', () => {
  assert.equal(MAX_TRACKS, 5);
  assert.equal(TRACK_VALUE_STEP, 20);
  for (let n = 1; n <= 100; n++) assert.equal(trackIndexForValue(n, 5), Math.ceil(n / 20) - 1);
  assert.equal(trackIndexForValue(0, 5), 0);
  assert.equal(trackIndexForValue(101, 5), 4);
  assert.equal(trackIndexForValue(-1, 5), 0);
});

test('fewer loaded tracks keep the same 20-unit spacing without empty slider slots', () => {
  for (const count of [1, 2, 3, 4, 5]) {
    for (let index = 0; index < count; index++) {
      assert.equal(trackIndexForValue(trackValueForIndex(index, count), count), index);
      assert.equal(trackValueForIndex(index, count), index * 20 + 10);
    }
    assert.equal(trackIndexForValue(count * 20, count), count - 1);
  }
  assert.equal(trackIndexForValue(20, 3), 0);
  assert.equal(trackIndexForValue(21, 3), 1);
  assert.equal(trackIndexForValue(40, 3), 1);
  assert.equal(trackIndexForValue(41, 3), 2);
  assert.equal(trackIndexForValue(50, 0), -1);
  assert.equal(trackIndexForValue(50, 6), -1);
  assert.equal(trackValueForIndex(1, 1), null);
  assert.equal(trackValueForIndex(0, 6), null);
});

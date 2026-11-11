import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultProfile, renameGesture, validateProfile } from '../src/profile.js';
import { REST_LABEL, UNKNOWN_LABEL } from '../src/classifier.js';

test('rename preserves all sample frames, ids, sessions and baseline associations and moves bindings', () => {
  const p = defaultProfile(), other = defaultProfile();
  p.samples = [
    { id: 'old', label: '长眨', baselineId: 'old-baseline', sessionId: 's1', frames: [[1, 2]], durationMs: 200 },
    { id: 'new', label: '长眨', baselineId: 'new-baseline', sessionId: 's2', frames: [[3, 4]], durationMs: 300 },
    { id: 'rest', label: REST_LABEL, frames: [[0, 0]] },
  ];
  p.testRuns = [{ trials: [{ actualLabel: '长眨', predictedLabel: '长眨' }] }];
  const before = structuredClone(p);
  assert.equal(renameGesture(p, '长眨', '  确认动作  '), true);
  assert.deepEqual(p.samples, before.samples.map(s => ({ ...s, label: s.label === '长眨' ? '确认动作' : s.label })));
  assert.equal(p.mappings.board['确认动作'], 'select');
  assert.equal(p.mappings.music['确认动作'], 'toggleLoop');
  assert.equal(Object.hasOwn(p.mappings.board, '长眨'), false);
  assert.equal(p.gazeSlider.settings.confirmGesture, '确认动作');
  assert.deepEqual(p.testRuns, before.testRuns);
  assert.ok(other.gestures.includes('长眨'));
  const restored = validateProfile(JSON.parse(JSON.stringify(p)));
  assert.deepEqual(restored.samples, p.samples);
  assert.deepEqual(restored.mappings, p.mappings);
  renameGesture(p, '上看', '退出');
  assert.equal(p.gazeSlider.settings.cancelGesture, '退出');
});

test('invalid names and cancellations/no-op cannot alter data or merge classes', () => {
  for (const name of ['', '  ', null, '双眨', REST_LABEL, UNKNOWN_LABEL, '<img>', 'a"b', 'a&b']) {
    const p = defaultProfile(), before = structuredClone(p);
    assert.throws(() => renameGesture(p, '长眨', name));
    assert.deepEqual(p, before);
  }
  const p = defaultProfile(), before = structuredClone(p);
  assert.equal(renameGesture(p, '长眨', ' 长眨 '), false);
  assert.throws(() => renameGesture(p, REST_LABEL, '静止'));
  assert.throws(() => renameGesture(p, '不存在', '新名字'));
  assert.deepEqual(p, before);
});

test('object prototype names remain ordinary own mapping keys and survive JSON', () => {
  const p = defaultProfile();
  renameGesture(p, '长眨', '__proto__');
  assert.equal(Object.getPrototypeOf(p.mappings.board), Object.prototype);
  assert.equal(JSON.parse(JSON.stringify(p)).mappings.board.__proto__, 'select');
});

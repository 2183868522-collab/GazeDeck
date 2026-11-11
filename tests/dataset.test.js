import test from 'node:test';
import assert from 'node:assert/strict';
import { splitBySession, assertNoSessionLeakage } from '../src/dataset.js';

const samples = ['a', 'b', 'c', 'd'].flatMap(sessionId =>
  ['自然', '长眨'].map((label, i) => ({ id: `${sessionId}-${i}`, sessionId, label }))
);

test('session split is deterministic and keeps sessions disjoint', () => {
  const a = splitBySession(samples, { seed: 42 });
  const b = splitBySession(samples, { seed: 42 });
  assert.deepEqual(a, b);
  assert.equal(a.status, 'ok');
  assert.doesNotThrow(() => assertNoSessionLeakage(a));
  assert.equal([...a.train, ...a.validation, ...a.test].length, samples.length);
});

test('fewer than three sessions reports insufficient data', () => {
  const r = splitBySession(samples.filter(s => s.sessionId === 'a' || s.sessionId === 'b'));
  assert.equal(r.status, 'insufficient-data');
  assert.match(r.reason, /3/);
  assert.deepEqual(r.train, []);
  assert.deepEqual(r.validation, []);
  assert.deepEqual(r.test, []);
});

test('leakage assertion rejects an overlapping session', () => {
  assert.throws(() => assertNoSessionLeakage({
    train: [{ sessionId: 'same' }], validation: [], test: [{ sessionId: 'same' }],
  }), /leakage/i);
});

// Deterministic, session-level dataset splitting. Samples recorded in one session are an inseparable
// group: putting neighbouring trials into both training and evaluation would leak recording conditions.

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function shuffled(values, seed) {
  const out = [...values], random = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function assertNoSessionLeakage(split) {
  const sets = ['train', 'validation', 'test'].map(name => new Set(split[name].map(s => s.sessionId)));
  for (let i = 0; i < sets.length; i++) for (let j = i + 1; j < sets.length; j++) {
    for (const id of sets[i]) if (sets[j].has(id)) throw new Error(`session leakage: ${id}`);
  }
  return true;
}

export function splitBySession(samples, { seed = 20261002 } = {}) {
  const ids = [...new Set(samples.map(s => s.sessionId).filter(Boolean))].sort();
  if (ids.length < 3) return {
    status: 'insufficient-data',
    reason: `需要至少 3 个独立 session，当前只有 ${ids.length} 个`,
    seed, train: [], validation: [], test: [], sessionIds: { train: [], validation: [], test: [] },
  };
  const order = shuffled(ids, seed);
  const testIds = [order.at(-1)], validationIds = [order.at(-2)], trainIds = order.slice(0, -2);
  const pick = wanted => samples.filter(s => wanted.includes(s.sessionId));
  const result = {
    status: 'ok', seed,
    train: pick(trainIds), validation: pick(validationIds), test: pick(testIds),
    sessionIds: { train: trainIds, validation: validationIds, test: testIds },
  };
  assertNoSessionLeakage(result);
  return result;
}

// Synthetic feature streams for tests: a fake "face" at rest plus scripted eye actions.
// Values are rough imitations of what MediaPipe produces, not real data.
import { FEATURE_NAMES, BLENDSHAPE_CHANNELS } from '../src/features.js';

export function mulberry32(seed) { // small seeded RNG so every test run is identical
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const idx = Object.fromEntries(FEATURE_NAMES.map((n, i) => [n, i]));
const REST = FEATURE_NAMES.map(n => (BLENDSHAPE_CHANNELS.includes(n) ? 0.1 : 0));
REST[idx.earA] = REST[idx.earB] = 0.3;

function restFrame(rng) {
  return Float32Array.from(REST, (v, j) => v + (rng() - 0.5) * (j < BLENDSHAPE_CHANNELS.length ? 0.06 : 0.01));
}

// Each action modifies the frame while "on".
const EFFECTS = {
  blink(f) { f[idx.eyeBlinkLeft] = 0.9; f[idx.eyeBlinkRight] = 0.9; f[idx.earA] = 0.08; f[idx.earB] = 0.08; },
  left(f) { f[idx.eyeLookOutLeft] = 0.7; f[idx.eyeLookInRight] = 0.7; f[idx.irisXA] = 0.12; f[idx.irisXB] = 0.12; },
  right(f) { f[idx.eyeLookInLeft] = 0.7; f[idx.eyeLookOutRight] = 0.7; f[idx.irisXA] = -0.12; f[idx.irisXB] = -0.12; },
};

// Gesture scripts: list of [effect or null, durationMs].
export const GESTURES = {
  '自然': rng => [['blink', 120 + rng() * 60]],                          // spontaneous blink
  '长眨': rng => [['blink', 650 + rng() * 250]],
  // Real double blinks reopen the eye for a few hundred ms between the two closures (estimated range).
  '双眨': rng => [['blink', 130 + rng() * 40], [null, 200 + rng() * 150], ['blink', 130 + rng() * 40]],
  '左看': rng => [['left', 500 + rng() * 300]],
  '右看': rng => [['right', 500 + rng() * 300]],
};

/** Stream: rest, gesture, rest. Returns [{ frame, t }] at `fps`. */
export function makeStream(script, rng, { fps = 30, restBeforeMs = 600, restAfterMs = 600, t0 = 0 } = {}) {
  const dt = 1000 / fps;
  const out = [];
  let t = t0;
  const emit = (effect, ms) => {
    for (let e = 0; e < ms; e += dt, t += dt) {
      const f = restFrame(rng);
      if (effect) EFFECTS[effect](f);
      out.push({ frame: f, t });
    }
  };
  emit(null, restBeforeMs);
  for (const [effect, ms] of script) emit(effect, ms);
  emit(null, restAfterMs);
  return out;
}

export function restStream(rng, ms, fps = 30) { return makeStream([], rng, { fps, restBeforeMs: ms, restAfterMs: 0 }); }

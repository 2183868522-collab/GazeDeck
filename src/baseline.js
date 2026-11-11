// Per-person normalisation ("resting face" baseline).
//
// Analogy: before comparing how loud two people shout, measure how loudly each one normally talks.
// We record a few seconds of the person looking at the screen relaxed, store mean and spread of every
// feature, and from then on express each frame as "how many spreads away from this person's rest".
// This is what absorbs individual differences such as drooping eyelids or glasses.

// Minimum spread per feature, so a feature that hardly moved at rest does not explode when divided.
// Blendshapes live in [0,1]; geometric features are small ratios.
import { FEATURE_NAMES } from './features.js';

const STD_FLOOR_BLENDSHAPE = 0.03;
const STD_FLOOR_GEOMETRIC = 0.01;
const Z_CLIP = 8; // cap extreme values so one glitchy frame cannot dominate a distance

export function computeBaseline(frames, numBlendshape) {
  if (!frames.length) throw new Error('computeBaseline: no frames');
  const d = frames[0].length;
  const mean = new Array(d).fill(0);
  const std = new Array(d).fill(0);
  for (const f of frames) for (let j = 0; j < d; j++) mean[j] += f[j];
  for (let j = 0; j < d; j++) mean[j] /= frames.length;
  for (const f of frames) for (let j = 0; j < d; j++) std[j] += (f[j] - mean[j]) ** 2;
  for (let j = 0; j < d; j++) {
    const floor = j < numBlendshape ? STD_FLOOR_BLENDSHAPE : STD_FLOOR_GEOMETRIC;
    std[j] = Math.max(Math.sqrt(std[j] / frames.length), floor);
  }
  return { mean, std, numFrames: frames.length };
}

export function normalise(frame, baseline, eyeCalibration = null) {
  const out = new Float32Array(frame.length);
  for (let j = 0; j < frame.length; j++) {
    const z = (frame[j] - baseline.mean[j]) / baseline.std[j];
    out[j] = Math.max(-Z_CLIP, Math.min(Z_CLIP, z));
  }
  if (eyeCalibration?.applied && eyeCalibration.baselineId === baseline.id) {
    for (const name of ['irisXA', 'irisXB', 'irisYA', 'irisYB']) {
      const i = FEATURE_NAMES.indexOf(name);
      const gain = Number(eyeCalibration.gains?.[name]);
      if (i < out.length && Number.isFinite(gain)) out[i] = Math.max(-Z_CLIP, Math.min(Z_CLIP, out[i] * gain));
    }
  }
  return out;
}

// Slowly let the resting mean follow the person (posture, lighting drift) while nothing is happening.
// alpha = 0.002 at 30 fps means a time constant of roughly 17 seconds.
export function adaptBaseline(baseline, frame, alpha) {
  for (let j = 0; j < frame.length; j++) baseline.mean[j] += alpha * (frame[j] - baseline.mean[j]);
}

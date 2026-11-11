import { FEATURE_NAMES } from './features.js';

const index = Object.fromEntries(FEATURE_NAMES.map((name, i) => [name, i]));
const CHANNELS = {
  horizontal: [
    { name: 'irisXA', negative: 'left', positive: 'right' },
    { name: 'irisXB', negative: 'left', positive: 'right' },
  ],
  vertical: [
    { name: 'irisYA', negative: 'up', positive: 'down' },
    { name: 'irisYB', negative: 'up', positive: 'down' },
  ],
};
const BLINK_INDICES = [index.eyeBlinkLeft, index.eyeBlinkRight];
const POSE_INDICES = [index.headYaw, index.headPitch];

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) throw new Error('校准没有采集到有效眼动数据');
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function usableFrames(frames, { baseline = null, centerPose = null } = {}) {
  return (frames || []).filter(frame => frame?.length >= FEATURE_NAMES.length
    && [...CHANNELS.horizontal, ...CHANNELS.vertical].every(({ name }) => Number.isFinite(frame[index[name]]))
    && BLINK_INDICES.every(i => !Number.isFinite(frame[i]) || frame[i] < 0.65)
    && (!baseline || !centerPose || POSE_INDICES.every(i => {
      const limit = Math.max((Number(baseline.std[i]) || 0.01) * 2.5, 0.015);
      return Number.isFinite(frame[i]) && Math.abs(frame[i] - centerPose[i]) <= limit;
    })));
}

function channelRange(samples, baseline, centerPose, channel) {
  const i = index[channel.name];
  const neutral = usableFrames(samples.center).map(frame => frame[i]);
  const negative = usableFrames(samples[channel.negative], { baseline, centerPose }).map(frame => frame[i]);
  const positive = usableFrames(samples[channel.positive], { baseline, centerPose }).map(frame => frame[i]);
  if (neutral.length < 8 || negative.length < 8 || positive.length < 8) {
    throw new Error('每个方向需要至少 8 帧清晰、睁眼且头部稳定的画面；请保持头部自然稳定后重试');
  }

  const center = median(neutral);
  const negativeDelta = median(negative) - center;
  const positiveDelta = median(positive) - center;
  const movesOppositeWays = negativeDelta * positiveDelta < 0;
  const excursion = movesOppositeWays ? Math.min(Math.abs(negativeDelta), Math.abs(positiveDelta)) : 0;
  const restMad = median(neutral.map(value => Math.abs(value - center)));
  const restNoise = 1.4826 * restMad;
  const std = Math.max(Number(baseline?.std?.[i]) || 0, 0.01);
  const rangeInRestSpreads = excursion / std;
  const noiseInRestSpreads = restNoise / std;
  const signalToNoise = rangeInRestSpreads / Math.max(noiseInRestSpreads, 0.15);
  const reliable = movesOppositeWays && rangeInRestSpreads >= 0.4 && signalToNoise >= 2.5;

  // The neutral baseline already scales features by their natural variation. This is a small,
  // bounded correction for a person's usable gaze range; never amplify a noisy/uncertain axis.
  const gain = reliable ? clamp(2.5 / rangeInRestSpreads, 0.8, 1.5) : 1;
  return {
    rangeInRestSpreads: Number(rangeInRestSpreads.toFixed(3)),
    noiseInRestSpreads: Number(noiseInRestSpreads.toFixed(3)),
    signalToNoise: Number(signalToNoise.toFixed(2)),
    reliable,
    gain: Number(gain.toFixed(3)),
  };
}

/**
 * Estimate eye shape and comfortable, repeatable gaze ranges from guided target holds.
 * The returned gains are deliberately modest and are applied only after the neutral baseline.
 * @param {Record<'center'|'left'|'right'|'up'|'down', ArrayLike<number>[]>} samples
 * @param {{id?: string, std: number[]}} baseline
 */
export function buildPersonalEyeCalibration(samples, baseline, { baselineId = baseline?.id ?? null } = {}) {
  if (!samples || !baseline?.std) throw new Error('需要先完成静息校准');
  const centerFrames = usableFrames(samples.center);
  if (centerFrames.length < 8) throw new Error('中央位置采集不足，请正对屏幕并保持头部自然稳定后重试');
  const centerPose = Object.fromEntries(POSE_INDICES.map(i => [i, median(centerFrames.map(frame => frame[i]))]));

  const axes = {};
  const gains = {};
  for (const axis of Object.keys(CHANNELS)) {
    const channels = CHANNELS[axis].map(channel => ({
      name: channel.name,
      ...channelRange(samples, baseline, centerPose, channel),
    }));
    channels.forEach(channel => { gains[channel.name] = channel.gain; });
    const reliableCount = channels.filter(channel => channel.reliable).length;
    axes[axis] = {
      status: reliableCount === channels.length ? 'good' : reliableCount ? 'partial' : 'weak',
      signalToNoise: Number(median(channels.map(channel => channel.signalToNoise)).toFixed(2)),
      rangeInRestSpreads: Number(median(channels.map(channel => channel.rangeInRestSpreads)).toFixed(3)),
      channels,
    };
  }

  const eyeAspectRatio = name => {
    const values = centerFrames.map(frame => frame[index[name]]).filter(Number.isFinite);
    return values.length ? Number(median(values).toFixed(4)) : null;
  };

  return {
    version: 1,
    baselineId,
    createdAt: Date.now(),
    applied: false,
    eyeShape: { eyeAspectRatioA: eyeAspectRatio('earA'), eyeAspectRatioB: eyeAspectRatio('earB') },
    axes,
    gains,
  };
}

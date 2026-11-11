import { FEATURE_NAMES } from './features.js';

const IRIS_A = FEATURE_NAMES.indexOf('irisXA');
const IRIS_B = FEATURE_NAMES.indexOf('irisXB');
const HEAD_YAW = FEATURE_NAMES.indexOf('headYaw');

export const GAZE_SLIDER_ACTIONS = Object.freeze({
  volume: 'openSliderVolume',
  bpm: 'openSliderBpm',
  effect: 'openSliderEffect',
  track: 'openSliderTrack',
});

// Shared fixed command scheme, independent of legacy per-profile confirm/cancel bindings.
export const SLIDER_GESTURES = Object.freeze({ restore: '上看', keep: '下看' });

export const DEFAULT_GAZE_SLIDER_SETTINGS = Object.freeze({
  enabled: true,
  deadZone: 0.28,
  hysteresis: 0.06,
  dwellMs: 300,
  smoothingMs: 180,
  minRatePerSec: 5,
  maxRatePerSec: 35,
  timeoutMs: 20000,
  headCompensation: 0.35,
  confirmGesture: '长眨',
  cancelGesture: '上看',
});

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const clone = value => value === undefined ? undefined : structuredClone(value);
const median = values => {
  const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) throw new Error('校准没有采集到有效视线数据');
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
};

// A horizontal iris signal with a small head-yaw correction. Its sign is deliberately not assumed:
// three-point calibration learns whether a given camera/browser mirroring setup increases to the right.
export function gazeSignal(raw, headCompensation = DEFAULT_GAZE_SLIDER_SETTINGS.headCompensation) {
  if (!raw || raw.length <= Math.max(IRIS_A, IRIS_B, HEAD_YAW)) return null;
  const iris = (Number(raw[IRIS_A]) + Number(raw[IRIS_B])) / 2;
  const signal = iris - headCompensation * Number(raw[HEAD_YAW]);
  return Number.isFinite(signal) ? signal : null;
}

export function buildGazeCalibration(samples, { baselineId = null, minSpan = 0.025 } = {}) {
  const left = median(samples.left || []);
  const center = median(samples.center || []);
  const right = median(samples.right || []);
  const leftDelta = left - center, rightDelta = right - center;
  if (Math.abs(leftDelta) < minSpan || Math.abs(rightDelta) < minSpan) {
    throw new Error('左右视线与中央区分不足，请保持头部稳定并重新校准');
  }
  if (leftDelta * rightDelta >= 0) throw new Error('左右视线方向无法区分，请重新校准');
  return {
    baselineId,
    createdAt: Date.now(),
    left, center, right,
    direction: Math.sign(right - left) || 1,
    leftSpan: Math.abs(leftDelta),
    rightSpan: Math.abs(rightDelta),
  };
}

export function normaliseGazePosition(signal, calibration) {
  if (!calibration || !Number.isFinite(signal)) return null;
  const directed = (signal - calibration.center) * calibration.direction;
  const span = directed < 0 ? calibration.leftSpan : calibration.rightSpan;
  if (!(span > 0)) return null;
  return clamp(directed / span, -1.5, 1.5);
}

// Gaze calibration is transactional. The temporary left/centre/right frames must
// never share storage or cancellation behaviour with recorded gesture samples.
export function beginGazeCalibrationRun(profile) {
  return {
    samples: { left: [], center: [], right: [], up: [], down: [] },
    frames: { left: [], center: [], right: [], up: [], down: [] },
    target: null,
    collecting: false,
    cancelled: false,
    protectedState: {
      samples: clone(profile.samples || []),
      gestures: clone(profile.gestures || []),
      activeBaselineId: profile.activeBaselineId ?? null,
      activeSessionId: profile.activeSessionId ?? null,
      calibration: clone(profile.gazeSlider?.calibration ?? null),
      hasEyeCalibration: Object.hasOwn(profile, 'eyeCalibration'),
      eyeCalibration: clone(profile.eyeCalibration ?? null),
    },
  };
}

export function cancelGazeCalibrationRun(profile, run) {
  if (!run) return profile;
  run.cancelled = true;
  const saved = run.protectedState;
  if (!saved) return profile;
  profile.samples = clone(saved.samples);
  profile.gestures = clone(saved.gestures);
  profile.activeBaselineId = saved.activeBaselineId;
  profile.activeSessionId = saved.activeSessionId;
  profile.gazeSlider ||= {};
  profile.gazeSlider.calibration = clone(saved.calibration);
  if (saved.hasEyeCalibration) profile.eyeCalibration = clone(saved.eyeCalibration);
  else delete profile.eyeCalibration;
  return profile;
}

export class GazeSliderController {
  constructor(calibration, settings = {}, range = {}) {
    this.calibration = calibration;
    this.settings = { ...DEFAULT_GAZE_SLIDER_SETTINGS, ...settings };
    this.min = Number.isFinite(range.min) ? range.min : 0;
    this.max = Number.isFinite(range.max) ? range.max : 100;
    this.value = clamp(Number.isFinite(range.initialValue) ? range.initialValue : this.min, this.min, this.max);
    this.smoothed = null;
    this.lastT = null;
    this.activeDirection = 0;
    this.directionSince = null;
  }

  updateSignal(signal, t) {
    const x = normaliseGazePosition(signal, this.calibration);
    if (x === null) return this.pause(t);
    const dt = this.lastT === null ? 0 : clamp(t - this.lastT, 0, 250);
    this.lastT = t;
    const smoothing = Math.max(0, this.settings.smoothingMs);
    const alpha = this.smoothed === null || smoothing === 0 ? 1 : 1 - Math.exp(-dt / smoothing);
    this.smoothed = this.smoothed === null ? x : this.smoothed + alpha * (x - this.smoothed);

    const abs = Math.abs(this.smoothed);
    const enterAt = this.settings.deadZone + this.settings.hysteresis;
    const leaveAt = Math.max(0, this.settings.deadZone - this.settings.hysteresis);
    let direction = this.activeDirection;
    if (direction && (abs <= leaveAt || Math.sign(this.smoothed) !== direction)) direction = 0;
    if (!direction && abs >= enterAt) direction = Math.sign(this.smoothed);

    if (!direction) {
      this.activeDirection = 0; this.directionSince = null;
      return this.snapshot('center', 0, 0);
    }
    if (direction !== this.activeDirection) {
      this.activeDirection = direction; this.directionSince = t;
      return this.snapshot(direction < 0 ? 'left-wait' : 'right-wait', 0, 0);
    }
    const dwellElapsed = t - this.directionSince;
    if (dwellElapsed < this.settings.dwellMs) {
      return this.snapshot(direction < 0 ? 'left-wait' : 'right-wait', 0, dwellElapsed / Math.max(1, this.settings.dwellMs));
    }

    const amount = clamp((abs - this.settings.deadZone) / Math.max(0.01, 1 - this.settings.deadZone), 0, 1);
    const rate = this.settings.minRatePerSec
      + (this.settings.maxRatePerSec - this.settings.minRatePerSec) * amount ** 1.5;
    const delta = direction * rate * dt / 1000;
    this.value = clamp(this.value + delta, this.min, this.max);
    return this.snapshot(direction < 0 ? 'left' : 'right', direction * rate, 1, delta);
  }

  updateFrame(raw, t) {
    const signal = gazeSignal(raw, this.settings.headCompensation);
    return signal === null ? this.pause(t) : this.updateSignal(signal, t);
  }

  pause(t = this.lastT) {
    this.lastT = t;
    this.activeDirection = 0;
    this.directionSince = null;
    return this.snapshot('lost', 0, 0);
  }

  snapshot(zone, rate, dwellProgress, delta = 0) {
    return { value: this.value, position: this.smoothed, zone, rate, dwellProgress, delta };
  }
}

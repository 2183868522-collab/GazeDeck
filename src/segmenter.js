// Streaming segmenter: cuts the continuous feature stream into candidate "actions".
//
// Idea: compute an "activity" number per frame = how far, overall, the face is from its resting state
// (root-mean-square of the normalised features). An action starts when activity rises above `onThreshold`
// and ends once it has stayed below `offThreshold` for `minOffMs`. Two thresholds (hysteresis) stop the
// segmenter from flickering on/off when activity hovers around one value, like a thermostat.
// Both training samples and live use go through this same cutter, so the classifier always sees
// segments shaped the same way.

export const DEFAULT_SEGMENTER_SETTINGS = {
  onThreshold: 2.5,   // activity (in resting spreads) needed to start an action
  offThreshold: 1.5,  // activity below which we consider the face back at rest
  minOffMs: 400,      // must stay at rest this long before the action is closed; also the longest pause that
                      // still joins two closures into one action (a double blink reopens the eye ~200–350 ms)
  minDurationMs: 60,  // shorter blips are discarded as noise
  maxDurationMs: 4000,// force-close very long actions (e.g. the person changed posture)
  preRollFrames: 2,   // keep a couple of frames before the onset so the start of the motion is not lost
};

export function activityOf(z) {
  let s = 0;
  for (let j = 0; j < z.length; j++) s += z[j] * z[j];
  return Math.sqrt(s / z.length);
}

export class Segmenter {
  constructor(settings = {}) {
    this.settings = { ...DEFAULT_SEGMENTER_SETTINGS, ...settings };
    this.reset();
  }

  reset() {
    this.history = [];     // recent frames kept for pre-roll
    this.active = null;    // segment under construction
    this.lastActiveT = 0;  // time activity was last above offThreshold
    this.lastTimestampMs = null;
  }

  get isActive() { return this.active !== null; }

  /**
   * Feed one normalised frame. Returns a finished segment or null.
   * Segment: { frames: Float32Array[], t0, t1, durationMs, peakActivity }
   */
  push({ raw, normalized: z, timestampMs: t }) {
    if (!Number.isFinite(t) || (this.lastTimestampMs !== null && t <= this.lastTimestampMs)) {
      this.reset();
      return null;
    }
    this.lastTimestampMs = t;
    const s = this.settings;
    const a = activityOf(z);
    const frame = { raw, z, t, a };

    if (!this.active) {
      this.history.push(frame);
      if (this.history.length > s.preRollFrames + 1) this.history.shift();
      if (a >= s.onThreshold) {
        this.active = { frames: [...this.history], peak: a };
        this.history = [];
        this.lastActiveT = t;
      }
      return null;
    }

    const seg = this.active;
    seg.frames.push(frame);
    seg.peak = Math.max(seg.peak, a);
    if (a >= s.offThreshold) this.lastActiveT = t;

    const tooLong = t - seg.frames[0].t >= s.maxDurationMs;
    const settled = t - this.lastActiveT >= s.minOffMs;
    if (!(settled || tooLong)) return null;

    this.active = null;
    // Trim the trailing rest frames, keeping one so the "eye reopened" moment is in the segment.
    let end = seg.frames.length;
    if (settled) while (end > 1 && seg.frames[end - 2].a < s.offThreshold) end--;
    const frames = seg.frames.slice(0, end);
    const t0 = frames[0].t, t1 = frames[frames.length - 1].t;
    // Duration = time the activity was actually high (onset to last active frame), not including pre-roll.
    const onset = frames.find(f => f.a >= s.onThreshold)?.t ?? t0;
    const timestamps = frames.map(f => f.t);
    const deltas = timestamps.slice(1).map((value, i) => value - timestamps[i])
      .filter(value => value > 0 && value <= 150).sort((a, b) => a - b);
    const middle = Math.floor(deltas.length / 2);
    const frameIntervalMs = !deltas.length ? 0 : deltas.length % 2
      ? deltas[middle] : (deltas[middle - 1] + deltas[middle]) / 2;
    const durationMs = Math.max(this.lastActiveT - onset, 0) + frameIntervalMs;
    if (durationMs < s.minDurationMs) return null;
    return {
      frames: frames.map(f => f.z), // compatibility: classifier consumes normalised frames
      rawFrames: frames.map(f => f.raw),
      timestampsMs: timestamps,
      t0, t1, durationMs, peakActivity: seg.peak, forced: tooLong,
    };
  }
}

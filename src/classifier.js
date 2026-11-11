// Few-shot gesture classifier: k-nearest-neighbours with Dynamic Time Warping (DTW).
//
// Why this and not a neural network: each patient records only 5–10 examples per action. A nearest-neighbour
// classifier needs no training at all — "learning" is just storing the examples — so adding a new action or
// re-recording one takes effect instantly. DTW compares two motion curves while allowing small stretches in
// time (the same blink done a bit slower still matches), like aligning two recordings of the same melody
// played at slightly different tempos.
//
// DTW alone would make a short blink and a long blink look alike (it stretches one into the other), so the
// distance also includes an explicit duration term: λ · |log(duration₁ / duration₂)|.

export const DEFAULT_CLASSIFIER_SETTINGS = {
  resampleLength: 20,  // every segment is resampled to this many frames before comparison
  band: 3,             // Sakoe–Chiba band: max time shift (in resampled frames) DTW may use
  durationWeight: 1.0, // λ in the duration term
  k: 3,                // neighbours that vote
  rejectFactor: 2.0,   // reject if distance > rejectFactor × typical within-class distance
};

export const REST_LABEL = '自然';
export const UNKNOWN_LABEL = '未知';

// Linear interpolation of a sequence of vectors to a fixed length.
export function resample(frames, L) {
  const n = frames.length, d = frames[0].length;
  const out = [];
  for (let i = 0; i < L; i++) {
    const pos = n === 1 ? 0 : (i * (n - 1)) / (L - 1);
    const lo = Math.floor(pos), hi = Math.min(lo + 1, n - 1), w = pos - lo;
    const v = new Float32Array(d);
    for (let j = 0; j < d; j++) v[j] = frames[lo][j] * (1 - w) + frames[hi][j] * w;
    out.push(v);
  }
  return out;
}

function frameDist(a, b) {
  let s = 0;
  for (let j = 0; j < a.length; j++) s += (a[j] - b[j]) ** 2;
  return Math.sqrt(s / a.length);
}

// Banded DTW between equal-length sequences; returns mean cost along the best path.
export function dtw(A, B, band) {
  const n = A.length, m = B.length;
  const INF = Infinity;
  let prev = new Float64Array(m + 1).fill(INF), cur = new Float64Array(m + 1).fill(INF);
  let prevLen = new Int32Array(m + 1), curLen = new Int32Array(m + 1);
  prev[0] = 0;
  for (let i = 1; i <= n; i++) {
    cur.fill(INF); curLen.fill(0);
    const lo = Math.max(1, i - band), hi = Math.min(m, i + band);
    for (let j = lo; j <= hi; j++) {
      const c = frameDist(A[i - 1], B[j - 1]);
      // Pick the cheapest predecessor: diagonal, up, or left.
      let best = prev[j - 1], len = prevLen[j - 1];
      if (prev[j] < best) { best = prev[j]; len = prevLen[j]; }
      if (cur[j - 1] < best) { best = cur[j - 1]; len = curLen[j - 1]; }
      cur[j] = best + c; curLen[j] = len + 1;
    }
    [prev, cur] = [cur, prev]; [prevLen, curLen] = [curLen, prevLen];
  }
  return prev[m] / Math.max(prevLen[m], 1);
}

export class GestureClassifier {
  constructor(settings = {}) {
    this.settings = { ...DEFAULT_CLASSIFIER_SETTINGS, ...settings };
    this.examples = []; // { label, seq (resampled), logDur }
    this.classScale = new Map();
  }

  prepare(frames, durationMs) {
    return { seq: resample(frames, this.settings.resampleLength), logDur: Math.log(Math.max(durationMs, 1)) };
  }

  distance(x, y) {
    return dtw(x.seq, y.seq, this.settings.band) + this.settings.durationWeight * Math.abs(x.logDur - y.logDur);
  }

  /** Replace all examples. samples: [{ label, frames: normalised Float32Array[], durationMs }] */
  fit(samples) {
    this.examples = samples.map(s => ({ label: s.label, ...this.prepare(s.frames, s.durationMs) }));
    // Typical within-class distance = median nearest same-class neighbour distance. Used for rejection.
    this.classScale = new Map();
    for (const label of this.labels()) {
      const own = this.examples.filter(e => e.label === label);
      const nn = own.map((e, i) => Math.min(...own.filter((_, k) => k !== i).map(o => this.distance(e, o))))
                    .filter(Number.isFinite).sort((a, b) => a - b);
      if (nn.length) this.classScale.set(label, nn[Math.floor(nn.length / 2)]);
    }
  }

  labels() { return [...new Set(this.examples.map(e => e.label))]; }

  /**
   * Classify one segment. Returns { label, distance, margin, votes }.
   * label is UNKNOWN_LABEL if the nearest example is too far away to trust.
   */
  predict(frames, durationMs, exclude = null) {
    const x = this.prepare(frames, durationMs);
    return this.predictPrepared(x, exclude);
  }

  predictPrepared(x, exclude = null) {
    const pool = exclude === null ? this.examples : this.examples.filter((_, i) => i !== exclude);
    if (!pool.length) return { label: UNKNOWN_LABEL, distance: Infinity, margin: 0, votes: {} };
    const scored = pool.map(e => ({ label: e.label, d: this.distance(x, e) })).sort((a, b) => a.d - b.d);

    // Distance-weighted vote among the k nearest.
    const votes = {};
    for (const { label, d } of scored.slice(0, this.settings.k)) votes[label] = (votes[label] || 0) + 1 / (d + 1e-6);
    const label = Object.entries(votes).sort((a, b) => b[1] - a[1])[0][0];

    const nearestOwn = scored.find(s => s.label === label).d;
    const nearestOther = scored.find(s => s.label !== label)?.d ?? Infinity;
    const margin = nearestOther - nearestOwn;

    // Open-set rejection: something unlike anything recorded should not fire a command.
    const scale = this.classScale.get(label);
    if (scale !== undefined && nearestOwn > this.settings.rejectFactor * Math.max(scale, 0.05)) {
      return { label: UNKNOWN_LABEL, guess: label, distance: nearestOwn, margin, votes };
    }
    return { label, distance: nearestOwn, margin, votes };
  }

  /** Leave-one-out evaluation: classify each example against all the others. */
  leaveOneOut() {
    const labels = this.labels();
    const confusion = Object.fromEntries(labels.map(l => [l, Object.fromEntries([...labels, UNKNOWN_LABEL].map(m => [m, 0]))]));
    let correct = 0;
    this.examples.forEach((e, i) => {
      const p = this.predictPrepared(e, i);
      confusion[e.label][p.label] = (confusion[e.label][p.label] || 0) + 1;
      if (p.label === e.label) correct++;
    });
    return { accuracy: this.examples.length ? correct / this.examples.length : 0, n: this.examples.length, confusion, labels };
  }
}

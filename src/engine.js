// Decision layer between "the classifier thinks it saw X" and "the computer does Y".
// Guards against the Midas-touch problem (every glance or blink triggering something):
//   * the rest label and rejected segments never fire;
//   * a refractory period blocks a second command right after the first;
//   * while paused, only the gesture mapped to "pause/resume" is honoured, so the person can always
//     switch the system back on by themselves.
import { REST_LABEL, UNKNOWN_LABEL } from './classifier.js';

export const DEFAULT_ENGINE_SETTINGS = {
  refractoryMs: 700,
  minMargin: 0,   // optional extra confidence requirement (distance gap to the second-best class)
};

export const PAUSE_ACTION = 'togglePause';

export class GestureEngine {
  constructor(settings = {}) {
    this.settings = { ...DEFAULT_ENGINE_SETTINGS, ...settings };
    this.paused = false;
    this.lastFireT = -Infinity;
  }

  /**
   * @param prediction classifier output { label, margin }
   * @param mapping { [gestureLabel]: actionId }
   * @param t timestamp in ms
   * @returns { fired: boolean, action?: string, reason: string }
   */
  decide(prediction, mapping, t) {
    const { label, margin } = prediction;
    if (label === REST_LABEL) return { fired: false, reason: '自然动作，忽略' };
    if (label === UNKNOWN_LABEL) return { fired: false, reason: '不像任何已录动作，拒识' };
    if (margin < this.settings.minMargin) return { fired: false, reason: '置信度不足' };
    const action = mapping[label];
    if (!action) return { fired: false, reason: `「${label}」未映射到操作` };
    if (this.paused && action !== PAUSE_ACTION) return { fired: false, reason: '已暂停（只响应暂停/恢复）' };
    if (t - this.lastFireT < this.settings.refractoryMs) return { fired: false, reason: '冷却中' };
    this.lastFireT = t;
    if (action === PAUSE_ACTION) this.paused = !this.paused;
    return { fired: true, action, reason: '' };
  }
}

// Musical time: snap an event to the next grid point so webcam latency (~100–250 ms, estimated)
// becomes "lands on the next beat" instead of "sounds late".
export function nextGridTime(now, startTime, bpm, subdivision = 2) {
  const step = 60 / bpm / subdivision; // seconds per grid slot (subdivision 2 = eighth notes)
  if (now <= startTime) return startTime;
  const k = Math.ceil((now - startTime) / step - 1e-9);
  return startTime + k * step;
}

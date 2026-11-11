// Five fixed track slots, each occupying 20 slider units.
export const MAX_TRACKS = 5;
export const TRACK_VALUE_STEP = 20;

export function trackIndexForValue(value, count) {
  if (!Number.isInteger(count) || count < 1 || count > MAX_TRACKS) return -1;
  const bounded = Math.max(0, Math.min(100, Number(value) || 0));
  return Math.max(0, Math.min(count - 1, Math.ceil(bounded / TRACK_VALUE_STEP) - 1));
}

export function trackValueForIndex(index, count) {
  if (!Number.isInteger(count) || count < 1 || count > MAX_TRACKS || !Number.isInteger(index) || index < 0 || index >= count) return null;
  return index * TRACK_VALUE_STEP + TRACK_VALUE_STEP / 2;
}

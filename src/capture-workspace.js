const CAPTURE_MODES = new Set([
  'calibrating',
  'recording',
  'testing-countdown',
  'testing-window',
  'testing-review',
  'gaze-calibrating',
  'gaze-slider',
]);

// Kept separate from the recognition mode so a whole multi-trial recording can
// stay visually stable while the recorder briefly waits between two windows.
export function captureLayoutForMode(mode) {
  return {
    active: CAPTURE_MODES.has(mode),
    review: mode === 'testing-review',
  };
}

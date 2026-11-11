export class SustainedBlackFrameDetector {
  constructor({ maxLuminance = 2.5, durationMs = 2000, recoveryMs = 800 } = {}) {
    this.maxLuminance = maxLuminance;
    this.durationMs = durationMs;
    this.recoveryMs = recoveryMs;
    this.reset();
  }

  reset() {
    this.blackSince = null;
    this.recoverySince = null;
    this.lastTimestampMs = null;
    this.detected = false;
  }

  update(luminance, timestampMs, { cameraActive = true } = {}) {
    const wasDetected = this.detected;
    if (!cameraActive || !Number.isFinite(luminance) || !Number.isFinite(timestampMs)) {
      this.reset();
      return { detected: false, changed: wasDetected };
    }

    if (this.lastTimestampMs !== null && timestampMs < this.lastTimestampMs) this.reset();
    this.lastTimestampMs = timestampMs;

    if (luminance <= this.maxLuminance) {
      this.blackSince ??= timestampMs;
      this.recoverySince = null;
      if (timestampMs - this.blackSince >= this.durationMs) this.detected = true;
    } else if (this.detected) {
      this.recoverySince ??= timestampMs;
      if (timestampMs - this.recoverySince >= this.recoveryMs) {
        this.detected = false;
        this.blackSince = null;
        this.recoverySince = null;
      }
    } else {
      this.blackSince = null;
      this.recoverySince = null;
    }

    return { detected: this.detected, changed: this.detected !== wasDetected };
  }
}

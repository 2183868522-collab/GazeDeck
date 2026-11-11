// Beat-synced accompaniment controlled by eye gestures (design 1 from the research notes):
// the computer keeps time; eye gestures only decide *what* plays next, never *when*.
// Every triggered sound is snapped to the next eighth-note slot (nextGridTime), so webcam latency turns
// into "lands on the next beat" rather than "sounds late".
// Sound is synthesised with Web Audio (works without any extra software); optionally the same notes are
// sent as MIDI to GarageBand / Logic / Ableton (on macOS enable the IAC Driver in "Audio MIDI Setup").
import { nextGridTime } from './engine.js';

const NOTE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

// "Am" → MIDI notes of a close-voiced triad around middle C. Supports X, Xm, X7, Xm7, with # or b.
export function parseChord(name) {
  const m = /^([A-G])([#b]?)(m?)(7?)$/.exec(name.trim());
  if (!m) return null;
  const root = 60 + NOTE[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
  const notes = [root, root + (m[3] ? 3 : 4), root + 7];
  if (m[4]) notes.push(root + 10); // minor 7th on top for both X7 and Xm7
  return { name, notes };
}

const midiToHz = n => 440 * 2 ** ((n - 69) / 12);

export class BeatBox {
  constructor() {
    this.ctx = null;
    this.playing = false;
    this.bpm = 84;
    this.chords = [parseChord('C')];
    this.chordIndex = 0;
    this.midiOut = null;
    this.volume = 70;
    this.effectIntensity = 50;
    this.masterGain = null;
    this.onBeat = null; // UI callback (beatNumber, chord)
  }

  ensureContext() {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = this.volume / 100;
      this.masterGain.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  setChords(text) {
    const parsed = text.split(/\s+/).filter(Boolean).map(parseChord).filter(Boolean);
    if (parsed.length) { this.chords = parsed; this.chordIndex %= parsed.length; }
    return parsed.length;
  }

  get chord() { return this.chords[this.chordIndex]; }

  setVolume(value) {
    this.volume = Math.max(0, Math.min(100, Number(value)));
    if (this.masterGain) this.masterGain.gain.setTargetAtTime(this.volume / 100, this.ctx.currentTime, 0.02);
  }

  setEffectIntensity(value) { this.effectIntensity = Math.max(0, Math.min(100, Number(value))); }

  start() {
    const ctx = this.ensureContext();
    this.playing = true;
    this.startTime = ctx.currentTime + 0.1;
    this.nextBeat = 0;
    this.timer = setInterval(() => this.schedule(), 25); // look-ahead scheduler
  }

  stop() {
    this.playing = false;
    clearInterval(this.timer);
    this.sendMidiAllOff();
  }

  toggle() { this.playing ? this.stop() : this.start(); }

  // Schedule beats up to 120 ms ahead; Web Audio then plays them sample-accurately.
  schedule() {
    const spb = 60 / this.bpm;
    while (this.startTime + this.nextBeat * spb < this.ctx.currentTime + 0.12) {
      const t = this.startTime + this.nextBeat * spb;
      const beatInBar = this.nextBeat % 4;
      this.kick(t, beatInBar === 0 ? 1 : 0.6);
      this.hat(t + spb / 2);
      if (beatInBar === 0) this.pad(t, spb * 4);
      const n = this.nextBeat, chord = this.chord;
      setTimeout(() => this.onBeat?.(n, chord), Math.max(0, (t - this.ctx.currentTime) * 1000));
      this.nextBeat++;
    }
  }

  // The pad normally sounds once per bar; waiting for the next bar would make the chord change feel
  // unresponsive, so we also re-voice it on the next eighth note.
  changeChord(delta) {
    this.chordIndex = (this.chordIndex + delta + this.chords.length) % this.chords.length;
    if (this.playing) this.pad(this.gridTime(), 60 / this.bpm * 2, 0.5);
  }

  accent() {
    this.accentCount = (this.accentCount || 0) + 1; // lets tests confirm the gesture reached the music engine
    const ctx = this.ensureContext();
    const t = this.playing ? this.gridTime() : ctx.currentTime;
    const top = this.chord.notes[this.chord.notes.length - 1] + 12;
    this.tone(midiToHz(top), t, 0.35, 'triangle', 0.06 + 0.28 * this.effectIntensity / 100);
    this.sendMidi(top, t, 0.35, 100);
  }

  gridTime() { return nextGridTime(this.ctx.currentTime + 0.01, this.startTime, this.bpm, 2); }

  // ---- tiny synthesiser ----
  tone(freq, t, dur, type = 'sine', gain = 0.12) {
    const ctx = this.ctx, o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.masterGain);
    o.start(t); o.stop(t + dur + 0.05);
  }

  pad(t, dur, gain = 0.07) {
    for (const n of this.chord.notes) { this.tone(midiToHz(n - 12), t, dur, 'sine', gain); this.sendMidi(n - 12, t, dur * 0.95, 70); }
  }

  kick(t, level) {
    const ctx = this.ctx, o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    g.gain.setValueAtTime(0.5 * level, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    o.connect(g).connect(this.masterGain);
    o.start(t); o.stop(t + 0.2);
  }

  hat(t) {
    const ctx = this.ctx, len = Math.floor(ctx.sampleRate * 0.04);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource(), hp = ctx.createBiquadFilter(), g = ctx.createGain();
    hp.type = 'highpass'; hp.frequency.value = 7000; g.gain.value = 0.08;
    src.buffer = buf; src.connect(hp).connect(g).connect(this.masterGain);
    src.start(t);
  }

  // ---- MIDI (optional) ----
  sendMidi(note, t, dur, velocity) {
    if (!this.midiOut) return;
    // Convert AudioContext time to performance.now() time base used by Web MIDI.
    const at = performance.now() + (t - this.ctx.currentTime) * 1000;
    this.midiOut.send([0x90, note, velocity], at);
    this.midiOut.send([0x80, note, 0], at + dur * 1000);
  }

  sendMidiAllOff() { this.midiOut?.send([0xB0, 123, 0]); }
}

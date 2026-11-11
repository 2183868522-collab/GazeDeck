const BIN_COUNT = 256;
const ANALYSIS_RATE = 16000;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_DURATION_SECONDS = 12 * 60;
const MAX_PCM_SAMPLES = 24 * 1024 * 1024;
let decodeQueue = Promise.resolve();

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));
const positive = value => Number.isFinite(value) && value > 0;

function formatTime(seconds) {
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

async function readDuration(file, signal) {
  const media = new Audio();
  const url = URL.createObjectURL(file);
  let timeout;
  let abort;
  try {
    return await new Promise((resolve, reject) => {
      abort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      if (signal?.aborted) { abort(); return; }
      signal?.addEventListener('abort', abort, { once: true });
      media.preload = 'metadata';
      media.onloadedmetadata = () => resolve(media.duration);
      media.onerror = () => reject(new Error('无法读取音频时长'));
      timeout = setTimeout(() => reject(new Error('读取音频时长超时')), 8000);
      media.src = url;
    });
  } finally {
    clearTimeout(timeout);
    if (abort) signal?.removeEventListener('abort', abort);
    media.onloadedmetadata = null;
    media.onerror = null;
    media.removeAttribute('src');
    media.load();
    URL.revokeObjectURL(url);
  }
}

function decodedPeaks(buffer) {
  const { length, numberOfChannels, sampleRate } = buffer;
  if (!Number.isSafeInteger(length) || length <= 0 || !positive(sampleRate)
      || !Number.isSafeInteger(numberOfChannels) || numberOfChannels <= 0
      || length * numberOfChannels > MAX_PCM_SAMPLES || length / sampleRate > MAX_DURATION_SECONDS + 1) {
    throw new Error('解码后的音频超出波形分析范围');
  }
  const channels = Array.from({ length: numberOfChannels }, (_, index) => buffer.getChannelData(index));
  const peaks = Array.from({ length: BIN_COUNT }, (_, index) => {
    const first = Math.floor(index * length / BIN_COUNT);
    const end = Math.max(first + 1, Math.floor((index + 1) * length / BIN_COUNT));
    let minimum = Infinity;
    let maximum = -Infinity;
    for (const channel of channels) {
      for (let sampleIndex = first; sampleIndex < end; sampleIndex++) {
        const sample = channel[sampleIndex];
        if (Number.isFinite(sample)) {
          minimum = Math.min(minimum, sample);
          maximum = Math.max(maximum, sample);
        }
      }
    }
    return minimum === Infinity ? [0, 0] : [minimum, maximum];
  });
  return { sampleRate, lengthSamples: length, durationSeconds: length / sampleRate, peaks };
}

async function analyzeFile(file, signal) {
  signal?.throwIfAborted();
  const duration = await readDuration(file, signal);
  signal?.throwIfAborted();
  if (!positive(duration) || duration > MAX_DURATION_SECONDS) throw new Error('音频时长超出波形分析范围');

  // The offline decoder has no playback destination connected to the speakers.
  const context = typeof OfflineAudioContext === 'function'
    ? new OfflineAudioContext(1, 1, ANALYSIS_RATE)
    : new AudioContext({ sampleRate: ANALYSIS_RATE });
  try {
    const bytes = await file.arrayBuffer();
    signal?.throwIfAborted();
    const buffer = await context.decodeAudioData(bytes);
    signal?.throwIfAborted();
    return decodedPeaks(buffer);
  } finally {
    if (typeof context.close === 'function') {
      try { await context.close(); } catch { /* Already closed. */ }
    }
  }
}

export async function readLocalWaveform(file, { signal } = {}) {
  if (!positive(file?.size) || file.size > MAX_FILE_BYTES || typeof file.arrayBuffer !== 'function') {
    throw new Error('文件大小超出波形分析范围');
  }
  // Keep a library import from decoding several full audio buffers at once.
  const work = decodeQueue.then(() => analyzeFile(file, signal));
  decodeQueue = work.catch(() => {});
  return work;
}

function demoPeaks(track, deck) {
  let seed = deck === 'A' ? 2166136261 : 1103515245;
  for (const character of String(track.name ?? '')) {
    seed = Math.imul(seed ^ character.codePointAt(0), 16777619) >>> 0;
  }
  return Array.from({ length: BIN_COUNT }, (_, index) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const part = index / BIN_COUNT;
    const taper = Math.min(1, part * 20, (1 - part) * 20);
    const section = 0.23 + 0.43 * Math.abs(Math.sin(part * 14 + (deck === 'A' ? 0 : 1)));
    const amplitude = (0.38 + seed / 4294967296 * 0.62) * section * taper;
    return [-amplitude * 0.94, amplitude];
  });
}

function graphPath(peaks) {
  const coordinate = (value, index) => `${(index * 1000 / (peaks.length - 1)).toFixed(1)} ${(38 - Math.max(-1, Math.min(1, value)) * 21).toFixed(1)}`;
  const high = peaks.map((peak, index) => coordinate(peak[1], index));
  const low = peaks.map((peak, index) => coordinate(peak[0], index)).reverse();
  return `M${high.join('L')}L${low.join('L')}Z`;
}

function playheadX(position, duration) {
  const seconds = Number.isFinite(position) ? Math.min(duration, Math.max(0, position)) : 0;
  return (seconds / duration * 1000).toFixed(2);
}

export function demoWaveformMarkup(track, deck, lane) {
  const safeDeck = deck === 'B' ? 'B' : 'A';
  const color = safeDeck === 'A' ? '#36e3c3' : '#d995fa';
  const duration = track?.demo ? track.duration : track?.waveform?.durationSeconds;
  const peaks = track?.demo ? demoPeaks(track, safeDeck) : track?.waveform?.peaks;
  const base = `class="sc-waveform" data-demo-waveform="${safeDeck}"`;
  if (!positive(duration) || !Array.isArray(peaks) || peaks.length < 2 || peaks.length > BIN_COUNT
      || peaks.some(peak => !Array.isArray(peak) || peak.length !== 2 || !peak.every(Number.isFinite) || peak[0] > peak[1])) {
    const status = !track ? '未装载曲目' : track.waveformPending ? '正在读取本地波形…' : '本地波形暂不可用';
    return `<div ${base}><p class="sc-waveform-unavailable" role="status">${status}</p></div>`;
  }
  const label = track.demo ? '演示波形' : '本地素材包络';
  const title = track.name || '未命名曲目';
  const grid = [0, 250, 500, 750, 1000].map((x, index) => {
    const anchor = index === 0 ? 'start' : index === 4 ? 'end' : 'middle';
    return `<line x1="${x}" x2="${x}" y1="12" y2="61" stroke="#8393ac" stroke-opacity=".22" vector-effect="non-scaling-stroke"/><text x="${x}" y="78" fill="#91a6bf" text-anchor="${anchor}" font-size="14">${formatTime(duration * index / 4)}</text>`;
  }).join('');
  return `<div ${base} data-demo-duration="${duration}"><div class="sc-waveform-summary" style="display:flex;gap:8px;align-items:baseline;font-size:10px;text-align:left;min-width:0"><strong style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1" title="${escape(title)}">${escape(title)}</strong><span>${label}</span></div>
    <svg class="sc-waveform-svg" viewBox="0 0 1000 82" preserveAspectRatio="none" role="img" aria-label="Deck ${safeDeck} ${label}，${formatTime(duration)}" style="display:block;width:100%;height:70px;overflow:hidden;background:#111f34;border-radius:4px">
      ${grid}<line x1="0" x2="1000" y1="38" y2="38" stroke="${color}" stroke-opacity=".25" vector-effect="non-scaling-stroke"/>
      <path data-waveform-envelope="" d="${graphPath(peaks)}" fill="${color}" fill-opacity=".83"/>
      <line data-demo-waveform-playhead="" transform="translate(${playheadX(lane?.position, duration)} 0)" x1="0" x2="0" y1="9" y2="62" stroke="#ffc571" stroke-width="2" vector-effect="non-scaling-stroke"/>
    </svg></div>`;
}

export function updateDemoWaveformMarkers(root, decks) {
  for (const host of root.querySelectorAll('[data-demo-waveform]')) {
    const duration = Number(host.dataset.demoDuration);
    const lane = decks[host.dataset.demoWaveform];
    if (!lane || !positive(duration)) continue;
    const playhead = host.querySelector('[data-demo-waveform-playhead]');
    playhead?.setAttribute('transform', `translate(${playheadX(lane.position, duration)} 0)`);
  }
}

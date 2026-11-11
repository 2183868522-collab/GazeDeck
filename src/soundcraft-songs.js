import { SoundCraftClientError } from './soundcraft-client.js';
import { GazeSliderController } from './gaze-slider.js';

const path = '/api/soundcraft/library';
const maxFiles = 5;
const maxBytes = 128 * 1024 * 1024;
export const songFileTypes = '.wav,.mp3,.flac,.aiff,.aif,.m4a,.aac,.ogg,.caf';
const sizeLabel = bytes => `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
const durationLabel = seconds => Number.isFinite(seconds) && seconds > 0
  ? `${seconds.toFixed(1).replace(/\.0$/, '')} 秒` : '未知';
const bpmLabel = value => Number.isFinite(value) && value > 0 && value <= 1000
  ? String(Number(value.toFixed(1))) : '未知';
const keyLabel = value => typeof value === 'string' && value.trim() ? value.trim() : '未知';
const songMetadata = song => `时长 ${durationLabel(song.durationSeconds)} · BPM ${bpmLabel(song.bpm)} · Key ${keyLabel(song.key)}`;
const escape = value => String(value).replace(/[&<>"']/g, ch => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[ch]));

export function validLibrarySong(song) {
  return song && typeof song.id === 'string' && song.id.length > 0 && song.id.length <= 128
    && typeof song.name === 'string' && song.name.length > 0 && song.name.length <= 255
    && Number.isSafeInteger(song.size) && song.size > 0 && song.size <= maxBytes
    && (song.durationSeconds === undefined || Number.isFinite(song.durationSeconds) && song.durationSeconds > 0);
}

export const songNameKey = name => String(name ?? '').replace(/\.(wav|mp3|flac|aiff|aif|m4a|aac|ogg|caf)$/i, '')
  .normalize('NFKC').trim().toLocaleLowerCase();

// SoundCraft's imported source and the optional web-library copy are one choice.
// Keep the project source so loading does not depend on a second audio copy.
export function mergeSongCandidates(projectSources, importedSongs) {
  const importedByName = new Map(importedSongs.map(song => [songNameKey(song.name), song]));
  const seen = new Set(), choices = [];
  for (const source of projectSources) {
    const key = songNameKey(source.name);
    if (!key || seen.has(key)) continue;
    const extension = String(source.path ?? '').match(/\.[^./\\]+$/)?.[0] || '';
    const displayName = importedByName.get(key)?.name ||
      (extension && !source.name.toLowerCase().endsWith(extension.toLowerCase()) ? source.name + extension : source.name);
    const imported = importedByName.get(key);
    choices.push({ ...source, displayName,
      durationSeconds: source.durationSeconds ?? imported?.durationSeconds,
      bpm: source.bpm ?? imported?.bpm, key: source.key ?? imported?.key });
    seen.add(key);
  }
  for (const song of importedSongs) {
    const key = songNameKey(song.name);
    if (!key || seen.has(key)) continue;
    choices.push({ ...song, displayName: song.name });
    seen.add(key);
  }
  return choices;
}

export class SoundCraftSongLibrary {
  constructor(fetchImpl = globalThis.fetch) {
    this.fetchImpl = fetchImpl.bind(globalThis);
  }

  async request(url, options, signal, timeout = 8000) {
    const timeoutSignal = AbortSignal.timeout(timeout);
    const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    let response;
    try {
      response = await this.fetchImpl(url, { ...options, cache: 'no-store', signal:requestSignal });
    } catch (error) {
      if (requestSignal.aborted) throw requestSignal.reason;
      throw new SoundCraftClientError('network_error', '无法读取 SoundCraft 曲库，请检查 serve.py 是否运行');
    }
    let payload;
    try { payload = await response.json(); }
    catch { throw new SoundCraftClientError('invalid_reply', '曲库接口没有返回有效数据，请重启新版 serve.py'); }
    if (!response.ok || payload?.ok !== true) {
      throw new SoundCraftClientError(payload?.error?.code || 'library_error',
        payload?.error?.message || '曲库请求失败，请检查本机网页服务');
    }
    const songs = payload.result?.songs;
    if (!Array.isArray(songs) || songs.length > maxFiles || songs.some(song => !validLibrarySong(song))
      || new Set(songs.map(song => song.id)).size !== songs.length) {
      throw new SoundCraftClientError('invalid_reply', '曲库回执无效，请刷新曲库');
    }
    return songs;
  }

  list(signal) {
    return this.request(path, {}, signal);
  }

  upload(file, signal) {
    const suffix = file.name.toLowerCase().match(/\.[^.]+$/)?.[0];
    if (!songFileTypes.split(',').includes(suffix)) throw new Error('当前格式不受支持');
    if (!file.size || file.size > maxBytes) throw new Error('文件为空或超过 128 MiB');
    return this.request(path, {
      method: 'POST', headers: {
        'Content-Type': 'application/octet-stream',
        'X-GazeDeck-Filename': encodeURIComponent(file.name),
      },
      body: file,
    }, signal, 90000);
  }

  remove(id, signal) {
    return this.request('/api/soundcraft', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'REMOVE_LIBRARY_SONG', params: { id } }),
    }, signal);
  }
}

function displayError(error) {
  if (error?.name === 'TimeoutError') return '曲库请求超时，请刷新列表后核对';
  return error?.message || '曲库请求失败，请检查本机网页服务';
}

export function mountSoundCraftSongLibrary(root, { library }) {
  let songs = [], operation = null;
  const q = id => root.querySelector(`#${id}`);
  root.innerHTML = `<h3>SoundCraft 曲库</h3>
    <p class="muted">当前 SoundCraft 工程中的音轨素材可直接在「曲目与播放管理」换入 A 或 B。也可额外导入最多 5 首本机音频，每首不超过 128 MiB。</p>
    <div class="row"><label class="file-btn">导入 SoundCraft 曲目<input id="scSongFiles" type="file" multiple accept="${songFileTypes}"></label>
      <button type="button" id="scSongsRefresh">刷新 SoundCraft 曲库</button></div>
    <p id="scSongsStatus" role="status">打开曲库时读取已导入曲目。</p>
    <ol id="scSongsCatalog" class="deck-track-options"></ol>`;

  function render(message) {
    const busy = operation !== null;
    q('scSongsStatus').textContent = message || (songs.length ? `已导入 ${songs.length} / ${maxFiles} 首。` : '曲库暂为空。');
    q('scSongsRefresh').disabled = busy;
    q('scSongFiles').disabled = busy || songs.length >= maxFiles;
    q('scSongsCatalog').innerHTML = songs.map((song, index) =>
      `<li class="row"><span>${escape(song.name)} · ${sizeLabel(song.size)} · ${escape(songMetadata(song))}</span><button type="button" data-sc-song-remove="${index}" ${busy ? 'disabled' : ''}>移出曲库</button></li>`).join('');
  }

  async function run(message, task) {
    if (operation) return;
    const controller = new AbortController();
    operation = controller;
    render(message);
    let finalMessage;
    const update = value => { if (operation === controller) songs = value; };
    try { finalMessage = await task(controller.signal, update); }
    catch (error) { finalMessage = displayError(error); }
    finally {
      if (operation === controller) { operation = null; render(finalMessage); }
    }
  }

  function read() {
    return run('正在读取 SoundCraft 曲库…', async (signal, update) => { update(await library.list(signal)); });
  }

  root.onchange = event => {
    if (event.target.id !== 'scSongFiles') return;
    const files = [...event.target.files];
    event.target.value = '';
    if (!files.length) return;
    void run('正在核对曲库空间…', async (signal, update) => {
      const current = await library.list(signal);
      update(current);
      if (files.length > maxFiles - current.length) return `曲库已存 ${current.length} 首，请选择最多 ${maxFiles - current.length} 个文件，或先移出曲库条目。`;
      let imported = 0;
      const errors = [];
      for (const [index, file] of files.entries()) {
        if (signal.aborted) return;
        render(`正在导入 ${index + 1}/${files.length}：${file.name}`);
        try {
          update(await library.upload(file, signal));
          imported++;
        } catch (error) { if (!signal.aborted) errors.push(`${file.name}：${displayError(error)}`); }
      }
      return `已导入 ${imported} / ${files.length} 首。${errors.length ? ' ' + errors.join(' · ') : ''}`;
    });
  };
  root.onclick = event => {
    const button = event.target.closest('button');
    if (!button || button.disabled) return;
    if (button.id === 'scSongsRefresh') { event.stopPropagation?.(); void read(); }
    else if (button.dataset.scSongRemove !== undefined) {
      event.stopPropagation?.();
      const song = songs[Number(button.dataset.scSongRemove)];
      if (song) void run('正在移出曲库…', async (signal, update) => {
        update(await library.remove(song.id, signal));
        return `已将「${song.name}」移出曲库。SoundCraft 工程可继续使用已加载的音频副本。`;
      });
    }
  };
  return {
    read,
    stop() { operation?.abort(); operation = null; render('打开曲库时重新读取已导入曲目。'); },
  };
}

const songIndexForValue = (value, count) => Math.max(0, Math.min(count - 1, Math.ceil(value / 20) - 1));
const songValueForIndex = index => index * 20 + 10;

export function mountSoundCraftSongPicker(root, { load, readiness, environment, eyeReady, onResult, onClose, now = () => performance.now() }) {
  let session = null;
  const q = id => root.querySelector(`#${id}`);
  root.innerHTML = `<div class="sc-volume-card sc-song-card">
    <div class="gaze-slider-heading"><div><span class="eyebrow">连续控制 · SoundCraft 真实曲目</span>
      <h2>选择曲目</h2><p id="scSongTarget" class="muted"></p></div>
      <div class="sc-song-heading-right"><button type="button" id="scSongCancel">取消</button></div></div>
    <div class="gaze-zones"><button type="button" id="scSongPrev">◀ 减少</button><span>中央停止</span>
      <button type="button" id="scSongNext">增加 ▶</button></div>
    <div class="gaze-value-track"><div aria-hidden="true"></div><i aria-hidden="true"></i><strong id="scSongValue" class="gaze-slider-thumb-value"></strong></div>
    <ol id="scSongOptions" class="gaze-track-list" aria-label="SoundCraft 可选曲目"></ol>
    <p id="scSongStatus" class="gaze-slider-state" role="status" aria-live="polite"></p>
    <p class="muted sc-song-help">向左看选前一首，向右看选后一首，回到中央停止；上看恢复打开时的选择，下看装载所选曲目并关闭。关闭前仅预选；播放中的 Deck 换曲后从开头继续播放，暂停的 Deck 继续暂停。BPM 和 Key 无可靠来源时显示未知。</p>
    <div class="gaze-slider-buttons"><button type="button" id="scSongRestore">上看 · 恢复打开时选择</button>
      <button type="button" id="scSongConfirm" class="primary">下看 · 载入并关闭</button></div>
    <div class="sc-song-extra"><button type="button" id="scSongObserve">进入观察模式</button></div>
  </div>`;

  function render() {
    const s = session;
    root.classList.toggle('hidden', !s);
    if (!s) return;
    const locked = s.busy || s.observing || s.failed;
    q('scSongTarget').textContent = `目标 Deck ${s.deck} · ${s.trackName} · 轨道 ID ${s.track}`;
    q('scSongValue').textContent = `曲目 ${s.index + 1}/${s.songs.length}`;
    root.style.setProperty('--slider-position', `${100 * s.value / (s.songs.length * 20)}%`);
    for (const [index, row] of [...q('scSongOptions').children].entries()) {
      row.classList.toggle('active', index === s.index);
      row.querySelector('button').setAttribute('aria-pressed', String(index === s.index));
      row.querySelector('button').disabled = locked;
      if (index === s.index && s.lastRenderedIndex !== index) {
        const list = q('scSongOptions');
        const outer = list.getBoundingClientRect(), inner = row.getBoundingClientRect();
        if (inner.top < outer.top) list.scrollTop += inner.top - outer.top;
        else if (inner.bottom > outer.bottom) list.scrollTop += inner.bottom - outer.bottom;
      }
    }
    s.lastRenderedIndex = s.index;
    const zone = { center:'中央停止区 · 选择保持不变', 'left-wait':'保持向左注视…',
      'right-wait':'保持向右注视…', left:'正在选择前一首', right:'正在选择后一首',
      lost:'未检测到有效视线，连续选曲已暂停' }[s.zone] || '中央停止区 · 选择保持不变';
    q('scSongStatus').textContent = s.message || (s.observing ? '观察模式：选曲已冻结，长眨恢复' : zone);
    for (const id of ['scSongPrev', 'scSongNext']) q(id).disabled = locked || s.songs.length < 2;
    q('scSongRestore').disabled = locked;
    q('scSongConfirm').disabled = locked;
    q('scSongCancel').disabled = s.busy;
    q('scSongObserve').disabled = s.busy || s.failed;
    q('scSongObserve').textContent = s.observing ? '恢复选曲' : '进入观察模式';
  }

  function close() { session = null; render(); onClose?.(); }

  function select(s, index) {
    s.index = Math.max(0, Math.min(s.songs.length - 1, index));
    s.value = songValueForIndex(s.index);
    s.controller?.pause(s.lastFeatureTime);
    if (s.controller) s.controller.value = s.value;
    s.zone = 'center';
    s.message = '';
    render();
  }

  async function gesture(action, source = '手动控制', note = '') {
    const s = session;
    if (!s || s.busy) return;
    const report = (message, executed = false) => onResult?.(action, note + message, executed, source);
    if (action === '双眨') {
      report(s.failed ? '已关闭换曲弹窗，请核对当前曲目' : '已取消换曲', true);
      close();
      return;
    }
    if (source === '眼动识别' && !eyeReady()) {
      s.message = '当前人脸或静息校准未就绪。';
      report(s.message); render(); return;
    }
    if (s.failed) { report('换曲结果未确认，请关闭弹窗并重新连接核对。'); return; }
    if (action === '长眨') {
      s.observing = !s.observing;
      s.controller?.pause(s.lastFeatureTime);
      s.message = '';
      report(s.observing ? '已进入观察模式，选曲暂停' : '已恢复选曲', true);
      render(); return;
    }
    if (s.observing) return;
    if (action === '上看') { select(s, s.initialIndex); report('已恢复打开时的曲目选择，弹窗保持打开', true); return; }
    if (action === '左看' || action === '右看') {
      // Raw gaze frames drive continuous selection; classified horizontal gestures
      // must not add an extra step on top of the same eye movement.
      if (source !== '眼动识别') select(s, s.index + (action === '左看' ? -1 : 1));
      return;
    }
    if (action !== '下看') return;
    const issue = readiness(s);
    if (issue) { s.message = issue; report(issue); render(); return; }
    const song = s.songs[s.index];
    s.busy = true; s.message = 'SoundCraft 正在载入并核对新曲目…'; render();
    try {
      const loaded = await load(s, song, source);
      if (session !== s) return;
      report(`Deck ${s.deck} 已换为「${loaded.song.name}」，时长 ${loaded.durationSeconds.toFixed(1)} 秒，${loaded.paused ? '保持暂停' : '从开头继续播放'}`, true);
      close();
    } catch (error) {
      if (session !== s) return;
      s.busy = false; s.failed = !!error.mayHaveExecuted;
      s.message = `${error.message}${s.failed ? '。请重新连接核对当前曲目。' : ''}`;
      report(s.message); render();
    }
  }

  root.onclick = event => {
    const button = event.target.closest('button');
    if (!button || button.disabled || !session) return;
    const action = { scSongPrev: '左看', scSongNext: '右看', scSongRestore: '上看',
      scSongCancel: '双眨', scSongConfirm: '下看', scSongObserve: '长眨' }[button.id];
    if (action) {
      event.stopPropagation?.();
      if (action === '下看' && event.detail > 1) return;
      void gesture(action);
    }
    else if (button.dataset.scSongIndex !== undefined && !session.busy && !session.observing && !session.failed) {
      event.stopPropagation?.();
      select(session, Number(button.dataset.scSongIndex));
      q('scSongConfirm').focus?.();
    }
  };
  root.addEventListener('keydown', event => {
    if (event.key === 'Escape' && session) { event.preventDefault(); void gesture('双眨'); }
    if (event.key === 'Enter' && event.repeat && session) event.preventDefault();
  });
  return {
    isOpen: () => session !== null,
    open(target, songs) {
      if (session || !songs.length) return false;
      const initialIndex = Math.max(0, Math.min(songs.length - 1, target.initialIndex ?? 0));
      const e = environment();
      const value = songValueForIndex(initialIndex);
      const rows = songs.map((song, index) => {
        const row = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.scSongIndex = String(index);
        const title = document.createElement('span');
        title.textContent = `${index + 1}. ${song.displayName || song.name}（滑块 ${index * 20 + 1}–${(index + 1) * 20}）`;
        const metadata = document.createElement('small');
        metadata.className = 'sc-song-metadata';
        metadata.textContent = songMetadata(song);
        button.append(title, metadata);
        row.append(button);
        return row;
      });
      q('scSongOptions').replaceChildren(...rows);
      session = { ...target, songs, index: initialIndex, initialIndex, value, calibration: e.calibration,
        controller: e.calibration && e.sliderSettings?.enabled !== false
          ? new GazeSliderController(e.calibration, e.sliderSettings,
            {min: 0, max: songs.length * 20, initialValue: value}) : null,
        zone: 'center', message: '', lastFeatureTime: null, lastRenderedIndex: -1,
        busy: false, failed: false, observing: false, openedAt: now() };
      render();
      q('scSongConfirm').focus?.();
      return true;
    },
    gesture,
    frame(raw, t = now()) {
      const s = session;
      if (!s || s.busy || s.failed || !s.controller) return;
      s.lastFeatureTime = t;
      const e = environment();
      const active = raw && !s.observing && e.calibration === s.calibration && eyeReady();
      const next = active ? s.controller.updateFrame(raw, t) : s.controller.pause(t);
      const zone = s.observing ? 'center' : next.zone;
      const index = songIndexForValue(next.value, s.songs.length);
      if (index !== s.index || zone !== s.zone || Math.abs(next.value - s.value) >= .25) {
        s.index = index; s.value = next.value; s.zone = zone; s.message = '';
        render();
      }
    },
    tick() {
      if (session && !session.busy && now() - session.openedAt > 120000) close();
    },
    detach() { if (session) close(); },
  };
}

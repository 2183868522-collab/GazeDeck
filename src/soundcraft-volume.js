import { GazeSliderController, gazeSignal } from './gaze-slider.js';

const MIN_DB = -144, MAX_DB = 12;
export const dbToVolumeFader = db => db <= MIN_DB ? 0 : 100 * 10 ** (db / 20);
export const volumeFaderToDb = value => value <= 0 ? MIN_DB : Math.max(MIN_DB, Math.min(MAX_DB, 20 * Math.log10(value / 100)));
const rounded = db => Math.round(db * 10) / 10;
const format = db => `${db > 0 ? '+' : ''}${db.toFixed(1)} dB`;

// The popup owns a single real track. Fader units are linear gain percentage points;
// the engine receives dB. 100 points = unity (0 dB), and zero = engine silence.
export function mountSoundCraftVolume(root, { client, environment, eyesEnabled, onEnableEyes, onResult, onState, onError, now = () => performance.now() }) {
  let session = null, generation = 0;
  const q = id => root.querySelector(`#${id}`);
  root.innerHTML = `<div class="sc-volume-card">
    <span class="eyebrow">SoundCraft · 声音与效果 / Volume · 真实音量</span>
    <h2 id="scLiveTitle"></h2><p id="scLiveOriginal" class="muted"></p>
    <div class="sc-live-values"><div>目标音量<strong id="scLiveTarget"></strong></div><div>实际回读<strong id="scLiveActual"></strong></div></div>
    <input id="scLiveRange" type="range" min="0" max="${dbToVolumeFader(MAX_DB)}" step="0.1" aria-label="SoundCraft 连续音量调节">
    <p id="scLiveStatus" role="status" aria-live="polite"></p>
    <button id="scLiveEnableEyes" class="primary hidden">开启本区眼动真实控制</button>
    <p>左右视线连续调节，回中央停止。上看恢复打开时的值并保持弹窗；下看保留并关闭。长眨观察／恢复，双眨或 Esc 放弃本次调节。</p>
    <div class="row sc-live-actions"><button id="scLiveLess">−1 dB</button><button id="scLiveMore">+1 dB</button><button id="scLiveRestore">上看 · 恢复原值</button><button id="scLiveKeep" class="primary">下看 · 保留并关闭</button><button id="scLiveObserve">观察／恢复</button><button id="scLiveDiscard">放弃调节</button></div>
    <p class="muted">实际数值经 SoundCraft 回读确认后更新。人脸丢失暂停调节；超时恢复打开时的音量。离开控制页面仅停止调节，保留已生效音量，不改变播放时间。</p>
  </div>`;
  function report(gesture, message, executed, source = '手动操作', feedback = true) {
    onResult?.(gesture, { executed, feedback, message, from: 'SoundCraft 音量滑块', to: 'SoundCraft 音量滑块' }, source);
  }
  function readinessIssue(s) {
    const e = environment();
    if (!client.connected) return 'SoundCraft 连接已失效，请关闭弹窗并重新连接';
    if (!eyesEnabled()) return '尚未开启本区眼动真实控制；请点击下方「开启本区眼动真实控制」';
    if (!e.camera) return '摄像头未运行或视频流暂不可用，请在①校准与录制中检查摄像头';
    if (!e.baseline) return '静息校准未就绪，请先完成或选择已有的静息校准环境';
    if (e.sliderSettings?.enabled === false) return '视线滑块已在⑤设置中关闭，请启用「连续滑块控制」';
    if (!e.calibration) return '当前环境的滑块左右标尺未就绪；请在①校准与录制的第4步录制或选择对应校准环境，无需删除动作样本';
    if (e.calibration !== s.calibration || !s.controller) return '滑块校准环境已变化，请关闭后重新打开此弹窗';
    return '';
  }
  function render() {
    const s = session; root.classList.toggle('hidden', !s); if (!s) return;
    q('scLiveTitle').textContent = `「${s.trackName}」连续音量`;
    q('scLiveOriginal').textContent = `固定目标 ID ${s.trackId} · 打开时 ${format(s.original)}`;
    q('scLiveTarget').textContent = format(s.target);
    q('scLiveActual').textContent = `${format(s.confirmed)}${s.error ? '（上次读数）' : ''}`;
    q('scLiveRange').value = dbToVolumeFader(s.target);
    q('scLiveRange').disabled = s.finishing || s.observing || !!s.error;
    q('scLiveStatus').textContent = s.status;
    q('scLiveEnableEyes').classList.toggle('hidden', eyesEnabled() || !onEnableEyes);
    q('scLiveEnableEyes').disabled = s.finishing || !!s.error || !client.connected;
    for (const id of ['scLiveLess', 'scLiveMore', 'scLiveRestore']) q(id).disabled = s.finishing || s.observing || !!s.error;
    q('scLiveKeep').disabled = s.finishing;
    q('scLiveDiscard').disabled = s.finishing;
    q('scLiveObserve').disabled = s.finishing || !!s.error;
    q('scLiveObserve').textContent = s.observing ? '恢复调节' : '进入观察模式';
  }
  function pause(s, message) {
    s.controller?.pause(s.lastFeatureTime); s.stream.dropPending(); s.zone = 'center';
    s.target = s.confirmed; if (s.controller) s.controller.value = dbToVolumeFader(s.confirmed);
    s.status = message; render();
  }
  function pauseForReadiness(s, message) {
    // Missing eye prerequisites must not cancel a mouse-entered volume target.
    if (s.zone === 'manual' && !s.observing) {
      s.controller?.pause(s.lastFeatureTime); s.status = message; render(); return;
    }
    if (s.zone !== 'lost' || s.status !== message) pause(s, message);
    s.zone = 'lost';
  }
  function failed(s, error) {
    if (session !== s) return;
    s.error = error; s.stream.dropPending(); s.controller?.pause(s.lastFeatureTime);
    s.status = `${error.message}${error.mayHaveExecuted ? '；可能已执行，未自动重发，请重新连接核对实际音量' : ''}`;
    onError?.(error); report('音量调节', s.status, false); render();
  }
  function setTarget(s, db, source, gesture) {
    if (session !== s || s.finishing || s.observing || s.error) return;
    const value = rounded(Math.max(MIN_DB, Math.min(MAX_DB, db)));
    if (value === s.target) return;
    s.target = value; s.sources.set(value, {source, gesture});
    if (s.sources.size > 100) s.sources.delete(s.sources.keys().next().value);
    try { s.stream.set(value); s.status = '正在调节；目标值等待 SoundCraft 回读确认…'; }
    catch (error) { failed(s, error); }
    render();
  }
  async function finish(kind, source = '手动操作', note = '') {
    const s = session; if (!s || s.finishing) return;
    if (s.observing && kind !== 'discard') { report(kind === 'restore' ? '上看' : '下看', '观察模式中，请先恢复调节', false, source); return; }
    s.finishing = true; s.controller?.pause(s.lastFeatureTime);
    if (kind !== 'keep') s.stream.dropPending();
    const ticket = generation;
    try {
      if (!s.error) {
        // For keep, send the final displayed target; restore/discard override unsent movement.
        if (kind !== 'keep') {
          s.sources.set(s.original, {source, gesture: kind === 'restore' ? '上看' : '双眨'});
          s.stream.set(s.original);
        }
        s.status = '正在等待最终音量的实际回读…'; render();
        await s.stream.flush();
        if (ticket !== generation || session !== s) return;
        await client.refresh();
        if (ticket !== generation || session !== s) return;
        const actual = client.snapshot.tracks.find(track => track.id === s.trackId)?.volumeDb;
        if (client.snapshot.projectKey !== s.projectKey || !Number.isFinite(actual)) throw new Error('工程或目标音轨已变化，未确认最终音量');
        s.confirmed = actual;
        s.ownsFinal = s.wrote && Math.abs(actual - s.lastWritten) <= .02;
        if (kind !== 'keep' && Math.abs(actual - s.original) > .02) throw new Error('音量已在其他位置变化，未确认恢复原值');
        s.target = s.confirmed;
        if (s.controller) s.controller.value = dbToVolumeFader(s.confirmed);
        if (kind === 'restore') {
          s.status = `${note}已恢复打开时的音量 ${format(s.original)}，弹窗保持打开`;
          report('上看', s.status, true, source); return;
        }
        const message = kind === 'keep' ? `${note}已保留「${s.trackName}」实际音量 ${format(s.confirmed)} 并关闭`
          : `${note}已放弃本次调节，恢复 ${format(s.original)}；播放时间不变`;
        report(kind === 'keep' ? '下看' : '双眨', message, true, source);
      } else report('关闭音量弹窗', '连接异常，已停止调节；最终音量未确认，请重新连接核对', false, source);
      s.committed = kind === 'keep' && !s.error;
      await s.stream.cancel().catch(() => {});
      if (ticket === generation && session === s) { session = null; render(); onState?.(false, s); }
    } catch (error) { failed(s, error); }
    finally { if (session === s) { s.finishing = false; render(); } }
  }
  function observe(source) {
    const s = session; if (!s || s.finishing || s.error) return;
    s.observing = !s.observing;
    pause(s, s.observing ? '观察模式：调节冻结，音乐继续播放' : '已恢复调节，请回中央后重新看向左右');
    report('长眨', s.status, true, source);
  }
  root.onclick = event => {
    const b = event.target.closest('button'); if (!b || b.disabled || !session) return;
    event.stopPropagation?.();
    if (b.id === 'scLiveEnableEyes') {
      onEnableEyes?.();
      pauseForReadiness(session, session.observing ? '观察模式：调节冻结，音乐继续'
        : readinessIssue(session) || '眼动真实控制已开启；请看向中央，再看向左右调节');
    }
    else if (b.id === 'scLiveRestore') void finish('restore');
    else if (b.id === 'scLiveKeep') void finish('keep');
    else if (b.id === 'scLiveDiscard') void finish('discard');
    else if (b.id === 'scLiveObserve') observe('手动操作');
    else if (b.id === 'scLiveLess' || b.id === 'scLiveMore') {
      const s = session; s.zone = 'manual';
      setTarget(s, s.target + (b.id === 'scLiveMore' ? 1 : -1), '手动操作', b.textContent);
      if (s.controller) { s.controller.value = dbToVolumeFader(s.target); s.controller.pause(s.lastFeatureTime); }
    }
  };
  root.oninput = event => {
    if (event.target.id !== 'scLiveRange' || !session) return;
    const s = session; s.zone = 'manual'; setTarget(s, volumeFaderToDb(Number(event.target.value)), '手动操作', '鼠标音量滑块');
    if (s.controller) { s.controller.value = dbToVolumeFader(s.target); s.controller.pause(s.lastFeatureTime); }
  };
  root.addEventListener('keydown', event => {
    if (!session) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation?.(); void finish('discard'); }
    if (event.key === 'Tab') {
      const controls = ['scLiveRange', ...(!eyesEnabled() && onEnableEyes ? ['scLiveEnableEyes'] : []), 'scLiveLess','scLiveMore','scLiveRestore','scLiveKeep','scLiveObserve','scLiveDiscard'].map(q).filter(node => !node.disabled);
      if (!controls.length) event.preventDefault();
      else if (event.shiftKey && event.target === controls[0]) { event.preventDefault(); controls.at(-1).focus?.(); }
      else if (!event.shiftKey && event.target === controls.at(-1)) { event.preventDefault(); controls[0].focus?.(); }
    }
  });
  render();
  return {
    isOpen: () => !!session,
    open(trackId) {
      if (session) return false;
      const track = client.snapshot?.tracks.find(item => item.id === trackId);
      if (!client.connected || !track) throw new Error('请先连接并选择有效的 SoundCraft 轨道');
      const e = environment();
      const s = { trackId, trackName: track.name, projectKey: client.snapshot.projectKey, original: track.volumeDb,
        target: track.volumeDb, confirmed: track.volumeDb, calibration: e.calibration, lastFace: -Infinity,
        lastFeatureTime: null, openedAt: now(), zone: 'center', observing: false, finishing: false, error: null, sources: new Map(),
        wrote: false, lastWritten: track.volumeDb,
        status: '左右眼动需开启本区眼动控制并完成当前环境左右标尺校准；也可用鼠标试用。' };
      s.controller = e.calibration ? new GazeSliderController(e.calibration, e.sliderSettings,
        {min: 0, max: dbToVolumeFader(MAX_DB), initialValue: dbToVolumeFader(track.volumeDb)}) : null;
      s.status = readinessIssue(s) || '眼动条件已就绪，等待有效人脸视线；回中央停止调节';
      s.stream = client.createVolumeStream(trackId, {intervalMs:150,
        onConfirmed(snapshot, meta) {
          if (session !== s) return;
          const actual = snapshot.tracks.find(item => item.id === trackId)?.volumeDb;
          if (!Number.isFinite(actual)) return;
          const previous = s.confirmed; s.confirmed = actual;
          s.lastWritten = actual; s.wrote ||= Math.abs(actual - previous) > .02;
          if (s.observing || s.zone === 'center' || s.zone === 'lost') {
            s.target = actual; if (s.controller) s.controller.value = dbToVolumeFader(actual);
          }
          if (!s.finishing) {
            s.status = `「${s.trackName}」实际音量 ${format(actual)} 已确认`;
            const info = s.sources.get(meta?.db ?? rounded(actual));
            if (info && Math.abs(actual - previous) > .02) report(info.gesture, s.status, true, info.source);
          }
          render();
        }, onError: error => failed(s, error),
      });
      generation++; session = s; render(); onState?.(true, s); q('scLiveRange').focus?.(); return true;
    },
    detach() {
      generation++; const s = session; session = null;
      if (s) { s.stream.dropPending(); void s.stream.cancel().catch(() => {}); onState?.(false, s); }
      render();
    },
    gesture(gesture, source, note = '') {
      const s = session; if (!s || s.finishing) return;
      const issue = readinessIssue(s);
      if (source === '眼动识别' && (issue || now() - s.lastFace > 750)) {
        pauseForReadiness(s, issue || '未收到近期有效人脸视线，已暂停眼动调节'); report(gesture, s.status, false, source); return;
      }
      if (gesture === '长眨') observe(source);
      else if (gesture === '上看') return finish('restore', source, note);
      else if (gesture === '下看') return finish('keep', source, note);
      else if (gesture === '双眨') return finish('discard', source, note);
      // Classified horizontal gestures never add a second step to raw-frame control.
    },
    frame(raw, t = now()) {
      const s = session; if (!s || s.finishing || s.error) return;
      s.lastFeatureTime = t;
      const validSignal = raw && gazeSignal(raw, environment().sliderSettings?.headCompensation) !== null;
      s.lastFace = validSignal ? now() : -Infinity;
      const issue = readinessIssue(s);
      if (!validSignal || issue || s.observing) {
        pauseForReadiness(s, s.observing ? '观察模式：调节冻结，音乐继续' : issue || (!raw
          ? '未检测到人脸，已暂停眼动调节'
          : '已收到人脸数据，但本帧虹膜信号无效，已暂停眼动调节'));
        return;
      }
      const next = s.controller.updateFrame(raw, t), manual = s.zone === 'manual';
      if (!manual || Math.abs(next.delta) > 0) s.zone = next.zone;
      if (Math.abs(next.delta) > 0) setTarget(s, volumeFaderToDb(next.value), '眼动识别', next.delta > 0 ? '右看' : '左看');
      else if (next.zone === 'center' && !manual) pause(s, '回中央停止调节');
      else if (!manual && ['left-wait', 'right-wait'].includes(next.zone)) {
        s.status = `已检测到有效视线，向${next.zone === 'left-wait' ? '左' : '右'}停留确认中…`; render();
      }
    },
    tick() {
      const s = session; if (!s || s.finishing || s.error) return;
      const issue = readinessIssue(s);
      if (issue) pauseForReadiness(s, issue);
      else if (s.zone !== 'manual' && s.zone !== 'lost' && now() - s.lastFace > 750) pauseForReadiness(s, '画面中断，已暂停调节');
      if (now() - s.openedAt > (environment().sliderSettings?.timeoutMs ?? 20000)) void finish('discard', '系统', '弹窗超时，');
    },
  };
}

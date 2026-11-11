import { GazeSliderController, gazeSignal, normaliseGazePosition } from './gaze-slider.js';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const finite = value => typeof value === 'number' && Number.isFinite(value);
const rounded = value => Math.round(value * 10) / 10;
const seconds = value => `${value > 0 ? '+' : ''}${value.toFixed(1)} 秒`;
const clock = value => `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`;
const LIVE_INTERVAL_MS = 200;
const LIVE_MIN_STEP = .05;

// AB edits a draft and commits a single project seek. An individual Deck sends
// relative movements as the slider is adjusted and displays the engine readback.
export function mountSoundCraftSeek(root, { client, environment, eyesEnabled, onEnableEyes, onResult, onState, onError, onUpdate, now = () => performance.now() }) {
  let session = null, generation = 0;
  const q = id => root.querySelector(`#${id}`);
  root.innerHTML = `<div class="sc-volume-card">
    <span class="eyebrow" id="scSeekScope">SoundCraft · 播放控制 · 工程相对定位</span>
    <h2 id="scSeekTitle">快进／快退</h2><p id="scSeekOriginal" class="muted"></p>
    <div class="sc-live-values"><div><span id="scSeekValueLabel">预览相对偏移</span><strong id="scSeekOffset"></strong></div><div id="scSeekPositionRow" class="hidden">最近回读位置<strong id="scSeekPosition"></strong></div></div>
    <input id="scSeekRange" type="range" step="any" aria-label="SoundCraft 快进快退相对偏移" style="width:100%">
    <p id="scSeekStatus" role="status" aria-live="polite"></p>
    <button id="scSeekEnableEyes" class="primary hidden">开启本区眼动真实控制</button>
    <p id="scSeekInstructions"></p>
    <div class="row sc-live-actions"><button id="scSeekLess">−1 秒</button><button id="scSeekMore">+1 秒</button><button id="scSeekRestore">上看 · 偏移清零</button><button id="scSeekKeep" class="primary">下看 · 执行并关闭</button><button id="scSeekObserve">进入观察模式</button><button id="scSeekDiscard">放弃调节</button></div>
    <p class="muted" id="scSeekDetail"></p>
  </div>`;

  function report(gesture, message, executed, source = '手动操作', feedback = true) {
    onResult?.(gesture, { executed, feedback, message, from: 'SoundCraft 快进快退', to: 'SoundCraft 快进快退' }, source);
  }
  function projectIssue(s) {
    if (!client.connected) return 'SoundCraft 连接已失效，请关闭弹窗并重新连接';
    const snapshot = client.snapshot;
    if (snapshot?.projectKey !== s.projectKey) return 'SoundCraft 工程或轨道已变化，请关闭后重新连接';
    if (!finite(snapshot.durationSeconds) || Math.abs(snapshot.durationSeconds - s.duration) > 1e-6) return '工程长度已变化，请关闭后重新打开快进／快退弹窗';
    if (s.live) {
      const end = snapshot.tracks.find(track => track.id === s.live.target.track)?.seekEndSeconds;
      if (!finite(end) || Math.abs(end - s.endPosition) > 1 / snapshot.sampleRate) {
        return '目标 Deck 的素材长度已变化，请关闭后重新打开快进／快退弹窗';
      }
    }
    return '';
  }
  function readinessIssue(s) {
    const issue = projectIssue(s), e = environment();
    if (issue) return issue;
    if (!eyesEnabled()) return '尚未开启本区眼动真实控制；请点击下方「开启本区眼动真实控制」';
    if (!e.camera) return '摄像头未运行或视频流暂不可用，请检查摄像头';
    if (!e.baseline) return '静息校准未就绪，请先完成或选择已有的静息校准环境';
    if (e.sliderSettings?.enabled === false) return '视线滑块已在⑤设置中关闭，请启用「连续滑块控制」';
    if (!e.calibration) return '当前环境的滑块左右标尺未就绪，请在①校准与录制的第4步完成校准';
    if (e.calibration !== s.calibration || !s.controller) return '滑块校准环境已变化，请关闭后重新打开此弹窗';
    return '';
  }
  function render() {
    const s = session; root.classList.toggle('hidden', !s); if (!s) return;
    q('scSeekScope').textContent = s.live ? 'SoundCraft · 播放控制 · 单轨实时定位' : 'SoundCraft · 播放控制 · 工程相对定位';
    q('scSeekTitle').textContent = `快进／快退 · ${s.live ? 'Deck ' + s.live.deck : '整个工程'}`;
    q('scSeekOriginal').textContent = `工程：${s.projectName} · 打开时${s.live ? '素材' : '工程'}位置 ${clock(s.openingPosition)} · ${s.live ? '素材' : '工程'}长度 ${s.endPosition.toFixed(1)} 秒`;
    q('scSeekValueLabel').textContent = s.live ? '已生效的相对偏移' : '预览相对偏移';
    q('scSeekOffset').textContent = seconds(s.live ? s.applied : s.offset);
    q('scSeekPositionRow').classList.toggle('hidden', !s.live);
    if (s.live) q('scSeekPosition').textContent = `${s.position.toFixed(2)} 秒`;
    q('scSeekInstructions').textContent = s.live
      ? '先看中央，随后左看实时快退，右看实时快进，回中央停止调节。上看撤回本次偏移，下看保留位置并关闭。长眨切换观察模式，双眨或 Esc 撤回并关闭。'
      : '左右视线连续调整偏移，回中央停止。上看恢复为 0 秒并保留弹窗，下看执行一次定位并关闭。长眨观察／恢复，双眨或 Esc 放弃。';
    q('scSeekDetail').textContent = s.live
      ? `以打开时素材位置为基准，可快退 ${(-s.minOffset).toFixed(1)} 秒、快进 ${s.maxOffset.toFixed(1)} 秒；不会预选超过一遍素材的偏移。撤回只抵消调节偏移，保留正常播放时间。`
      : `以打开时工程位置为基准，可快退 ${(-s.minOffset).toFixed(1)} 秒、快进 ${s.maxOffset.toFixed(1)} 秒。预览不定位；下看时仍按实际播放位置及有效选区执行。`;
    q('scSeekKeep').textContent = s.live ? '下看 · 保留并关闭' : '下看 · 执行并关闭';
    q('scSeekRestore').textContent = s.live ? '上看 · 撤回偏移' : '上看 · 偏移清零';
    q('scSeekRange').min = s.minOffset; q('scSeekRange').max = s.maxOffset; q('scSeekRange').value = s.offset;
    q('scSeekRange').disabled = s.finishing || s.observing || !!s.error;
    q('scSeekStatus').textContent = s.status;
    q('scSeekEnableEyes').classList.toggle('hidden', eyesEnabled() || !onEnableEyes);
    q('scSeekEnableEyes').disabled = s.finishing || !!s.error || !client.connected;
    q('scSeekLess').disabled = s.finishing || s.observing || !!s.error || s.offset <= s.minOffset;
    q('scSeekMore').disabled = s.finishing || s.observing || !!s.error || s.offset >= s.maxOffset;
    q('scSeekRestore').disabled = s.finishing || s.observing || !!s.error;
    q('scSeekKeep').disabled = s.finishing;
    q('scSeekDiscard').disabled = s.finishing;
    q('scSeekObserve').disabled = s.finishing || !!s.error;
    q('scSeekObserve').textContent = s.observing ? '恢复调节' : '进入观察模式';
  }
  function pause(s, message) {
    s.controller?.pause(s.lastFeatureTime);
    // Reacquiring a face must start from its new signal, not the old direction's
    // smoothed value. The accumulated relative draft itself remains unchanged.
    if (s.controller) s.controller.smoothed = null;
    if (s.live) {
      s.gazeArmed = false;
      if (s.zone !== 'manual' || s.observing) dropQueued(s);
    }
    s.status = message;
    if (s.zone !== 'manual') s.zone = 'lost';
    render();
  }
  function setOffset(s, value, fromController = false) {
    if (session !== s || s.finishing || s.observing || s.error || !finite(value)) return;
    if (s.live && fromController) {
      const expected = s.applied + s.inFlightOffset;
      s.offset = clamp(clamp(value, expected - 1, expected + 1), s.minOffset, s.maxOffset);
      if (s.controller) s.controller.value = s.offset;
    } else {
      s.offset = clamp(rounded(clamp(value, s.minOffset, s.maxOffset)), s.minOffset, s.maxOffset);
    }
    // Keep the controller's accumulator in the same seconds as the visible draft.
    if (s.controller && !fromController) s.controller.value = s.offset;
    s.status = s.live ? '正在调节所选 Deck' : '仅预览相对偏移，尚未定位；下看时从实际播放位置执行一次';
    if (s.live) pump(s);
    render();
  }
  function clearTimer(s) {
    if (s.timer !== null) clearTimeout(s.timer);
    s.timer = null;
  }
  function dropQueued(s) {
    clearTimer(s);
    s.offset = s.applied + s.inFlightOffset;
    if (s.controller) s.controller.value = clamp(s.offset, s.minOffset, s.maxOffset);
  }
  async function shift(s, offset) {
    s.inFlightOffset = offset;
    s.nextSendAt = now() + LIVE_INTERVAL_MS;
    try {
      const result = await s.live.send(offset);
      if (session !== s) return;
      s.applied += result.deltaSeconds;
      s.position = result.afterSeconds;
      if (Math.abs(result.deltaSeconds - offset) > .001) {
        s.offset = s.applied;
        if (s.controller) s.controller.value = clamp(s.offset, s.minOffset, s.maxOffset);
      }
      s.status = '已收到 SoundCraft 位置回读';
      onUpdate?.();
    } catch (error) {
      failed(s, error);
    } finally {
      s.inFlightOffset = 0;
      s.inFlight = null;
      if (session === s) render();
    }
  }
  function pump(s) {
    if (session !== s || s.finishing || s.observing || s.inFlight || s.error) return;
    if (s.zone !== 'manual' && (!s.gazeArmed || now() - s.lastFace > 750 || readinessIssue(s))) {
      dropQueued(s);
      return;
    }
    const offset = clamp(s.offset - s.applied, -30, 30);
    if (Math.abs(offset) < LIVE_MIN_STEP) return;
    const wait = s.nextSendAt - now();
    if (wait > 0) {
      if (s.timer === null) s.timer = setTimeout(() => { s.timer = null; pump(s); }, wait);
      return;
    }
    clearTimer(s);
    // The event loop always installs inFlight before any asynchronous reply.
    s.inFlight = shift(s, offset);
    void s.inFlight.then(() => pump(s));
  }
  function close(s, committed = false) {
    if (session !== s) return;
    clearTimer(s);
    s.committed = committed; session = null; render(); onState?.(false, s);
  }
  function failed(s, error) {
    if (session !== s) return;
    clearTimer(s);
    s.error = error; s.controller?.pause(s.lastFeatureTime);
    s.status = `${error.message}${error.mayHaveExecuted ? '；定位可能已执行，未自动重发，请重新连接核对位置' : ''}`;
    if (!s.live || error.mayHaveExecuted || !client.connected) onError?.(error);
    report('快进／快退', s.status, false); render();
  }
  async function finishLive(s, kind, source, note) {
    const gesture = kind === 'restore' ? '上看' : kind === 'keep' ? '下看' : '双眨';
    if (s.error) {
      report(gesture, '弹窗已关闭，请核对 Deck 的实际位置', false, source);
      close(s);
      return;
    }
    if (s.observing && kind !== 'discard') {
      report(gesture, '观察模式中，请先恢复调节', false, source);
      return;
    }
    s.finishing = true;
    s.controller?.pause(s.lastFeatureTime);
    s.gazeArmed = false;
    dropQueued(s);
    render();
    await s.inFlight;
    if (session !== s) return;
    if (!s.error && kind !== 'keep' && Math.abs(s.applied) >= .0001) {
      await shift(s, clamp(-s.applied, -30, 30));
    }
    if (session !== s) return;
    s.finishing = false;
    if (s.error) { render(); return; }
    dropQueued(s);
    const label = `Deck ${s.live.deck}`;
    if (kind === 'keep') {
      report(gesture, `${note}已保留 ${label} 的位置变化 ${seconds(s.applied)}`, true, source);
      close(s, true);
    } else {
      const limited = Math.abs(s.applied) >= .0001;
      s.status = limited ? `到达边界，仍有 ${seconds(s.applied)} 未能撤回` : `已撤回 ${label} 的本次定位偏移`;
      report(gesture, note + s.status, !limited, source);
      if (kind === 'discard') close(s, limited);
      else render();
    }
  }
  async function finish(kind, source = '手动操作', note = '') {
    const s = session; if (!s || s.finishing) return;
    if (s.live) return finishLive(s, kind, source, note);
    if (kind === 'discard') {
      report('双眨', s.error ? '已关闭弹窗；此前定位结果未确认，请重新连接核对实际位置'
        : `${note}已放弃相对定位草稿；工程按原状态继续运行`, !s.error, source); close(s); return;
    }
    if (s.error) { report('关闭快进／快退', '连接异常，已关闭弹窗；请重新连接核对实际位置', false, source); close(s); return; }
    if (s.observing) { report(kind === 'restore' ? '上看' : '下看', '观察模式中，请先恢复调节', false, source); return; }
    if (kind === 'restore') {
      setOffset(s, 0); s.controller?.pause(s.lastFeatureTime); s.zone = 'center';
      s.status = `${note}已将相对偏移恢复为 0 秒，弹窗保持打开；未移动播放头`;
      report('上看', s.status, true, source); render(); return;
    }
    if (s.offset === 0) {
      report('下看', `${note}偏移为 0 秒，已关闭弹窗；未移动播放头`, true, source); close(s); return;
    }
    const issue = projectIssue(s);
    if (issue) { failed(s, new Error(issue)); return; }
    const ticket = generation, offset = s.offset;
    s.finishing = true; s.controller?.pause(s.lastFeatureTime);
    s.status = '正在执行一次相对定位并等待 SoundCraft 实际回读…'; render();
    try {
      const result = await client.seekRelative(offset);
      if (ticket !== generation || session !== s) return;
      if (!result || result.snapshot?.projectKey !== s.projectKey || !finite(result.afterSeconds) || !finite(result.deltaSeconds)) {
        throw Object.assign(new Error('SoundCraft 未返回有效定位回执，请重新连接核对'), {mayHaveExecuted:true});
      }
      s.result = result;
      const boundary = Math.abs(result.deltaSeconds - offset) > .11 ? `（请求 ${seconds(offset)}，实际按工程边界限制）` : '';
      report('下看', `${note}工程相对定位已确认：${seconds(result.deltaSeconds)}${boundary}；回读位置 ${clock(result.afterSeconds)}，播放状态与循环范围保持不变`, true, source);
      close(s, true);
    } catch (error) {
      if (ticket === generation && session === s) failed(s, error);
    } finally { if (session === s) { s.finishing = false; render(); } }
  }
  function observe(source) {
    const s = session; if (!s || s.finishing || s.error) return;
    s.observing = !s.observing;
    pause(s, s.observing ? '观察模式：已暂停位置调节' : '已恢复调节，请回中央后重新看向左右');
    report('长眨', s.status, true, source);
  }
  root.onclick = event => {
    const b = event.target.closest('button'); if (!b || b.disabled || !session) return;
    event.stopPropagation?.();
    if (b.id === 'scSeekEnableEyes') {
      onEnableEyes?.(); pause(session, session.observing ? '观察模式：偏移预览冻结，工程继续按原状态运行'
        : readinessIssue(session) || '眼动真实控制已开启，请回中央后看向左右');
    } else if (b.id === 'scSeekRestore') void finish('restore');
    else if (b.id === 'scSeekKeep') void finish('keep');
    else if (b.id === 'scSeekDiscard') void finish('discard');
    else if (b.id === 'scSeekObserve') observe('手动操作');
    else if (b.id === 'scSeekLess' || b.id === 'scSeekMore') {
      const s = session; s.zone = 'manual'; setOffset(s, s.offset + (b.id === 'scSeekMore' ? 1 : -1)); s.controller?.pause(s.lastFeatureTime);
    }
  };
  root.oninput = event => {
    if (event.target.id !== 'scSeekRange' || !session) return;
    const s = session; s.zone = 'manual'; setOffset(s, Number(event.target.value)); s.controller?.pause(s.lastFeatureTime);
  };
  root.addEventListener('keydown', event => {
    if (!session) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation?.(); void finish('discard'); }
    if (event.key === 'Tab') {
      const controls = ['scSeekRange', ...(!eyesEnabled() && onEnableEyes ? ['scSeekEnableEyes'] : []), 'scSeekLess', 'scSeekMore', 'scSeekRestore', 'scSeekKeep', 'scSeekObserve', 'scSeekDiscard'].map(q).filter(node => !node.disabled);
      if (!controls.length) event.preventDefault();
      else if (event.shiftKey && event.target === controls[0]) { event.preventDefault(); controls.at(-1).focus?.(); }
      else if (!event.shiftKey && event.target === controls.at(-1)) { event.preventDefault(); controls[0].focus?.(); }
    }
  });
  render();
  return {
    isOpen: () => !!session,
    open(live = null) {
      if (session) return false;
      const snapshot = client.snapshot;
      if (!client.connected || typeof snapshot?.projectKey !== 'string' || !snapshot.projectKey) throw new Error('请先连接有效的 SoundCraft 工程');
      if (!finite(snapshot.positionSeconds) || snapshot.positionSeconds < 0 || !finite(snapshot.durationSeconds) || snapshot.durationSeconds <= 0) throw new Error('工程位置或长度尚未就绪，请刷新状态后重试');
      const e = environment(), settings = e.sliderSettings || {};
      const openingPosition = live?.position ?? snapshot.positionSeconds;
      const endPosition = live?.duration ?? snapshot.durationSeconds;
      if (!finite(endPosition) || endPosition <= 0 || !finite(openingPosition)
        || openingPosition < 0 || openingPosition > endPosition + 1 / snapshot.sampleRate) {
        throw new Error('当前播放位置超出目标素材的有效时长，请刷新状态后重试');
      }
      const minOffset = Math.max(-30, -openingPosition);
      const maxOffset = Math.min(30, Math.max(0, endPosition - openingPosition));
      const s = {projectKey:snapshot.projectKey, projectName:snapshot.projectName || '当前工程', duration:snapshot.durationSeconds,
        openingPosition, position:openingPosition, endPosition, minOffset, maxOffset, offset:0,
        live, applied:0, inFlight:null, inFlightOffset:0, nextSendAt:0, timer:null, gazeArmed:false,
        calibration:e.calibration, lastFeatureTime:null, lastFace:-Infinity, openedAt:now(), zone:'center',
        observing:false, finishing:false, error:null, committed:false, result:null, status:''};
      const minRate = clamp((settings.minRatePerSec ?? 5) / 10, .5, 5);
      const maxRate = clamp((settings.maxRatePerSec ?? 35) / 10, minRate, 5);
      s.controller = e.calibration ? new GazeSliderController(e.calibration, {...settings, minRatePerSec:minRate, maxRatePerSec:maxRate},
        {min:s.minOffset, max:s.maxOffset, initialValue:0}) : null;
      s.status = readinessIssue(s) || (live ? '先看中央，再向左右调节' : '眼动条件已就绪，等待有效人脸视线；只预览偏移，不会自动定位');
      generation++; session = s; render(); onState?.(true, s); q('scSeekRange').focus?.(); return true;
    },
    detach() {
      generation++; const s = session; if (s) clearTimer(s); session = null; render();
      if (s) onState?.(false, s);
    },
    gesture(gesture, source, note = '') {
      const s = session; if (!s || s.finishing) return;
      const issue = readinessIssue(s);
      if (source === '眼动识别' && (issue || now() - s.lastFace > 750)) {
        pause(s, issue || '未收到近期有效人脸视线，已暂停眼动调节'); report(gesture, s.status, false, source); return;
      }
      if (gesture === '长眨') observe(source);
      else if (gesture === '上看') return finish('restore', source, note);
      else if (gesture === '下看') return finish('keep', source, note);
      else if (gesture === '双眨') return finish('discard', source, note);
      // The classifier never adds a second horizontal step to the raw controller.
    },
    frame(raw, t = now()) {
      const s = session; if (!s || s.finishing || s.error) return;
      s.lastFeatureTime = t;
      const signal = gazeSignal(raw, environment().sliderSettings?.headCompensation);
      const validSignal = signal !== null;
      s.lastFace = validSignal ? now() : -Infinity;
      const issue = readinessIssue(s);
      if (!validSignal || issue || s.observing) {
        pause(s, s.observing ? '观察模式：已暂停位置调节' : issue || (!raw
          ? '未检测到人脸，已暂停偏移调节'
          : '已收到人脸数据，但本帧虹膜信号无效，已暂停偏移调节')); return;
      }
      const manual = s.zone === 'manual';
      if (s.live) {
        const center = Math.abs(normaliseGazePosition(signal, s.calibration)) <= s.controller.settings.deadZone;
        if (!s.gazeArmed || (center && !manual)) {
          s.gazeArmed ||= center;
          s.controller.pause(t);
          s.controller.smoothed = null;
          if (!manual) {
            dropQueued(s);
            s.zone = 'center';
            s.status = s.gazeArmed ? '回中央停止调节，下看保留已生效的位置变化' : '先看中央，再向左右调节';
            render();
          }
          return;
        }
      }
      const next = s.controller.updateSignal(signal, t);
      if (!manual || Math.abs(next.delta) > 0) s.zone = next.zone;
      if (Math.abs(next.delta) > 0) setOffset(s, next.value, true);
      else if (next.zone === 'center' && !manual) {
        if (s.live) dropQueued(s);
        s.status = s.live ? '回中央停止调节，下看保留已生效的位置变化' : '回中央停止；当前偏移仅为预览，下看才执行定位'; render();
      } else if (!manual && ['left-wait', 'right-wait'].includes(next.zone)) {
        if (s.live) dropQueued(s);
        s.status = `已检测到有效视线，向${next.zone === 'left-wait' ? '左' : '右'}停留确认中…`; render();
      }
    },
    tick() {
      const s = session; if (!s || s.finishing || s.error) return;
      const issue = readinessIssue(s);
      if (issue) pause(s, issue);
      else if (s.zone !== 'manual' && s.zone !== 'lost' && now() - s.lastFace > 750) pause(s, '画面中断，已暂停偏移调节');
      if (now() - s.openedAt > (environment().sliderSettings?.timeoutMs ?? 20000)) void finish('discard', '系统', '弹窗超时，');
    },
  };
}

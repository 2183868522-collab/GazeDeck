import { GazeSliderController, gazeSignal } from './gaze-slider.js';

export const MIN_TEMPO_BPM = 20, MAX_TEMPO_BPM = 300;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const roundDraft = value => Math.round(value * 10) / 10;
const inRange = value => finite(value) && value >= MIN_TEMPO_BPM && value <= MAX_TEMPO_BPM;
const bpm = value => `${Number(value.toFixed(3))} BPM`;

// The draft is local. A single compare-and-set request is sent only on Keep.
// This controls the session tempo map; it never stretches audio clips or seeks.
export function mountSoundCraftTempo(root, { client, environment, eyesEnabled, onEnableEyes, onResult, onState, onError, now = () => performance.now() }) {
  let session = null, generation = 0;
  const q = id => root.querySelector(`#${id}`);
  root.innerHTML = `<div class="sc-volume-card">
    <span class="eyebrow">SoundCraft · 速度控制 · 工程 BPM</span>
    <h2 id="scTempoTitle"></h2><p id="scTempoOriginal" class="muted"></p>
    <div class="sc-live-values"><div>预览工程 BPM<strong id="scTempoValue"></strong></div></div>
    <input id="scTempoRange" type="range" min="${MIN_TEMPO_BPM}" max="${MAX_TEMPO_BPM}" step="any" aria-label="SoundCraft 工程 BPM 预览" style="width:100%">
    <p id="scTempoStatus" role="status" aria-live="polite"></p>
    <button id="scTempoEnableEyes" class="primary hidden">开启本区眼动真实控制</button>
    <p>左右视线连续调整 BPM 草稿，回中央停止。上看恢复打开时的 BPM 并保持弹窗；下看提交一次并关闭。长眨观察／恢复，双眨或 Esc 放弃草稿。</p>
    <div class="row sc-live-actions"><button id="scTempoLess">−1 BPM</button><button id="scTempoMore">+1 BPM</button><button id="scTempoRestore">上看 · 恢复打开时 BPM</button><button id="scTempoKeep" class="primary">下看 · 提交并关闭</button><button id="scTempoObserve">进入观察模式</button><button id="scTempoDiscard">放弃调节</button></div>
    <p class="muted">工程 BPM 由 A/B 共用。当前仅修改工程节拍，不会自动拉伸 WAV 或改变音频播放速度；不会移动播放头。预览、放弃及超时均不提交 BPM 修改。</p>
  </div>`;

  function report(gesture, message, executed, source = '手动操作', feedback = true) {
    onResult?.(gesture, {executed, feedback, message, from:'SoundCraft 工程 BPM', to:'SoundCraft 工程 BPM'}, source);
  }
  function projectIssue(s) {
    if (!client.connected) return 'SoundCraft 连接已失效，请关闭弹窗并重新连接';
    const snapshot = client.snapshot;
    if (snapshot?.projectKey !== s.projectKey) return 'SoundCraft 工程或轨道已变化，请关闭后重新连接';
    if (snapshot.tempoSupported !== true || !finite(snapshot.tempoBpm)) return snapshot.tempoReason || '当前工程节拍图不支持本次 BPM 调节';
    if (snapshot.tempoMapKey !== s.tempoMapKey || snapshot.tempoBpm !== s.original) return '工程 BPM 或节拍图已在其他位置变化，请关闭后重新读取；未覆盖外部修改';
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
    q('scTempoTitle').textContent = s.reset ? '恢复连接时工程 BPM · 确认' : '工程 BPM · A/B 共用';
    q('scTempoOriginal').textContent = `工程：${s.projectName} · 打开时 ${bpm(s.original)}${s.reset ? ` · 恢复目标 ${bpm(s.initial)}` : ''}`;
    q('scTempoValue').textContent = bpm(s.value);
    q('scTempoRange').value = s.value;
    q('scTempoRange').disabled = s.finishing || s.observing || !!s.error;
    q('scTempoStatus').textContent = s.status;
    q('scTempoEnableEyes').classList.toggle('hidden', eyesEnabled() || !onEnableEyes);
    q('scTempoEnableEyes').disabled = s.finishing || !!s.error || !client.connected;
    for (const id of ['scTempoLess', 'scTempoMore', 'scTempoRestore']) q(id).disabled = s.finishing || s.observing || !!s.error;
    q('scTempoKeep').disabled = s.finishing;
    q('scTempoDiscard').disabled = s.finishing;
    q('scTempoObserve').disabled = s.finishing || !!s.error;
    q('scTempoObserve').textContent = s.observing ? '恢复调节' : '进入观察模式';
  }
  function pause(s, message) {
    s.controller?.pause(s.lastFeatureTime);
    if (s.controller) s.controller.smoothed = null;
    if (s.zone !== 'manual') s.zone = 'lost';
    s.status = message; render();
  }
  function setDraft(s, value, fromController = false) {
    if (session !== s || s.finishing || s.observing || s.error || !finite(value)) return;
    s.value = clamp(roundDraft(value), MIN_TEMPO_BPM, MAX_TEMPO_BPM);
    // Do not quantize the continuous accumulator: small frame deltas must add up.
    if (s.controller && !fromController) s.controller.value = s.value;
    s.status = '仅预览工程 BPM，尚未提交；下看后修改工程节拍，WAV 不会自动变速'; render();
  }
  function close(s, committed = false) {
    if (session !== s) return;
    s.committed = committed; session = null; render(); onState?.(false, s);
  }
  function failed(s, error) {
    if (session !== s) return;
    s.error = error; s.controller?.pause(s.lastFeatureTime);
    s.status = `${error.message}${error.mayHaveExecuted ? '；BPM 修改可能已执行，未自动重发，请重新连接核对' : ''}`;
    onError?.(error); report('工程 BPM', s.status, false); render();
  }
  async function finish(kind, source = '手动操作', note = '') {
    const s = session; if (!s || s.finishing) return;
    if (kind === 'discard') {
      report('双眨', s.error ? '已关闭弹窗；此前 BPM 提交结果未确认，请重新连接核对'
        : `${note}已放弃工程 BPM 草稿；未提交节拍修改`, !s.error, source); close(s); return;
    }
    if (s.error) { report('关闭工程 BPM', '连接异常，已关闭弹窗；请重新连接核对实际 BPM', false, source); close(s); return; }
    if (s.observing) { report(kind === 'restore' ? '上看' : '下看', '观察模式中，请先恢复调节', false, source); return; }
    if (kind === 'restore') {
      s.value = s.original;
      if (s.controller) { s.controller.value = s.original; s.controller.pause(s.lastFeatureTime); }
      s.zone = 'center'; s.status = `${note}已恢复打开时的 ${bpm(s.original)} 草稿，弹窗保持打开；未提交节拍修改`;
      report('上看', s.status, true, source); render(); return;
    }
    if (s.value === s.original) {
      report('下看', `${note}草稿未更改，已关闭弹窗；未提交 BPM 修改`, true, source); close(s); return;
    }
    const issue = projectIssue(s);
    if (issue) { failed(s, new Error(issue)); return; }
    const ticket = generation, target = s.value;
    s.finishing = true; s.controller?.pause(s.lastFeatureTime);
    s.status = '正在提交一次工程 BPM 修改并等待 SoundCraft 实际回读…'; render();
    try {
      const result = await client.setTempo(target, {expectedTempoMapKey:s.tempoMapKey});
      if (ticket !== generation || session !== s) return;
      if (!result || result.snapshot?.projectKey !== s.projectKey || !finite(result.beforeBpm) || !finite(result.afterBpm)
        || result.beforeBpm !== s.original || Math.abs(result.afterBpm - target) > .000001 || typeof result.changed !== 'boolean') {
        throw Object.assign(new Error('SoundCraft 未返回有效的 BPM 修改回执，请重新连接核对'), {mayHaveExecuted:true});
      }
      s.result = result;
      report('下看', `${note}工程 BPM 已确认：${bpm(result.afterBpm)}；当前修改工程节拍，WAV 音频速度未改变`, true, source);
      close(s, result.changed);
    } catch (error) {
      if (ticket === generation && session === s) failed(s, error);
    } finally { if (session === s) { s.finishing = false; render(); } }
  }
  function observe(source) {
    const s = session; if (!s || s.finishing || s.error) return;
    s.observing = !s.observing;
    pause(s, s.observing ? '观察模式：BPM 草稿冻结，工程按原状态运行' : '已恢复调节，请回中央后重新看向左右');
    report('长眨', s.status, true, source);
  }
  root.onclick = event => {
    const button = event.target.closest('button'); if (!button || button.disabled || !session) return;
    event.stopPropagation?.();
    if (button.id === 'scTempoEnableEyes') {
      onEnableEyes?.(); pause(session, session.observing ? '观察模式：BPM 草稿冻结，工程按原状态运行'
        : readinessIssue(session) || '眼动真实控制已开启，请回中央后看向左右');
    } else if (button.id === 'scTempoRestore') void finish('restore');
    else if (button.id === 'scTempoKeep') void finish('keep');
    else if (button.id === 'scTempoDiscard') void finish('discard');
    else if (button.id === 'scTempoObserve') observe('手动操作');
    else if (button.id === 'scTempoLess' || button.id === 'scTempoMore') {
      const s = session; s.zone = 'manual'; setDraft(s, s.value + (button.id === 'scTempoMore' ? 1 : -1)); s.controller?.pause(s.lastFeatureTime);
    }
  };
  root.oninput = event => {
    if (event.target.id !== 'scTempoRange' || !session) return;
    const s = session; s.zone = 'manual'; setDraft(s, Number(event.target.value)); s.controller?.pause(s.lastFeatureTime);
  };
  root.addEventListener('keydown', event => {
    if (!session) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation?.(); void finish('discard'); }
    if (event.key === 'Tab') {
      const controls = ['scTempoRange', ...(!eyesEnabled() && onEnableEyes ? ['scTempoEnableEyes'] : []), 'scTempoLess', 'scTempoMore', 'scTempoRestore', 'scTempoKeep', 'scTempoObserve', 'scTempoDiscard'].map(q).filter(node => !node.disabled);
      if (!controls.length) event.preventDefault();
      else if (event.shiftKey && event.target === controls[0]) { event.preventDefault(); controls.at(-1).focus?.(); }
      else if (!event.shiftKey && event.target === controls.at(-1)) { event.preventDefault(); controls[0].focus?.(); }
    }
  });
  render();
  return {
    isOpen: () => !!session,
    open({initialBpm, reset = false} = {}) {
      if (session) return false;
      const snapshot = client.snapshot;
      if (!client.connected || typeof snapshot?.projectKey !== 'string' || !snapshot.projectKey) throw new Error('请先连接有效的 SoundCraft 工程');
      if (snapshot.tempoSupported !== true) throw new Error(snapshot.tempoReason || '当前工程节拍图不支持本次 BPM 调节');
      if (!inRange(snapshot.tempoBpm) || typeof snapshot.tempoMapKey !== 'string' || !snapshot.tempoMapKey) throw new Error(`工程 BPM 或节拍图尚未就绪，支持范围为 ${MIN_TEMPO_BPM}–${MAX_TEMPO_BPM} BPM`);
      if (initialBpm !== undefined && !inRange(initialBpm)) throw new Error(`恢复目标必须是 ${MIN_TEMPO_BPM}–${MAX_TEMPO_BPM} BPM 的有效数值`);
      const e = environment(), settings = e.sliderSettings || {};
      const original = snapshot.tempoBpm, initial = initialBpm ?? original;
      const s = {projectKey:snapshot.projectKey, projectName:snapshot.projectName || '当前工程', tempoMapKey:snapshot.tempoMapKey,
        original, initial, value:initial, reset:!!reset, calibration:e.calibration,
        lastFeatureTime:null, lastFace:-Infinity, openedAt:now(), zone:'center', observing:false, finishing:false,
        error:null, committed:false, result:null, status:''};
      const minRate = clamp((settings.minRatePerSec ?? 5) / 10, .5, 5);
      const maxRate = clamp((settings.maxRatePerSec ?? 35) / 10, minRate, 5);
      s.controller = e.calibration ? new GazeSliderController(e.calibration, {...settings,minRatePerSec:minRate,maxRatePerSec:maxRate},
        {min:MIN_TEMPO_BPM,max:MAX_TEMPO_BPM,initialValue:initial}) : null;
      s.status = readinessIssue(s) || (s.reset ? '已预览连接时的 BPM；下看确认恢复，上看改回打开时 BPM，双眨取消' : '眼动条件已就绪，等待有效人脸视线；只预览 BPM，不会自动提交');
      generation++; session = s; render(); onState?.(true, s); q('scTempoRange').focus?.(); return true;
    },
    detach() {
      generation++; const s = session; session = null; render();
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
    },
    frame(raw, t = now()) {
      const s = session; if (!s || s.finishing || s.error) return;
      s.lastFeatureTime = t;
      const validSignal = raw && gazeSignal(raw, environment().sliderSettings?.headCompensation) !== null;
      s.lastFace = validSignal ? now() : -Infinity;
      const issue = readinessIssue(s);
      if (!validSignal || issue || s.observing) {
        pause(s, s.observing ? '观察模式：BPM 草稿冻结，工程按原状态运行' : issue || (!raw
          ? '未检测到人脸，已暂停 BPM 草稿调节'
          : '已收到人脸数据，但本帧虹膜信号无效，已暂停 BPM 草稿调节')); return;
      }
      const next = s.controller.updateFrame(raw, t), manual = s.zone === 'manual';
      if (!manual || Math.abs(next.delta) > 0) s.zone = next.zone;
      if (Math.abs(next.delta) > 0) setDraft(s, next.value, true);
      else if (next.zone === 'center' && !manual) { s.status = '回中央停止；当前 BPM 仅为预览，下看才提交'; render(); }
      else if (!manual && ['left-wait','right-wait'].includes(next.zone)) { s.status = `已检测到有效视线，向${next.zone === 'left-wait' ? '左' : '右'}停留确认中…`; render(); }
    },
    tick() {
      const s = session; if (!s || s.finishing || s.error) return;
      const issue = readinessIssue(s);
      if (issue) pause(s, issue);
      else if (s.zone !== 'manual' && s.zone !== 'lost' && now() - s.lastFace > 750) pause(s, '画面中断，已暂停 BPM 草稿调节');
      if (now() - s.openedAt > (environment().sliderSettings?.timeoutMs ?? 20000)) void finish('discard', '系统', '弹窗超时，');
    },
  };
}

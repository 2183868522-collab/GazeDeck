import { GazeSliderController, gazeSignal } from './gaze-slider.js';
import { eqTarget, eqInsertKey } from './soundcraft-client.js';

export const MIN_EQ_DB = -24, MAX_EQ_DB = 24;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const roundDraft = value => Math.round(value * 10) / 10;
const inRange = value => finite(value) && value >= MIN_EQ_DB && value <= MAX_EQ_DB;
const db = value => `${value > 0 ? '+' : ''}${Number(value.toFixed(3))} dB`;
const bands = {low:'LOW · 低频',mid:'MID · 中频',high:'HIGH · 高频'};

// The draft is local. A single compare-and-set request is sent only on Keep.
// Only the chosen EQ gain changes after Keep; drafts never write to SoundCraft.
export function mountSoundCraftEq(root, { client, environment, eyesEnabled, onEnableEyes, onResult, onState, onError, now = () => performance.now() }) {
  let session = null, generation = 0;
  const q = id => root.querySelector(`#${id}`);
  root.innerHTML = `<div class="sc-volume-card">
    <span class="eyebrow">SoundCraft · 声音与效果 · 三段 EQ</span>
    <h2 id="scEqTitle"></h2><p id="scEqOriginal" class="muted"></p>
    <div class="sc-live-values"><div>待提交增益<strong id="scEqValue"></strong></div></div>
    <p id="scEqFrequency" class="muted"></p>
    <input id="scEqRange" type="range" min="${MIN_EQ_DB}" max="${MAX_EQ_DB}" step="any" aria-label="SoundCraft EQ 增益草稿" style="width:100%">
    <p id="scEqStatus" role="status" aria-live="polite"></p>
    <button id="scEqEnableEyes" class="primary hidden">开启本区眼动真实控制</button>
    <p>左右视线连续调整增益草稿，回中央停止；下看提交后生效。上看恢复打开时的增益并保持弹窗；下看提交一次并关闭。长眨观察／恢复，双眨或 Esc 放弃草稿。</p>
    <div class="row sc-live-actions"><button id="scEqLess">−1 dB</button><button id="scEqMore">+1 dB</button><button id="scEqRestore">上看 · 恢复打开时增益</button><button id="scEqKeep" class="primary">下看 · 提交并关闭</button><button id="scEqObserve">进入观察模式</button><button id="scEqDiscard">放弃调节</button></div>
    <p class="muted">仅调节所选音轨的一个 EQ 频段增益；频率与 Q 保持原值。空插槽首次非零提交时加入平直 EQ 7-Band，不覆盖其他插件。草稿、放弃和超时均不发送修改，不改变循环或播放位置。</p>
  </div>`;

  function report(gesture, message, executed, source = '手动操作', feedback = true) {
    onResult?.(gesture, {executed, feedback, message, from:'SoundCraft 三段 EQ', to:'SoundCraft 三段 EQ'}, source);
  }
  function projectIssue(s) {
    if (!client.connected) return 'SoundCraft 连接已失效，请关闭弹窗并重新连接';
    const snapshot = client.snapshot;
    if (snapshot?.projectKey !== s.projectKey) return 'SoundCraft 工程或轨道已变化，请关闭后重新连接';
    const target = eqTarget(snapshot, s.trackId);
    if (!target.supported) return target.reason || '目标音轨 EQ 尚未就绪';
    if (target.slot !== s.slot || eqInsertKey(target.insert) !== eqInsertKey(s.insert)) return '目标 EQ 插槽或参数已在其他位置变化，请关闭后重新读取；未覆盖外部修改';
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
    q('scEqTitle').textContent = `${s.trackName} · ${bands[s.band]}`;
    q('scEqOriginal').textContent = `固定目标 ID ${s.trackId} · 插槽 ${s.slot + 1} · 打开时 ${db(s.original)}`;
    q('scEqFrequency').textContent = `当前频率 ${s.frequency} Hz · 仅改变增益，频率与 Q 不变${s.insert === null ? ' · 提交后建立 EQ 7-Band' : ''}`;
    q('scEqValue').textContent = db(s.value);
    q('scEqRange').value = s.value;
    q('scEqRange').disabled = s.finishing || s.observing || !!s.error;
    q('scEqStatus').textContent = s.status;
    q('scEqEnableEyes').classList.toggle('hidden', eyesEnabled() || !onEnableEyes);
    q('scEqEnableEyes').disabled = s.finishing || !!s.error || !client.connected;
    for (const id of ['scEqLess', 'scEqMore', 'scEqRestore']) q(id).disabled = s.finishing || s.observing || !!s.error;
    q('scEqKeep').disabled = s.finishing;
    q('scEqDiscard').disabled = s.finishing;
    q('scEqObserve').disabled = s.finishing || !!s.error;
    q('scEqObserve').textContent = s.observing ? '恢复调节' : '进入观察模式';
  }
  function pause(s, message) {
    s.controller?.pause(s.lastFeatureTime);
    if (s.controller) s.controller.smoothed = null;
    if (s.zone !== 'manual') s.zone = 'lost';
    s.status = message; render();
  }
  function setDraft(s, value, fromController = false) {
    if (session !== s || s.finishing || s.observing || s.error || !finite(value)) return;
    s.value = clamp(roundDraft(value), MIN_EQ_DB, MAX_EQ_DB);
    // Do not quantize the continuous accumulator: small frame deltas must add up.
    if (s.controller && !fromController) s.controller.value = s.value;
    s.status = '仅调整 EQ 增益草稿，尚未发送；下看提交后生效'; render();
  }
  function close(s, committed = false) {
    if (session !== s) return;
    s.committed = committed; session = null; render(); onState?.(false, s);
  }
  function failed(s, error) {
    if (session !== s) return;
    s.error = error; s.controller?.pause(s.lastFeatureTime);
    s.status = `${error.message}${error.mayHaveExecuted ? '；EQ 修改可能已执行，未自动重发，请重新连接核对' : ''}`;
    onError?.(error); report('EQ 增益', s.status, false); render();
  }
  async function finish(kind, source = '手动操作', note = '') {
    const s = session; if (!s || s.finishing) return;
    if (kind === 'discard') {
      report('双眨', s.error ? '已关闭弹窗；此前 EQ 提交结果未确认，请重新连接核对'
        : `${note}已放弃 EQ 草稿；未提交参数修改`, !s.error, source); close(s); return;
    }
    if (s.error) { report('关闭 EQ', '连接异常，已关闭弹窗；请重新连接核对实际 EQ', false, source); close(s); return; }
    if (s.observing) { report(kind === 'restore' ? '上看' : '下看', '观察模式中，请先恢复调节', false, source); return; }
    if (kind === 'restore') {
      s.value = s.original;
      if (s.controller) { s.controller.value = s.original; s.controller.pause(s.lastFeatureTime); }
      s.zone = 'center'; s.status = `${note}已恢复打开时的 ${db(s.original)} 草稿，弹窗保持打开；未提交 EQ 修改`;
      report('上看', s.status, true, source); render(); return;
    }
    if (s.value === s.original) {
      report('下看', `${note}草稿未更改，已关闭弹窗；未提交 EQ 修改`, true, source); close(s); return;
    }
    const issue = projectIssue(s);
    if (issue) { failed(s, new Error(issue)); return; }
    const ticket = generation, target = s.value;
    s.finishing = true; s.controller?.pause(s.lastFeatureTime);
    s.status = '正在提交一次 EQ 修改并等待 SoundCraft 实际回读…'; render();
    try {
      const result = await client.setEq(s.trackId, s.band, target, {expectedInsert:s.insert,slot:s.slot});
      if (ticket !== generation || session !== s) return;
      if (!result || result.snapshot?.projectKey !== s.projectKey || result.trackId !== s.trackId || result.slot !== s.slot || result.band !== s.band
        || !finite(result.beforeDb) || !finite(result.afterDb) || Math.abs(result.beforeDb - s.original) > .0001
        || Math.abs(result.afterDb - target) > .0001 || typeof result.changed !== 'boolean' || typeof result.created !== 'boolean') {
        throw Object.assign(new Error('SoundCraft 未返回有效的 EQ 修改回执，请重新连接核对'), {mayHaveExecuted:true});
      }
      s.result = result;
      report('下看', `${note}${s.trackName} ${bands[s.band]} 已确认：${db(result.afterDb)}；循环与播放位置不变`, true, source);
      close(s, result.changed);
    } catch (error) {
      if (ticket === generation && session === s) failed(s, error);
    } finally { if (session === s) { s.finishing = false; render(); } }
  }
  function observe(source) {
    const s = session; if (!s || s.finishing || s.error) return;
    s.observing = !s.observing;
    pause(s, s.observing ? '观察模式：EQ 草稿冻结，工程按原状态运行' : '已恢复调节，请回中央后重新看向左右');
    report('长眨', s.status, true, source);
  }
  root.onclick = event => {
    const button = event.target.closest('button'); if (!button || button.disabled || !session) return;
    event.stopPropagation?.();
    if (button.id === 'scEqEnableEyes') {
      onEnableEyes?.(); pause(session, session.observing ? '观察模式：EQ 草稿冻结，工程按原状态运行'
        : readinessIssue(session) || '眼动真实控制已开启，请回中央后看向左右');
    } else if (button.id === 'scEqRestore') void finish('restore');
    else if (button.id === 'scEqKeep') void finish('keep');
    else if (button.id === 'scEqDiscard') void finish('discard');
    else if (button.id === 'scEqObserve') observe('手动操作');
    else if (button.id === 'scEqLess' || button.id === 'scEqMore') {
      const s = session; s.zone = 'manual'; setDraft(s, s.value + (button.id === 'scEqMore' ? 1 : -1)); s.controller?.pause(s.lastFeatureTime);
    }
  };
  root.oninput = event => {
    if (event.target.id !== 'scEqRange' || !session) return;
    const s = session; s.zone = 'manual'; setDraft(s, Number(event.target.value)); s.controller?.pause(s.lastFeatureTime);
  };
  root.addEventListener('keydown', event => {
    if (!session) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation?.(); void finish('discard'); }
    if (event.key === 'Tab') {
      const controls = ['scEqRange', ...(!eyesEnabled() && onEnableEyes ? ['scEqEnableEyes'] : []), 'scEqLess', 'scEqMore', 'scEqRestore', 'scEqKeep', 'scEqObserve', 'scEqDiscard'].map(q).filter(node => !node.disabled);
      if (!controls.length) event.preventDefault();
      else if (event.shiftKey && event.target === controls[0]) { event.preventDefault(); controls.at(-1).focus?.(); }
      else if (!event.shiftKey && event.target === controls.at(-1)) { event.preventDefault(); controls[0].focus?.(); }
    }
  });
  render();
  return {
    isOpen: () => !!session,
    open(trackId, band) {
      if (session) return false;
      const snapshot = client.snapshot;
      if (!client.connected || typeof snapshot?.projectKey !== 'string' || !snapshot.projectKey) throw new Error('请先连接有效的 SoundCraft 工程');
      if (!Object.hasOwn(bands, band)) throw new Error('请选择 Low、Mid 或 High 频段');
      const target = eqTarget(snapshot, trackId);
      if (!target.supported) throw new Error(target.reason || '目标音轨 EQ 尚未就绪');
      const original = target.values[band];
      if (!inRange(original) || !finite(target.frequencies?.[band]) || target.frequencies[band] <= 0) throw new Error('目标 EQ 增益或频率无效，请重新读取');
      const e = environment(), settings = e.sliderSettings || {};
      const s = {projectKey:snapshot.projectKey, projectName:snapshot.projectName || '当前工程',
        trackId, trackName:snapshot.tracks.find(track => track.id === trackId)?.name || `音轨 ${trackId}`,
        band, slot:target.slot, insert:target.insert === null ? null : structuredClone(target.insert), frequency:target.frequencies[band],
        original, value:original, calibration:e.calibration,
        lastFeatureTime:null, lastFace:-Infinity, openedAt:now(), zone:'center', observing:false, finishing:false,
        error:null, committed:false, result:null, status:''};
      const minRate = clamp((settings.minRatePerSec ?? 5) / 10, .5, 5);
      const maxRate = clamp((settings.maxRatePerSec ?? 35) / 10, minRate, 5);
      s.controller = e.calibration ? new GazeSliderController(e.calibration, {...settings,minRatePerSec:minRate,maxRatePerSec:maxRate},
        {min:MIN_EQ_DB,max:MAX_EQ_DB,initialValue:original}) : null;
      s.status = readinessIssue(s) || '眼动条件已就绪，等待有效人脸视线；当前仅为增益草稿，下看提交后生效';
      generation++; session = s; render(); onState?.(true, s); q('scEqRange').focus?.(); return true;
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
        pause(s, s.observing ? '观察模式：EQ 草稿冻结，工程按原状态运行' : issue || (!raw
          ? '未检测到人脸，已暂停 EQ 草稿调节'
          : '已收到人脸数据，但本帧虹膜信号无效，已暂停 EQ 草稿调节')); return;
      }
      const next = s.controller.updateFrame(raw, t), manual = s.zone === 'manual';
      if (!manual || Math.abs(next.delta) > 0) s.zone = next.zone;
      if (Math.abs(next.delta) > 0) setDraft(s, next.value, true);
      else if (next.zone === 'center' && !manual) { s.status = '回中央停止；当前 EQ 仅为草稿，下看提交后生效'; render(); }
      else if (!manual && ['left-wait','right-wait'].includes(next.zone)) { s.status = `已检测到有效视线，向${next.zone === 'left-wait' ? '左' : '右'}停留确认中…`; render(); }
    },
    tick() {
      const s = session; if (!s || s.finishing || s.error) return;
      const issue = readinessIssue(s);
      if (issue) pause(s, issue);
      else if (s.zone !== 'manual' && s.zone !== 'lost' && now() - s.lastFace > 750) pause(s, '画面中断，已暂停 EQ 草稿调节');
      if (now() - s.openedAt > (environment().sliderSettings?.timeoutMs ?? 20000)) void finish('discard', '系统', '弹窗超时，');
    },
  };
}

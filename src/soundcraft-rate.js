import { GazeSliderController, gazeSignal } from './gaze-slider.js';

const finite = value => typeof value === 'number' && Number.isFinite(value);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const sameLoop = (a, b) => a && b && a.start === b.start && a.end === b.end;
const validLoop = value => value && Number.isSafeInteger(value.start) && Number.isSafeInteger(value.end) && value.start >= 0 && value.end > value.start;
const rateText = value => `${value.toFixed(3)}×（${value >= 1 ? '+' : ''}${((value - 1) * 100).toFixed(1)}%）`;
const targetsEqual = (a, b) => a.length === b.length && a.every(x => b.some(y => y.track === x.track && Math.abs(x.rate - y.rate) < 1e-9));
const stateKey = (snapshot, ids) => JSON.stringify(ids.map(id => {
  const state = snapshot?.tracks?.find(item => item.track === id);
  return state ? [id, state.rate, state.revision, state.loop] : null;
}));

// Actual rate values come exclusively from the native callback snapshot. Model
// defaults are labelled as unconfigured; they never masquerade as callback ACKs.
function targetStates(snapshot, ids, requireApplied = false) {
  return ids.map(track => {
    const desired = snapshot?.tracks?.find(state => state.track === track);
    if (!desired || !finite(desired.rate) || desired.rate < .5 || desired.rate > 2) throw new Error('目标音轨没有有效的变速状态');
    const actual = snapshot.applied?.find(state => state.track === track && state.epoch === snapshot.epoch
      && state.revision === desired.revision && state.rate === desired.rate
      && desired.loop && state.loop_start === desired.loop.start && state.loop_end === desired.loop.end);
    if (!actual && (requireApplied || desired.revision !== 0 || desired.rate !== 1 || desired.loop !== null)) {
      throw new Error('音频回调尚未确认当前倍率版本，请刷新状态后再打开');
    }
    return {track, rate:actual?.rate ?? 1};
  });
}

export function mountSoundCraftRate(root, {client, rates, environment, eyesEnabled, onEnableEyes, onResult, onState, onError, now = () => performance.now()}) {
  let session = null, generation = 0;
  const q = id => root.querySelector(`#${id}`);
  root.innerHTML = `<div class="sc-volume-card">
    <span class="eyebrow">SoundCraft · 速度控制 · 真实音轨变速</span>
    <h2 id="scRateTitle"></h2><p id="scRateOriginal" class="muted"></p>
    <div class="sc-live-values"><div>目标倍率<strong id="scRateTarget" style="font-size:24px;white-space:pre-line"></strong></div><div>音频回调实际回读<strong id="scRateActual" style="font-size:24px;white-space:pre-line"></strong></div></div>
    <p id="scRateLoop" class="muted"></p><p id="scRatePositions" class="muted"></p>
    <input id="scRateRange" type="range" step="any" aria-label="SoundCraft 真实音轨播放倍率" style="width:100%">
    <p id="scRateStatus" role="status" aria-live="polite"></p>
    <button id="scRateEnableEyes" class="primary hidden">开启本区眼动真实控制</button>
    <p>左右视线实时改变倍率，回中央停止调节。上看恢复打开时的倍率并保持弹窗；下看保留并关闭。长眨观察／恢复，双眨、Esc 或超时恢复打开时倍率后关闭。</p>
    <div class="row sc-live-actions"><button id="scRateLess">−1%</button><button id="scRateMore">+1%</button><button id="scRateRestore">上看 · 恢复打开时倍率</button><button id="scRateKeep" class="primary">下看 · 保留并关闭</button><button id="scRateObserve">进入观察模式</button><button id="scRateDiscard">放弃本次调节</button></div>
    <p class="muted">这是 varispeed：音调随速度变化。A/B 联动保持两轨打开时的倍率比例。音源在固定秒数范围内独立循环，不移动工程播放头，不改变工程 BPM、片段长度或淡入淡出。离开页面只停止调节，保留已生效倍率。</p>
  </div>`;

  function report(gesture, message, executed, source = '手动操作', feedback = true) {
    onResult?.(gesture, {executed,feedback,message,from:'SoundCraft 音轨变速',to:'SoundCraft 音轨变速'}, source);
  }
  function issue(s) {
    if (!client.connected) return 'SoundCraft 连接已失效，请关闭弹窗并重新连接';
    if (client.snapshot?.projectKey !== s.projectKey || rates.snapshot?.projectKey !== s.projectKey || rates.snapshot?.epoch !== s.epoch) return '工程或变速会话已变化，请重新连接';
    return '';
  }
  function eyeIssue(s) {
    const project = issue(s), e = environment();
    if (project) return project;
    if (!eyesEnabled()) return '尚未开启本区眼动真实控制，请点击下方按钮开启';
    if (!e.camera) return '摄像头未运行，请检查摄像头';
    if (!e.baseline) return '静息校准未就绪，请先完成或选择已有校准环境';
    if (e.sliderSettings?.enabled === false) return '视线滑块已在⑤设置中关闭';
    if (!e.calibration) return '当前环境左右标尺未就绪，请完成第4步滑块校准';
    if (e.calibration !== s.calibration || !s.controller) return '滑块校准环境已变化，请关闭后重新打开';
    return '';
  }
  const label = (s, target) => `${s.names.get(target.track)} ${rateText(target.rate)}`;
  function render() {
    const s = session; root.classList.toggle('hidden', !s); if (!s) return;
    q('scRateTitle').textContent = s.confirmation ? s.title : s.trackIds.length === 2 ? 'Deck A/B · 同比例实时变速' : `${s.names.get(s.trackIds[0])} · 实时变速`;
    q('scRateOriginal').textContent = `打开时：${s.originalTargets.map(target => label(s,target)).join(' ｜ ')}`;
    q('scRateTarget').textContent = s.targets.map(target => label(s,target)).join('\n');
    q('scRateActual').textContent = s.confirmedTargets.map(target => label(s,target)).join('\n') + (s.error ? '（上次确认）' : s.unconfigured ? '（原生 1×，尚未配置独立音源循环）' : '');
    const sampleRate = s.resultSnapshot.sampleRate;
    q('scRateLoop').textContent = `固定音源循环：${(s.loop.start / sampleRate).toFixed(2)}–${(s.loop.end / sampleRate).toFixed(2)} 秒${s.confirmation ? '；候选倍率需下看确认，尚未发送' : s.trackIds.length === 2 ? `；滑块是相对打开时的 ${s.value.toFixed(3)}× 比例` : ''}`;
    q('scRatePositions').textContent = s.resultSnapshot.applied?.filter(actual => s.trackIds.includes(actual.track) && actual.epoch === s.epoch)
      .map(actual => `${s.names.get(actual.track)} 音源位置 ${(actual.source_position / sampleRate).toFixed(2)} 秒`).join(' ｜ ') || '独立音源播放位置将在首次配置后回读';
    const range = q('scRateRange'); range.min = s.min; range.max = s.max; range.value = s.value;
    range.disabled = s.confirmation || s.finishing || s.observing || !!s.error;
    q('scRateStatus').textContent = s.status;
    q('scRateEnableEyes').classList.toggle('hidden', eyesEnabled() || !onEnableEyes);
    q('scRateEnableEyes').disabled = s.finishing || !!s.error || !client.connected;
    for (const id of ['scRateLess','scRateMore']) q(id).disabled = s.confirmation || s.finishing || s.observing || !!s.error;
    q('scRateRestore').disabled = s.finishing || s.observing || !!s.error;
    q('scRateKeep').disabled = s.finishing;
    q('scRateDiscard').disabled = s.finishing;
    q('scRateObserve').disabled = s.finishing || !!s.error;
    q('scRateObserve').textContent = s.observing ? '恢复调节' : '进入观察模式';
  }
  function failed(s, error) {
    if (session !== s) return;
    s.error = error; s.stream?.dropPending(); s.controller?.pause(s.lastFeatureTime); s.ownsFinal = false;
    s.status = `${error.message}${error.mayHaveExecuted ? '；可能已执行，未自动重发，请重新连接核对实际倍率' : ''}`;
    onError?.(error); report('音轨变速',s.status,false); render();
  }
  function syncValue(s) {
    s.value = s.trackIds.length === 1 ? s.confirmedTargets[0].rate : s.confirmedTargets[0].rate / s.originalTargets[0].rate;
    s.targets = s.confirmedTargets.map(target => ({...target}));
    if (s.controller) s.controller.value = s.value;
  }
  function pause(s, message, manual = false) {
    s.controller?.pause(s.lastFeatureTime); if (s.controller) s.controller.smoothed = null;
    if (!manual) { s.stream?.dropPending(); if (!s.confirmation) syncValue(s); s.zone = 'lost'; }
    s.status = message; render();
  }
  function accept(s, snapshot, meta = []) {
    if (session !== s) return;
    if (snapshot.projectKey !== s.projectKey || snapshot.epoch !== s.epoch) throw new Error('变速回读来自其他工程或会话');
    const confirmed = targetStates(snapshot,s.trackIds,true);
    const changed = !targetsEqual(confirmed,s.confirmedTargets) || stateKey(snapshot,s.trackIds) !== stateKey(s.resultSnapshot,s.trackIds);
    s.confirmedTargets = confirmed; s.resultSnapshot = snapshot; s.unconfigured = false;
    s.wrote ||= changed; s.lastOwnedSnapshot = snapshot;
    if (s.observing || ['center','lost'].includes(s.zone)) syncValue(s);
    if (!s.finishing) {
      s.status = `音频回调已确认：${confirmed.map(target => label(s,target)).join(' ｜ ')}`;
      if (changed && meta.length) report(s.lastInputGesture || '倍率调节',s.status,true,s.lastInputSource || '手动操作');
    }
    render();
  }
  function setTarget(s, value, source, gesture, fromController = false) {
    if (session !== s || s.confirmation || s.finishing || s.observing || s.error || !finite(value)) return;
    const bounded = clamp(value,s.min,s.max);
    const next = bounded === s.min || bounded === s.max ? bounded : clamp(Math.round(bounded * 1000) / 1000,s.min,s.max);
    if (Math.abs(next - s.value) < 1e-10) return;
    s.value = next;
    s.targets = s.trackIds.length === 1 ? [{track:s.trackIds[0],rate:next}]
      : s.originalTargets.map(target => ({track:target.track,rate:clamp(target.rate * next,.5,2)}));
    if (s.controller && !fromController) s.controller.value = next;
    s.lastInputSource = source; s.lastInputGesture = gesture;
    try { s.stream.set(s.targets); s.status = '目标倍率已排队，等待音频回调实际确认…'; }
    catch (error) { failed(s,error); }
    render();
  }
  function close(s) {
    if (session !== s) return;
    session = null; render(); onState?.(false,s);
  }
  function attachStream(s, snapshot) {
    return rates.createStream(s.trackIds,s.loop,snapshot,{intervalMs:200,
      onConfirmed:(actual,targets)=>{try{accept(s,actual,targets);}catch(error){failed(s,error);}},onError:error=>failed(s,error)});
  }
  async function finish(kind, source = '手动操作', note = '') {
    const s = session; if (!s || s.finishing) return;
    if (s.observing && kind !== 'discard') { report(kind === 'restore' ? '上看' : '下看','观察模式中，请先恢复调节',false,source); return; }
    if (s.error) { report('关闭倍率弹窗','连接异常，已停止调节；请重新连接核对实际倍率',false,source); await s.stream?.cancel().catch(()=>{}); close(s); return; }
    s.finishing = true; s.controller?.pause(s.lastFeatureTime); const ticket = generation; render();
    try {
      const project = issue(s); if (project) throw new Error(project);
      if (s.confirmation) {
        if (kind === 'restore') {
          s.targets = s.originalTargets.map(target=>({...target})); s.status = `${note}已恢复打开时的目标，尚未发送；弹窗保持打开`;
          report('上看',s.status,true,source); return;
        }
        if (kind === 'keep' && !targetsEqual(s.targets,s.originalTargets)) {
          const result = await rates.set(s.targets,s.loop,s.openingSnapshot);
          if (ticket !== generation || session !== s) return;
          accept(s,result,s.targets); s.ownsFinal = true; s.committed = true;
        }
        if (kind === 'keep') report('下看',`${note}已确认保留倍率并关闭；播放时间不回退`,true,source);
        else report('双眨',`${note}已取消本次倍率确认，未发送修改`,true,source);
        close(s); return;
      }
      if (kind !== 'keep') s.stream.dropPending();
      s.status = '正在等待最终倍率的音频回调确认…'; render();
      await s.stream.flush();
      if (ticket !== generation || session !== s) return;
      if (kind !== 'keep' && s.wrote) {
        s.stream.set(s.originalTargets); await s.stream.flush();
        if (ticket !== generation || session !== s) return;
      }
      // Release the stream before its final read; the adapter forbids polling
      // against an active stream. Up creates a fresh stream only after verification.
      await s.stream.cancel();
      if (ticket !== generation || session !== s) return;
      const final = await rates.read();
      if (ticket !== generation || session !== s) return;
      if (final.projectKey !== s.projectKey || final.epoch !== s.epoch) throw new Error('工程或变速会话已变化，未确认最终倍率');
      const actual = targetStates(final,s.trackIds,s.wrote);
      if (stateKey(final,s.trackIds) !== stateKey(s.stream.currentSnapshot,s.trackIds)) throw new Error('音轨倍率已被其他操作修改，未覆盖外部变化');
      s.confirmedTargets = actual; s.resultSnapshot = final;
      s.ownsFinal = s.wrote && stateKey(final,s.trackIds) === stateKey(s.lastOwnedSnapshot,s.trackIds);
      if (kind !== 'keep' && !targetsEqual(actual,s.originalTargets)) throw new Error('实际倍率没有恢复到打开时的值，请重新连接核对');
      syncValue(s);
      if (kind === 'restore') {
        s.stream = attachStream(s,final);
        s.status = `${note}已恢复打开时倍率；弹窗保持打开，不恢复历史播放时刻`;
        report('上看',s.status,true,source); return;
      }
      s.committed = kind === 'keep';
      report(kind === 'keep' ? '下看' : '双眨',`${note}${kind === 'keep' ? '已保留实际倍率' : '已恢复打开时倍率并放弃本次调节'}；循环边界及播放时间不变`,true,source);
      await s.stream.cancel(); if (ticket === generation && session === s) close(s);
    } catch (error) { if (ticket === generation && session === s) failed(s,error); }
    finally { if (session === s) { s.finishing = false; render(); } }
  }
  function observe(source) {
    const s = session; if (!s || s.finishing || s.error) return;
    s.observing = !s.observing;
    pause(s,s.observing ? '观察模式：倍率调节冻结，音乐继续播放' : '已恢复调节，请回中央后重新看向左右');
    report('长眨',s.status,true,source);
  }
  root.onclick = event => {
    const button = event.target.closest('button'); if (!button || button.disabled || !session) return;
    event.stopPropagation?.();
    if (button.id === 'scRateEnableEyes') {
      onEnableEyes?.(); pause(session,session.observing ? '观察模式：倍率调节冻结，音乐继续' : eyeIssue(session) || '眼动真实控制已开启，请回中央后看向左右',session.zone === 'manual');
    } else if (button.id === 'scRateRestore') void finish('restore');
    else if (button.id === 'scRateKeep') void finish('keep');
    else if (button.id === 'scRateDiscard') void finish('discard');
    else if (button.id === 'scRateObserve') observe('手动操作');
    else if (button.id === 'scRateLess' || button.id === 'scRateMore') {
      const s = session; s.zone = 'manual'; setTarget(s,s.value + (button.id === 'scRateMore' ? .01 : -.01),'手动操作',button.textContent);
      s.controller?.pause(s.lastFeatureTime);
    }
  };
  root.oninput = event => {
    if (event.target.id !== 'scRateRange' || !session) return;
    const s = session; s.zone = 'manual'; setTarget(s,Number(event.target.value),'手动操作','鼠标倍率滑块'); s.controller?.pause(s.lastFeatureTime);
  };
  root.addEventListener('keydown',event => {
    if (!session) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation?.(); void finish('discard'); }
    if (event.key === 'Tab') {
      const controls = ['scRateRange',...(!eyesEnabled() && onEnableEyes ? ['scRateEnableEyes'] : []),'scRateLess','scRateMore','scRateRestore','scRateKeep','scRateObserve','scRateDiscard'].map(q).filter(node=>!node.disabled);
      if (!controls.length) event.preventDefault();
      else if (event.shiftKey && event.target === controls[0]) { event.preventDefault(); controls.at(-1).focus?.(); }
      else if (!event.shiftKey && event.target === controls.at(-1)) { event.preventDefault(); controls[0].focus?.(); }
    }
  });
  render();
  return {
    isOpen:()=>!!session,
    open(trackIds,{reset=false,confirmTargets,title}={}) {
      if (session) return false;
      if (!client.connected || !rates.snapshot || rates.snapshot.projectKey !== client.snapshot?.projectKey || !rates.snapshot.epoch) throw new Error('请先读取扩展版 SoundCraft 的变速状态');
      if (!Array.isArray(trackIds) || trackIds.length < 1 || trackIds.length > 2 || new Set(trackIds).size !== trackIds.length) throw new Error('请选择单轨或 A/B 两条不同音轨');
      if (confirmTargets !== undefined && (!Array.isArray(confirmTargets) || confirmTargets.length !== trackIds.length
        || confirmTargets.some(target=>!target || !trackIds.includes(target.track) || !finite(target.rate) || target.rate < .5 || target.rate > 2)
        || new Set(confirmTargets.map(target=>target.track)).size !== trackIds.length)) throw new Error('候选倍率需完整对应选定音轨，且必须在 0.5–2.0× 范围内；不会自动截断');
      if (reset && confirmTargets !== undefined) throw new Error('原速恢复与候选倍率确认不能同时指定');
      const snapshot = rates.snapshot, originalTargets = targetStates(snapshot,trackIds);
      const confirmation = reset || confirmTargets !== undefined;
      const loops = snapshot.tracks.filter(state=>trackIds.includes(state.track) && state.loop).map(state=>state.loop);
      if (loops.some(loop=>!sameLoop(loop,loops[0]))) throw new Error('A/B 已有音源循环范围不同，请先暂停并设置相同范围，再开启联动');
      const loop = loops[0] || snapshot.sourceLoop;
      if (!validLoop(loop) || !finite(snapshot.sampleRate) || snapshot.sampleRate <= 0) throw new Error('固定音源循环范围或采样率未就绪');
      const names = new Map(trackIds.map(id=>[id,client.snapshot.tracks.find(track=>track.id===id)?.name || `音轨 ${id}`]));
      const e = environment(), settings = e.sliderSettings || {};
      const min = trackIds.length === 1 ? .5 : Math.max(...originalTargets.map(target=>.5/target.rate));
      const max = trackIds.length === 1 ? 2 : Math.min(...originalTargets.map(target=>2/target.rate));
      const initial = trackIds.length === 1 ? originalTargets[0].rate : 1;
      const s = {trackIds:[...trackIds],projectKey:snapshot.projectKey,epoch:snapshot.epoch,loop:{...loop},names,min,max,value:initial,reset:!!reset,confirmation,title:typeof title==='string' && title ? title : reset ? '恢复原速 · 确认' : '匹配播放倍率 · 确认',
        originalTargets,confirmedTargets:originalTargets.map(target=>({...target})),targets:reset ? originalTargets.map(target=>({...target,rate:1})) : confirmTargets ? confirmTargets.map(target=>({...target})) : originalTargets.map(target=>({...target})),
        openingSnapshot:snapshot,resultSnapshot:snapshot,lastOwnedSnapshot:snapshot,calibration:e.calibration,
        unconfigured:trackIds.some(id=>snapshot.tracks.find(state=>state.track===id).loop===null),lastFace:-Infinity,lastFeatureTime:null,
        openedAt:now(),zone:'center',observing:false,finishing:false,error:null,wrote:false,committed:false,ownsFinal:false,stream:null};
      const scale = .01;
      s.controller = e.calibration ? new GazeSliderController(e.calibration,{...settings,minRatePerSec:(settings.minRatePerSec??5)*scale,maxRatePerSec:(settings.maxRatePerSec??35)*scale},{min,max,initialValue:initial}) : null;
      if (!confirmation) s.stream = attachStream(s,snapshot);
      s.status = confirmation ? '候选倍率尚未发送；下看确认，上看恢复打开时目标，双眨取消' : eyeIssue(s) || '眼动条件已就绪，等待有效人脸视线；也可用鼠标调节';
      generation++; session=s; render(); onState?.(true,s); (confirmation ? q('scRateKeep') : q('scRateRange')).focus?.(); return true;
    },
    detach() {
      generation++; const s=session;session=null;
      if(s){s.stream?.dropPending();void s.stream?.cancel().catch(()=>{});onState?.(false,s);}render();
    },
    gesture(gesture,source,note='') {
      const s=session;if(!s||s.finishing)return;
      const blocked=eyeIssue(s);
      if(source==='眼动识别'&&(blocked||now()-s.lastFace>750)){pause(s,blocked||'近期有效人脸视线缺失，已暂停眼动调节',s.zone==='manual');report(gesture,s.status,false,source);return;}
      if(gesture==='长眨')observe(source);
      else if(gesture==='上看')return finish('restore',source,note);
      else if(gesture==='下看')return finish('keep',source,note);
      else if(gesture==='双眨')return finish('discard',source,note);
    },
    frame(raw,t=now()) {
      const s=session;if(!s||s.finishing||s.error)return;
      s.lastFeatureTime=t;const valid=raw&&gazeSignal(raw,environment().sliderSettings?.headCompensation)!==null;s.lastFace=valid?now():-Infinity;
      const blocked=eyeIssue(s);
      if(!valid||blocked||s.observing){pause(s,s.observing?'观察模式：倍率调节冻结，音乐继续':blocked||'未检测到有效人脸或虹膜信号，已暂停调节',s.zone==='manual'&&!s.observing);return;}
      if(s.confirmation)return;
      const next=s.controller.updateFrame(raw,t),manual=s.zone==='manual';
      if(!manual||Math.abs(next.delta)>0)s.zone=next.zone;
      if(Math.abs(next.delta)>0)setTarget(s,next.value,'眼动识别',next.delta>0?'右看':'左看',true);
      else if(next.zone==='center'&&!manual)pause(s,'回中央停止倍率调节');
      else if(!manual&&['left-wait','right-wait'].includes(next.zone)){s.status='已检测到视线，停留确认中…';render();}
    },
    tick() {
      const s=session;if(!s||s.finishing||s.error)return;
      const blocked=eyeIssue(s);
      if(blocked)pause(s,blocked,s.zone==='manual'&&!s.observing);
      else if(s.zone!=='manual'&&now()-s.lastFace>750)pause(s,'画面中断，已暂停倍率调节');
      if(now()-s.openedAt>(environment().sliderSettings?.timeoutMs??20000))void finish('discard','系统','弹窗超时，');
    },
  };
}

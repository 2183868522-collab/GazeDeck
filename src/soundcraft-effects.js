import { GazeSliderController, gazeSignal } from './gaze-slider.js';
import { EFFECTS, EFFECT_LABELS, effectTarget, effectInsertKey } from './soundcraft-effects-client.js';

const finite=value=>typeof value==='number' && Number.isFinite(value);
const clamp=value=>Math.max(0,Math.min(100,value));
const percent=value=>`${Number((value*100).toFixed(3))}%`;
const equalTargets=(a,b)=>a.length===b.length && a.every(x=>b.some(y=>x.track===y.track && x.enabled===y.enabled && x.amount===y.amount));
const insertsKey=track=>JSON.stringify([track?.kind,track?.inactive,track?.automationMode,track?.automation,
  Array.isArray(track?.inserts)?track.inserts.map(insert=>[insert.slot,effectInsertKey(insert)]).sort(([a],[b])=>a-b):null]);

// Intensity is a local wet/dry draft. Keep sends one atomic native CAS; no frame,
// reset, observation, discard or timeout writes an engine parameter.
export function mountSoundCraftEffects(root,{client,effects,environment,eyesEnabled,onEnableEyes,onResult,onState,onError,now=()=>performance.now()}) {
  let session=null,generation=0;
  const q=id=>root.querySelector(`#${id}`);
  root.innerHTML=`<div class="sc-volume-card">
    <span class="eyebrow">SoundCraft · 声音与效果 · 原生效果强度</span>
    <h2 id="scFxTitle"></h2><p id="scFxOriginal" class="muted"></p>
    <div class="sc-live-values"><div>待提交湿／干比例<strong id="scFxValue" style="font-size:24px;white-space:pre-line"></strong></div></div>
    <p id="scFxState" class="muted"></p>
    <input id="scFxRange" type="range" min="0" max="100" step="any" aria-label="SoundCraft 效果强度草稿" style="width:100%">
    <p id="scFxStatus" role="status" aria-live="polite"></p>
    <button id="scFxEnableEyes" class="primary hidden">开启本区眼动真实控制</button>
    <p>左右视线连续调整 0–100% 湿／干比例草稿，回中央停止；下看提交后生效。上看恢复打开时各轨强度并保持弹窗；下看提交一次并关闭。长眨观察／恢复，双眨或 Esc 放弃草稿。</p>
    <div class="row sc-live-actions"><button id="scFxLess">−1%</button><button id="scFxMore">+1%</button><button id="scFxRestore">上看 · 恢复打开时强度</button><button id="scFxKeep" class="primary">下看 · 提交并关闭</button><button id="scFxObserve">进入观察模式</button><button id="scFxDiscard">放弃调节</button></div>
    <p class="muted">仅改变所选原生效果的湿／干比例，保持各轨效果开关状态。A/B 原值不同则分别显示；首次左右或手动调节后采用共同的绝对强度。草稿、放弃和超时均不发送修改，不改变循环或播放位置。</p>
  </div>`;
  function report(gesture,message,executed,source='手动操作') {
    onResult?.(gesture,{executed,feedback:true,message,from:'SoundCraft 原生效果',to:'SoundCraft 原生效果'},source);
  }
  function projectIssue(s) {
    if(!client.connected)return 'SoundCraft 连接已失效，请关闭弹窗并重新连接';
    if(client.snapshot?.projectKey!==s.projectKey || client.snapshot?.playbackRateEpoch!==s.epoch || effects.snapshot?.projectKey!==s.projectKey
      || effects.snapshot?.epoch!==s.epoch || client._generation!==s.coreGeneration || client._binding!==s.coreBinding)
      return 'SoundCraft 工程、连接或效果会话已变化，请关闭后重新连接';
    for(const trackId of s.trackIds) {
      const target=effectTarget(effects.snapshot,trackId,s.effect),old=effectTarget(s.openingSnapshot,trackId,s.effect);
      if(!target.available)return target.reason||'目标音轨效果尚未就绪';
      if(target.slot!==old.slot || effectInsertKey(target.insert)!==effectInsertKey(old.insert)
        || target.amount!==old.amount || target.enabled!==old.enabled
        || insertsKey(client.snapshot.tracks.find(track=>track.id===trackId))!==s.coreStates.get(trackId))
        return '效果插槽、插件参数或自动化已在其他位置变化，请关闭后重新读取；未覆盖外部修改';
    }
    return '';
  }
  function readinessIssue(s) {
    const issue=projectIssue(s),e=environment();if(issue)return issue;
    if(!eyesEnabled())return '尚未开启本区眼动真实控制；请点击下方「开启本区眼动真实控制」';
    if(!e.camera)return '摄像头未运行或视频流暂不可用，请检查摄像头';
    if(!e.baseline)return '静息校准未就绪，请先完成或选择已有的静息校准环境';
    if(e.sliderSettings?.enabled===false)return '视线滑块已在⑤设置中关闭，请启用「连续滑块控制」';
    if(!e.calibration)return '当前环境的滑块左右标尺未就绪，请在①校准与录制的第4步完成校准';
    if(e.calibration!==s.calibration || !s.controller)return '滑块校准环境已变化，请关闭后重新打开此弹窗';
    return '';
  }
  const label=(s,target)=>`${s.names.get(target.track)} ${percent(target.amount)}`;
  function render() {
    const s=session;root.classList.toggle('hidden',!s);if(!s)return;
    q('scFxTitle').textContent=`${s.trackIds.length===2?'Deck A/B':s.names.get(s.trackIds[0])} · ${EFFECT_LABELS[s.effect]}强度`;
    q('scFxOriginal').textContent=`固定目标 ID ${s.trackIds.join(' / ')} · 打开时：${s.originalTargets.map(target=>label(s,target)).join(' ｜ ')}`;
    q('scFxValue').textContent=s.targets.map(target=>label(s,target)).join('\n');
    q('scFxState').textContent=s.originalTargets.map(target=>`${s.names.get(target.track)}：${target.enabled?'开启':'关闭，修改强度不会自动开启'}`).join(' ｜ ')
      +(s.mixed?' · 当前原值不同；首次调整后两轨采用相同强度':'');
    q('scFxRange').value=s.value;q('scFxRange').disabled=s.finishing || s.observing || !!s.error;
    q('scFxStatus').textContent=s.status;
    q('scFxEnableEyes').classList.toggle('hidden',eyesEnabled() || !onEnableEyes);
    q('scFxEnableEyes').disabled=s.finishing || !!s.error || !client.connected;
    for(const id of ['scFxLess','scFxMore','scFxRestore'])q(id).disabled=s.finishing || s.observing || !!s.error;
    q('scFxKeep').disabled=s.finishing;q('scFxDiscard').disabled=s.finishing;
    q('scFxObserve').disabled=s.finishing || !!s.error;q('scFxObserve').textContent=s.observing?'恢复调节':'进入观察模式';
  }
  function pause(s,message) {
    s.controller?.pause(s.lastFeatureTime);if(s.controller)s.controller.smoothed=null;
    if(s.zone!=='manual')s.zone='lost';s.status=message;render();
  }
  function setDraft(s,value,fromController=false) {
    if(session!==s || s.finishing || s.observing || s.error || !finite(value))return;
    s.value=clamp(fromController?Math.round(value*10)/10:value);s.mixed=false;
    s.targets=s.originalTargets.map(target=>({...target,amount:s.value/100}));
    if(s.controller && !fromController)s.controller.value=s.value;
    s.status='仅调整效果强度草稿，尚未发送；下看提交后生效';render();
  }
  function close(s,committed=false) {
    if(session!==s)return;s.committed=committed;session=null;render();onState?.(false,s);
  }
  function failed(s,error) {
    if(session!==s)return;s.error=error;s.controller?.pause(s.lastFeatureTime);
    s.status=`${error.message}${error.mayHaveExecuted?'；效果修改可能已执行，未自动重发，请重新连接核对':''}`;
    onError?.(error);report('效果强度',s.status,false);render();
  }
  async function finish(kind,source='手动操作',note='') {
    const s=session;if(!s || s.finishing)return;
    if(kind==='discard') {report('双眨',s.error?'已关闭弹窗；此前效果提交结果未确认，请重新连接核对':`${note}已放弃效果强度草稿；未提交参数修改`,!s.error,source);close(s);return;}
    if(s.error) {report('关闭效果','连接异常，已关闭弹窗；请重新连接核对实际效果',false,source);close(s);return;}
    if(s.observing) {report(kind==='restore'?'上看':'下看','观察模式中，请先恢复调节',false,source);return;}
    if(kind==='restore') {
      s.targets=structuredClone(s.originalTargets);s.value=s.originalValue;s.mixed=s.originalMixed;
      if(s.controller){s.controller.value=s.value;s.controller.pause(s.lastFeatureTime);}
      s.zone='center';s.status=`${note}已恢复打开时各轨的强度草稿，弹窗保持打开；未提交效果修改`;
      report('上看',s.status,true,source);render();return;
    }
    if(equalTargets(s.targets,s.originalTargets)) {report('下看',`${note}草稿未更改，已关闭弹窗；未提交效果修改`,true,source);close(s);return;}
    const issue=projectIssue(s);if(issue){failed(s,new Error(issue));return;}
    const ticket=generation,targets=structuredClone(s.targets);s.finishing=true;s.controller?.pause(s.lastFeatureTime);
    s.status='正在提交一次效果修改并等待 SoundCraft 实际参数回读…';render();
    try {
      const result=await effects.set(s.effect,targets,s.openingSnapshot);
      if(ticket!==generation || session!==s)return;
      if(!result || result.projectKey!==s.projectKey || result.epoch!==s.epoch || result.effect!==s.effect
        || typeof result.changed!=='boolean' || !Array.isArray(result.updated) || !Array.isArray(result.previous) || !Array.isArray(result.after)
        || new Set(result.updated).size!==result.updated.length || result.updated.some(track=>!s.trackIds.includes(track))
        || result.changed!==(result.updated.length>0) || result.previous.length!==result.updated.length || result.after.length!==result.updated.length
        || result.updated.some(track=>{
          const old=effectTarget(s.openingSnapshot,track,s.effect),actual=effectTarget(result,track,s.effect);
          const previous=result.previous.filter(entry=>entry?.track===track),after=result.after.filter(entry=>entry?.track===track);
          return previous.length!==1 || after.length!==1 || previous[0].slot!==old.slot || after[0].slot!==old.slot
            || effectInsertKey(previous[0].insert)!==effectInsertKey(old.insert) || effectInsertKey(after[0].insert)!==effectInsertKey(actual.insert);
        })
        || targets.some(target=>{const actual=effectTarget(result,target.track,s.effect);return !actual.available
          || actual.enabled!==target.enabled || !finite(actual.amount) || Math.abs(actual.amount-target.amount)>1e-7;})) {
        throw Object.assign(new Error('SoundCraft 未返回有效的效果参数修改回执，请重新连接核对'),{mayHaveExecuted:true});
      }
      s.result=result;report('下看',`${note}${EFFECT_LABELS[s.effect]}实际参数已确认：${targets.map(target=>label(s,target)).join(' ｜ ')}；循环与播放位置不变`,true,source);
      close(s,result.changed);
    } catch(error) {if(ticket===generation && session===s)failed(s,error);}
    finally {if(session===s){s.finishing=false;render();}}
  }
  function observe(source) {
    const s=session;if(!s || s.finishing || s.error)return;s.observing=!s.observing;
    pause(s,s.observing?'观察模式：效果强度草稿冻结，工程按原状态运行':'已恢复调节，请回中央后重新看向左右');report('长眨',s.status,true,source);
  }
  root.onclick=event=>{
    const button=event.target.closest('button');if(!button || button.disabled || !session)return;event.stopPropagation?.();
    if(button.id==='scFxEnableEyes') {onEnableEyes?.();pause(session,session.observing?'观察模式：效果强度草稿冻结，工程按原状态运行':readinessIssue(session)||'眼动真实控制已开启，请回中央后看向左右');}
    else if(button.id==='scFxRestore')void finish('restore');else if(button.id==='scFxKeep')void finish('keep');
    else if(button.id==='scFxDiscard')void finish('discard');else if(button.id==='scFxObserve')observe('手动操作');
    else if(['scFxLess','scFxMore'].includes(button.id)) {const s=session;s.zone='manual';setDraft(s,s.value+(button.id==='scFxMore'?1:-1));s.controller?.pause(s.lastFeatureTime);}
  };
  root.oninput=event=>{if(event.target.id!=='scFxRange' || !session)return;const s=session;s.zone='manual';setDraft(s,Number(event.target.value));s.controller?.pause(s.lastFeatureTime);};
  root.addEventListener('keydown',event=>{
    if(!session)return;
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation?.();void finish('discard');}
    if(event.key==='Tab') {
      const controls=['scFxRange',...(!eyesEnabled() && onEnableEyes?['scFxEnableEyes']:[]),'scFxLess','scFxMore','scFxRestore','scFxKeep','scFxObserve','scFxDiscard'].map(q).filter(node=>!node.disabled);
      if(!controls.length)event.preventDefault();else if(event.shiftKey && event.target===controls[0]){event.preventDefault();controls.at(-1).focus?.();}
      else if(!event.shiftKey && event.target===controls.at(-1)){event.preventDefault();controls[0].focus?.();}
    }
  });
  render();
  return {
    isOpen:()=>!!session,
    open(trackIds,effect) {
      if(session)return false;
      const snapshot=effects.snapshot;
      if(!client.connected || !snapshot || !snapshot.epoch || snapshot.projectKey!==client.snapshot?.projectKey
        || client.snapshot?.playbackRateEpoch!==snapshot.epoch)throw new Error('请先连接并读取有效的 SoundCraft 效果状态');
      if(!EFFECTS.includes(effect))throw new Error('请选择混响、延迟或合唱效果');
      if(!Array.isArray(trackIds) || trackIds.length<1 || trackIds.length>2 || new Set(trackIds).size!==trackIds.length)throw new Error('请选择 1–2 条不同的真实音频轨道');
      const originalTargets=trackIds.map(track=>{
        const target=effectTarget(snapshot,track,effect);if(!target.available)throw new Error(target.reason||'目标音轨效果尚未就绪');
        if(target.insert===null)throw new Error('请先开启所选轨道效果器再调节强度；关闭且尚未插入的效果不会保存强度草稿');
        if(!finite(target.amount) || target.amount<0 || target.amount>1)throw new Error('效果强度无效，请重新读取');
        return {track,enabled:target.enabled,amount:target.amount};
      });
      const e=environment(),settings=e.sliderSettings||{},originalValue=originalTargets.reduce((sum,target)=>sum+target.amount*100,0)/originalTargets.length;
      const s={trackIds:[...trackIds],effect,projectKey:snapshot.projectKey,epoch:snapshot.epoch,openingSnapshot:structuredClone(snapshot),
        coreGeneration:client._generation,coreBinding:client._binding,
        coreStates:new Map(trackIds.map(id=>[id,insertsKey(client.snapshot.tracks.find(track=>track.id===id))])),
        names:new Map(trackIds.map(id=>[id,client.snapshot.tracks.find(track=>track.id===id)?.name||`音轨 ${id}`])),
        originalTargets,targets:structuredClone(originalTargets),originalValue,value:originalValue,
        originalMixed:originalTargets.some(target=>target.amount!==originalTargets[0].amount),
        calibration:e.calibration,lastFeatureTime:null,lastFace:-Infinity,openedAt:now(),zone:'center',observing:false,
        finishing:false,error:null,committed:false,result:null,status:''};
      s.mixed=s.originalMixed;
      s.controller=e.calibration?new GazeSliderController(e.calibration,settings,{min:0,max:100,initialValue:s.value}):null;
      s.status=readinessIssue(s)||'眼动条件已就绪，等待有效人脸视线；当前仅为强度草稿，下看提交后生效';
      generation++;session=s;render();onState?.(true,s);q('scFxRange').focus?.();return true;
    },
    detach(){generation++;const s=session;session=null;render();if(s)onState?.(false,s);},
    gesture(gesture,source,note='') {
      const s=session;if(!s || s.finishing)return;
      const issue=readinessIssue(s);
      if(source==='眼动识别' && (issue || now()-s.lastFace>750)){pause(s,issue||'未收到近期有效人脸视线，已暂停眼动调节');report(gesture,s.status,false,source);return;}
      if(gesture==='长眨')observe(source);else if(gesture==='上看')return finish('restore',source,note);
      else if(gesture==='下看')return finish('keep',source,note);else if(gesture==='双眨')return finish('discard',source,note);
    },
    frame(raw,t=now()) {
      const s=session;if(!s || s.finishing || s.error)return;s.lastFeatureTime=t;
      const validSignal=raw && gazeSignal(raw,environment().sliderSettings?.headCompensation)!==null;
      s.lastFace=validSignal?now():-Infinity;const issue=readinessIssue(s);
      if(!validSignal || issue || s.observing){pause(s,s.observing?'观察模式：效果强度草稿冻结，工程按原状态运行':issue||(!raw?'未检测到人脸，已暂停效果强度草稿调节':'已收到人脸数据，但本帧虹膜信号无效，已暂停效果强度草稿调节'));return;}
      const next=s.controller.updateFrame(raw,t),manual=s.zone==='manual';if(!manual || Math.abs(next.delta)>0)s.zone=next.zone;
      if(Math.abs(next.delta)>0)setDraft(s,next.value,true);
      else if(next.zone==='center' && !manual){s.status='回中央停止；当前效果强度仅为草稿，下看提交后生效';render();}
      else if(!manual && ['left-wait','right-wait'].includes(next.zone)){s.status=`已检测到有效视线，向${next.zone==='left-wait'?'左':'右'}停留确认中…`;render();}
    },
    tick() {
      const s=session;if(!s || s.finishing || s.error)return;const issue=readinessIssue(s);
      if(issue)pause(s,issue);else if(s.zone!=='manual' && s.zone!=='lost' && now()-s.lastFace>750)pause(s,'画面中断，已暂停效果强度草稿调节');
      if(now()-s.openedAt>(environment().sliderSettings?.timeoutMs??20000))void finish('discard','系统','弹窗超时，');
    },
  };
}

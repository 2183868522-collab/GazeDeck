import {GazeSliderController, gazeSignal} from './gaze-slider.js';
import {eqTarget} from './soundcraft-client.js';
import {toneTarget} from './soundcraft-presets-client.js';

const finite=value=>typeof value==='number' && Number.isFinite(value);
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
const clone=value=>structuredClone(value);
const db=value=>`${value>0?'+':''}${Number(value.toFixed(3))} dB`;
const bands={low:'LOW · 低频',mid:'MID · 中频',high:'HIGH · 高频'};
const chainKey=inserts=>Array.isArray(inserts)?JSON.stringify([...inserts].sort((a,b)=>a.slot-b.slot).map(insert=>[
  insert.slot,insert.plugin,insert.bypass,Object.entries(insert.params||{}).sort(([a],[b])=>a.localeCompare(b)),
])):'';
const gain=(original,offset)=>{
  const value=original+offset;
  // Snap floating-point residue only at the shared interval endpoints.
  if(Math.abs(value-24)<1e-8)return 24;
  if(Math.abs(value+24)<1e-8)return -24;
  return value;
};

// AB EQ edits a relative common offset as a local draft, then submits one native
// tone transaction. Only the selected gain (and a newly needed EQ) may change.
export function mountSoundCraftLinkedEq(root,{client,tones,environment,eyesEnabled,onEnableEyes,onResult,onState,onError,now=()=>performance.now()}) {
  let session=null,generation=0;
  const q=id=>root.querySelector(`#${id}`);
  root.innerHTML=`<div class="sc-volume-card">
    <span class="eyebrow">SoundCraft · AB 联动三段 EQ · 相对偏移</span>
    <h2 id="scLinkedEqTitle"></h2><p id="scLinkedEqOriginal" class="muted"></p>
    <div class="sc-live-values"><div>共同偏移草稿<strong id="scLinkedEqOffset"></strong></div><div>两轨增益草稿<strong id="scLinkedEqValue" style="font-size:21px;white-space:pre-line"></strong></div></div>
    <p id="scLinkedEqFrequency" class="muted"></p><p id="scLinkedEqBounds" class="muted"></p>
    <input id="scLinkedEqRange" type="range" step="any" aria-label="SoundCraft AB EQ 共同偏移草稿" style="width:100%">
    <p id="scLinkedEqStatus" role="status" aria-live="polite"></p>
    <button id="scLinkedEqEnableEyes" class="primary hidden">开启本区眼动真实控制</button>
    <p>左右视线连续调节共同偏移草稿，回中央停止；保持 A/B 原有增益差。上看恢复两轨打开时的原值并保持弹窗；下看一次性应用并关闭。长眨观察／恢复，双眨或 Esc 放弃草稿。</p>
    <div class="row sc-live-actions"><button id="scLinkedEqLess">共同 −1 dB</button><button id="scLinkedEqMore">共同 +1 dB</button><button id="scLinkedEqRestore">上看 · 恢复两轨原值</button><button id="scLinkedEqKeep" class="primary">下看 · 应用并关闭</button><button id="scLinkedEqObserve">进入观察模式</button><button id="scLinkedEqDiscard">放弃草稿</button></div>
    <p class="muted">仅改变所选一个频段；频率、Q、其他频段、FX、音量、倍率、循环与播放进度保持。两轨先整体校验再提交；任一轨到达增益边界时共同停止，不会只移动另一轨。尚未添加 EQ 的轨道仅在非零提交时创建 EQ 7-Band；不会自动启用已旁路的 EQ。</p>
  </div>`;
  function report(gesture,message,executed,source='手动控制') {
    onResult?.(gesture,{executed,message,from:'SoundCraft AB 三段 EQ',to:'SoundCraft AB 三段 EQ'},source);
  }
  function issue(s) {
    if(!client.connected)return 'SoundCraft 连接失效，请关闭弹窗并重新连接';
    const snapshot=client.snapshot;
    if(snapshot?.projectKey!==s.projectKey || snapshot?.playbackRateEpoch!==s.epoch || client._generation!==s.coreGeneration
      || client._binding!==s.coreBinding || tones.snapshot?.projectKey!==s.projectKey || tones.snapshot?.epoch!==s.epoch)
      return 'SoundCraft 工程或连接会话已变化，请关闭并重新读取';
    for(const original of s.originals) {
      const track=snapshot.tracks.find(item=>item.id===original.track),eq=eqTarget(snapshot,original.track),row=toneTarget(tones.snapshot,original.track);
      if(!eq.supported || !row.available)return eq.reason || row.reason || '所选轨道 EQ 尚未就绪';
      if(chainKey(track?.inserts)!==s.coreChains.get(original.track) || chainKey(row.inserts)!==chainKey(toneTarget(s.openingSnapshot,original.track).inserts))
        return '预览后的插件或 EQ 已在其他位置变化，请关闭后重新读取；未覆盖外部修改';
    }
    return '';
  }
  function readiness(s) {
    const problem=issue(s),e=environment();
    if(problem)return problem;
    if(!eyesEnabled())return '尚未开启本区眼动真实控制，可使用鼠标调节';
    if(!e.camera)return '摄像头未运行，已暂停眼动草稿调节';
    if(!e.baseline)return '静息校准未就绪，已暂停眼动草稿调节';
    if(e.sliderSettings?.enabled===false)return '视线滑块已关闭，请在⑤设置中启用连续滑块控制';
    if(!e.calibration)return '请先完成当前环境的滑块左右标尺校准';
    if(e.calibration!==s.calibration || !s.controller)return '滑块校准环境已变化，请关闭后重新打开弹窗';
    return '';
  }
  function render() {
    const s=session;root.classList.toggle('hidden',!s);if(!s)return;
    q('scLinkedEqTitle').textContent=`Deck AB · ${bands[s.band]}`;
    q('scLinkedEqOriginal').textContent='打开时：'+s.originals.map((entry,i)=>`Deck ${i===0?'A':'B'} → ${entry.name}（ID ${entry.track}） ${db(entry.value)}`).join(' ｜ ');
    q('scLinkedEqOffset').textContent=db(s.offset);
    q('scLinkedEqValue').textContent=s.originals.map((entry,i)=>`Deck ${i===0?'A':'B'} ${db(gain(entry.value,s.offset))}`).join('\n');
    q('scLinkedEqFrequency').textContent=s.originals.map((entry,i)=>`Deck ${i===0?'A':'B'} ${entry.frequency} Hz${entry.missing?'（尚未添加 EQ）':''}`).join(' ｜ ')+' · 频率与 Q 保持';
    q('scLinkedEqBounds').textContent=`共同偏移范围 ${db(s.min)} 至 ${db(s.max)}${s.min===s.max?'；两轨已处于相反边界，不能共同移动':''}`;
    const disabled=s.finishing||s.observing||!!s.error;
    q('scLinkedEqRange').min=s.min;q('scLinkedEqRange').max=s.max;q('scLinkedEqRange').value=s.offset;q('scLinkedEqRange').disabled=disabled||s.min===s.max;
    q('scLinkedEqStatus').textContent=s.status;
    q('scLinkedEqEnableEyes').classList.toggle('hidden',eyesEnabled() || !onEnableEyes);
    q('scLinkedEqEnableEyes').disabled=s.finishing||!!s.error||!client.connected;
    q('scLinkedEqLess').disabled=disabled||s.offset<=s.min;q('scLinkedEqMore').disabled=disabled||s.offset>=s.max;
    q('scLinkedEqRestore').disabled=disabled;
    q('scLinkedEqKeep').disabled=s.finishing||s.observing||!!s.error;
    q('scLinkedEqDiscard').disabled=s.finishing;
    q('scLinkedEqObserve').disabled=s.finishing||!!s.error;
    q('scLinkedEqObserve').textContent=s.observing?'恢复调节':'进入观察模式';
  }
  function pause(s,message) {
    s.controller?.pause(s.lastFeatureTime);if(s.controller)s.controller.smoothed=null;
    if(s.zone!=='manual')s.zone='lost';s.status=message;render();
  }
  function setDraft(s,value,fromController=false) {
    if(session!==s || s.finishing || s.observing || s.error || !finite(value))return;
    s.offset=clamp(Math.round(value*10)/10,s.min,s.max);
    if(!fromController&&s.controller)s.controller.value=s.offset;
    s.status='仅调节 AB 共同增益偏移草稿，尚未发送；下看整批提交后生效';render();
  }
  function close(s,committed=false) {
    if(session!==s)return;s.committed=committed;session=null;render();onState?.(false,s);
  }
  function failed(s,error) {
    if(session!==s)return;s.error=error;s.controller?.pause(s.lastFeatureTime);
    s.status=`${error.message}${error.mayHaveExecuted?'；AB EQ 可能已执行，请重新连接核对，未自动重发':''}`;
    onError?.(error);report('AB EQ',s.status,false);render();
  }
  async function finish(kind,source='手动控制',note='') {
    const s=session;if(!s || s.finishing)return;
    if(kind==='discard') {
      report('双眨',s.error?'已关闭；此前 AB EQ 提交失败或结果未确认，请重新连接核对，未重发':`${note}已放弃 AB EQ 草稿，未提交修改`,!s.error,source);close(s);return;
    }
    if(s.error){report('AB EQ','请关闭弹窗并重新连接核对，未再次提交',false,source);return;}
    if(s.observing){report(kind==='restore'?'上看':'下看','观察模式中，请先长眨恢复',false,source);return;}
    if(kind==='restore') {
      s.offset=0;if(s.controller){s.controller.value=0;s.controller.pause(s.lastFeatureTime);}s.zone='center';
      s.status=`${note}已恢复两轨打开时原值；共同偏移为 0，弹窗保持打开，未提交修改`;
      report('上看',s.status,true,source);render();return;
    }
    if(s.offset===0){report('下看',`${note}草稿未更改，已关闭；没有统一两轨原值，也未添加 EQ`,true,source);close(s);return;}
    const problem=issue(s);if(problem){failed(s,new Error(problem));return;}
    const targets=s.originals.map(original=>{
      const tone=clone(toneTarget(s.openingSnapshot,original.track).tone);
      tone.eq[s.band]=gain(original.value,s.offset);
      if(original.missing)tone.eq.enabled=true;
      return {track:original.track,tone};
    });
    const ticket=generation;s.finishing=true;s.controller?.pause(s.lastFeatureTime);
    s.status='正在整批提交 AB EQ，并等待 SoundCraft 原生回读…';render();
    try {
      const result=await tones.apply(targets,s.openingSnapshot);
      if(ticket!==generation || session!==s)return;
      if(!client.connected || client._generation!==s.coreGeneration || client._binding!==s.coreBinding
        ||client.snapshot?.projectKey!==s.projectKey||client.snapshot?.playbackRateEpoch!==s.epoch
        ||!result || result.projectKey!==s.projectKey || result.epoch!==s.epoch || typeof result.changed!=='boolean'
        || result.changed&&(typeof result.receipt!=='string'||!result.receipt)
        || targets.some(target=>{const actual=toneTarget(result,target.track);return !actual.available||!finite(actual.tone?.eq?.[s.band])
          ||Math.abs(actual.tone.eq[s.band]-target.tone.eq[s.band])>.00001;})) {
        throw Object.assign(new Error('未取得有效的 AB EQ 整批回执，请重新连接核对'),{mayHaveExecuted:true});
      }
      s.result=result;report('下看',`${note}AB ${bands[s.band]} 已整批确认，共同偏移 ${db(s.offset)}；原增益差及播放进度保持`,true,source);
      close(s,result.changed);
    } catch(error){if(ticket===generation&&session===s)failed(s,error);}
    finally{if(session===s){s.finishing=false;render();}}
  }
  function observe(source) {
    const s=session;if(!s||s.finishing||s.error)return;
    s.observing=!s.observing;pause(s,s.observing?'观察模式：AB EQ 草稿冻结，音频按原状态运行':'已恢复草稿调节，请先回中央后再看向左右');report('长眨',s.status,true,source);
  }
  root.onclick=event=>{
    const button=event.target.closest('button');if(!button||button.disabled||!session)return;event.stopPropagation?.();
    if(button.id==='scLinkedEqEnableEyes'){onEnableEyes?.();pause(session,readiness(session)||'眼动真实控制已开启，请回中央后看向左右');}
    else if(button.id==='scLinkedEqKeep')void finish('keep');
    else if(button.id==='scLinkedEqRestore')void finish('restore');
    else if(button.id==='scLinkedEqDiscard')void finish('discard');
    else if(button.id==='scLinkedEqObserve')observe('手动控制');
    else if(['scLinkedEqLess','scLinkedEqMore'].includes(button.id)) {
      session.zone='manual';setDraft(session,session.offset+(button.id==='scLinkedEqMore'?1:-1));session.controller?.pause(session.lastFeatureTime);
    }
  };
  root.oninput=event=>{if(session&&event.target.id==='scLinkedEqRange'){session.zone='manual';setDraft(session,Number(event.target.value));session.controller?.pause(session.lastFeatureTime);}};
  root.addEventListener('keydown',event=>{
    if(!session)return;
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation?.();void finish('discard');}
    if(event.key==='Tab') {
      const controls=['scLinkedEqRange',...(!eyesEnabled()&&onEnableEyes?['scLinkedEqEnableEyes']:[]),'scLinkedEqLess','scLinkedEqMore','scLinkedEqRestore','scLinkedEqKeep','scLinkedEqObserve','scLinkedEqDiscard'].map(q).filter(node=>!node.disabled);
      if(!controls.length)event.preventDefault();
      else if(event.shiftKey&&event.target===controls[0]){event.preventDefault();controls.at(-1).focus?.();}
      else if(!event.shiftKey&&event.target===controls.at(-1)){event.preventDefault();controls[0].focus?.();}
    }
  });
  render();
  return {
    isOpen:()=>!!session,
    open(ids,band) {
      if(session)return false;
      if(!Array.isArray(ids)||ids.length!==2||ids.some(id=>!Number.isSafeInteger(id)||id<=0)||ids[0]===ids[1])throw new Error('AB EQ 需要两个明确绑定且不同的真实轨道 ID');
      if(!Object.hasOwn(bands,band))throw new Error('请选择 Low、Mid 或 High 频段');
      const snapshot=client.snapshot,opening=tones.snapshot;
      if(!client.connected||typeof snapshot?.projectKey!=='string'||!snapshot.projectKey||!opening||opening.projectKey!==snapshot.projectKey
        ||opening.epoch!==snapshot.playbackRateEpoch)throw new Error('请先读取当前工程的完整音色状态，再打开 AB EQ');
      const originals=ids.map(track=>{
        const eq=eqTarget(snapshot,track),row=toneTarget(opening,track),native=snapshot.tracks.find(item=>item.id===track);
        if(!eq.supported||!row.available)throw new Error(eq.reason||row.reason||'目标 EQ 尚未就绪');
        if(!row.tone?.eq||Object.keys({low:0,mid:0,high:0}).some(key=>!finite(row.tone.eq[key])||Math.abs(row.tone.eq[key]-eq.values[key])>.00001)
          ||eq.insert!==null&&row.tone.eq.enabled!==true||chainKey(row.inserts)!==chainKey(native.inserts))throw new Error('完整音色与 EQ 读数不一致，请重新读取');
        return {track,name:native.name||`音轨 ${track}`,value:eq.values[band],frequency:eq.frequencies[band],missing:eq.insert===null};
      });
      const min=Math.max(...originals.map(original=>-24-original.value)),max=Math.min(...originals.map(original=>24-original.value));
      if(!finite(min)||!finite(max)||min>0||max<0||min>max)throw new Error('两轨 EQ 原始增益或可用共同范围无效');
      const e=environment(),settings=e.sliderSettings||{},minRate=clamp((settings.minRatePerSec??5)/10,.5,5),maxRate=clamp((settings.maxRatePerSec??35)/10,minRate,5);
      const s={projectKey:snapshot.projectKey,epoch:opening.epoch,coreGeneration:client._generation,coreBinding:client._binding,
        openingSnapshot:clone(opening),coreChains:new Map(ids.map(id=>[id,chainKey(snapshot.tracks.find(track=>track.id===id).inserts)])),
        trackIds:[...ids],band,originals,min,max,offset:0,calibration:e.calibration,lastFeatureTime:null,lastFace:-Infinity,openedAt:now(),
        zone:'center',observing:false,finishing:false,error:null,committed:false,result:null,status:''};
      s.controller=e.calibration?new GazeSliderController(e.calibration,{...settings,minRatePerSec:minRate,maxRatePerSec:maxRate},{min,max,initialValue:0}):null;
      s.status=readiness(s)||'AB 眼动条件已就绪，等待有效视线；共同偏移草稿为 0，下看才提交';
      generation++;session=s;render();onState?.(true,s);q('scLinkedEqRange').focus?.();return true;
    },
    detach(){generation++;const s=session;session=null;render();if(s)onState?.(false,s);},
    gesture(gesture,source='手动控制',note='') {
      const s=session;if(!s||s.finishing)return;
      const problem=readiness(s);
      if(source==='眼动识别'&&(problem||now()-s.lastFace>750)){pause(s,problem||'未收到近期有效人脸视线，已暂停 AB EQ 草稿调节');report(gesture,s.status,false,source);return;}
      if(gesture==='长眨')observe(source);
      else if(gesture==='上看')return finish('restore',source,note);
      else if(gesture==='下看')return finish('keep',source,note);
      else if(gesture==='双眨')return finish('discard',source,note);
    },
    frame(raw,t=now()) {
      const s=session;if(!s||s.finishing||s.error)return;s.lastFeatureTime=t;
      const valid=raw&&gazeSignal(raw,environment().sliderSettings?.headCompensation)!==null;s.lastFace=valid?now():-Infinity;
      const problem=readiness(s);
      if(!valid||problem||s.observing){pause(s,s.observing?'观察模式：AB EQ 草稿冻结':problem||'未检测到有效人脸／虹膜信号，已暂停 AB EQ 草稿调节');return;}
      const next=s.controller.updateFrame(raw,t),manual=s.zone==='manual';if(!manual||Math.abs(next.delta)>0)s.zone=next.zone;
      if(Math.abs(next.delta)>0)setDraft(s,next.value,true);
      else if(next.zone==='center'&&!manual){s.status='回中央停止；AB EQ 当前仅为共同偏移草稿，下看后才提交';render();}
      else if(!manual&&['left-wait','right-wait'].includes(next.zone)){s.status='已检测到有效视线，等待左右停留确认…';render();}
    },
    tick(){const s=session;if(!s||s.finishing)return;if(s.error)return;
      const problem=readiness(s);if(problem)pause(s,problem);
      else if(s.zone!=='manual'&&s.zone!=='lost'&&now()-s.lastFace>750)pause(s,'画面中断，已暂停 AB EQ 草稿调节');
      if(now()-s.openedAt>(environment().sliderSettings?.timeoutMs??20000))void finish('discard','系统','弹窗超时，');
    },
  };
}

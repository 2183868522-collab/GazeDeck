import { GazeSliderController, gazeSignal } from './gaze-slider.js';
import { levelTarget } from './soundcraft-levels-client.js';
const db=value=>`${value>0?'+':''}${value.toFixed(1)} dB`;
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const same=(a,b)=>a.length===b.length&&a.every(x=>b.some(y=>x.track===y.track&&Math.abs(x.db-y.db)<.00003));

// A common dB offset preserves the opening A/B level difference. The native
// group receipt retains the first before values throughout live updates.
export function mountSoundCraftLinkedVolume(root,{client,levels,environment,eyesEnabled,onResult,onState,onError,now=()=>performance.now()}){
  let session=null,generation=0;const q=id=>root.querySelector(`#${id}`);
  root.innerHTML=`<div class="sc-volume-card"><span class="eyebrow">SoundCraft · AB 联动音量 · 保留原有音量差</span>
    <h2>Deck AB · 连续音量</h2><p id="scLinkedVolumeOriginal" class="muted"></p>
    <div class="sc-live-values"><div>共同偏移<strong id="scLinkedVolumeOffset"></strong></div><div>实际回读<strong id="scLinkedVolumeActual" style="font-size:20px;white-space:pre-line"></strong></div></div>
    <input id="scLinkedVolumeRange" type="range" step="0.1" aria-label="AB 音量共同偏移" style="width:100%"><p id="scLinkedVolumeStatus" role="status" aria-live="polite"></p>
    <p>左右视线连续调节两轨的共同 dB 偏移，回中央停止；任一轨到达边界时两轨一起停止。上看恢复各轨打开时的音量并保持弹窗；下看保留并关闭。长眨冻结／恢复；双眨或 Esc 放弃本次调节并恢复原值。</p>
    <div class="row sc-live-actions"><button id="scLinkedVolumeLess">−1 dB</button><button id="scLinkedVolumeMore">+1 dB</button><button id="scLinkedVolumeRestore">上看 · 恢复原值</button><button id="scLinkedVolumeKeep" class="primary">下看 · 保留并关闭</button><button id="scLinkedVolumeObserve">进入观察模式</button><button id="scLinkedVolumeDiscard">放弃调节</button></div>
    <p class="muted">音量为实时调节，显示值经过原生引擎回读确认。每次两轨一起校验和应用；不改变播放位置、倍率、循环、EQ 或效果器。人脸丢失停止新增调节；离开页面仅停止调节并保留已生效音量。</p></div>`;
  function report(gesture,message,executed,source='手动控制'){onResult?.(gesture,{executed,message,from:'AB 联动音量',to:'AB 联动音量'},source);}
  function identityIssue(s){if(!client.connected||client._generation!==s.coreGeneration||client.snapshot?.projectKey!==s.projectKey||client.snapshot?.playbackRateEpoch!==s.epoch)return '工程或连接会话已变化，请重新连接核对；未自动重发';return '';}
  function readiness(s){const e=environment();return identityIssue(s)||(!eyesEnabled()?'请启用进阶页真实控制':!e.camera?'摄像头未运行':!e.baseline?'静息校准未就绪':e.sliderSettings?.enabled===false?'连续滑块控制已关闭':!e.calibration?'请先完成左右标尺校准':e.calibration!==s.calibration||!s.controller?'校准环境已变化，请重新打开弹窗':'');}
  function render(){const s=session;root.classList.toggle('hidden',!s);if(!s)return;
    q('scLinkedVolumeOriginal').textContent=s.original.map((x,i)=>`Deck ${i?'B':'A'} · ID ${x.track}：${db(x.db)}`).join('；');
    q('scLinkedVolumeOffset').textContent=db(s.targetDelta);q('scLinkedVolumeActual').textContent=s.confirmed.map((x,i)=>`${i?'B':'A'}：${db(x.db)}`).join('\n')+(s.error?'（上次读数）':'');
    const range=q('scLinkedVolumeRange');range.min=s.min;range.max=s.max;range.value=s.targetDelta;range.disabled=s.finishing||s.observing||!!s.error;
    q('scLinkedVolumeStatus').textContent=s.status;
    for(const id of ['Less','More','Restore','Observe'])q('scLinkedVolume'+id).disabled=s.finishing||!!s.error||(id!=='Observe'&&s.observing);
    q('scLinkedVolumeKeep').disabled=s.finishing;q('scLinkedVolumeDiscard').disabled=s.finishing;q('scLinkedVolumeObserve').textContent=s.observing?'恢复调节':'进入观察模式';
  }
  function fail(s,error){if(session!==s)return;s.error=error;s.stream?.dropPending();s.controller?.pause(s.lastFeatureTime);s.status=`${error.message}；已停止新增调节，请重新连接核对最终音量，未自动重发`;onError?.(error);report('AB 音量',s.status,false);render();}
  function pause(s,message){s.controller?.pause(s.lastFeatureTime);s.stream.dropPending();s.zone='lost';s.targetDelta=s.confirmedDelta;if(s.controller)s.controller.value=s.targetDelta;s.status=message;render();}
  function setDelta(s,value,source='手动控制',gesture='音量偏移'){
    if(session!==s||s.finishing||s.observing||s.error||!finite(value))return;
    const delta=Math.max(s.min,Math.min(s.max,Math.round(value*10)/10));if(Math.abs(delta-s.targetDelta)<.00001)return;
    s.targetDelta=delta;s.lastSource={source,gesture};
    try{s.stream.set(s.original.map(x=>({track:x.track,db:Math.fround(x.db+delta)})));s.status='正在成组调节，等待实际回读…';}catch(error){fail(s,error);}render();
  }
  async function finish(kind,source='手动控制',note=''){
    const s=session;if(!s||s.finishing)return;if(s.observing&&kind!=='discard'){report(kind==='restore'?'上看':'下看','观察模式中，请先恢复调节',false,source);return;}
    s.finishing=true;s.controller?.pause(s.lastFeatureTime);const ticket=generation;
    try{
      if(!s.error){
        if(kind!=='keep'){s.stream.dropPending();s.stream.set(s.original);}
        s.status='正在等待两轨最终音量回读…';render();await s.stream.flush();
        if(ticket!==generation||session!==s)return;
        const actual=await levels.read();if(ticket!==generation||session!==s)return;
        const values=s.original.map(x=>({track:x.track,db:levelTarget(actual,x.track)?.db}));
        if(identityIssue(s)||values.some(x=>!finite(x.db))||!same(values,s.stream.snapshot.tracks.filter(x=>s.original.some(y=>y.track===x.track)).map(x=>({track:x.track,db:x.db}))))throw new Error('最终两轨音量未确认');
        if(kind!=='keep'&&!same(values,s.original))throw new Error('目标音量已被外部修改，未确认恢复原值');
        s.confirmed=values;s.confirmedDelta=values[0].db-s.original[0].db;s.targetDelta=s.confirmedDelta;if(s.controller)s.controller.value=s.targetDelta;
        if(kind==='restore'){s.finishing=false;s.status='已恢复两轨各自打开时音量，弹窗保持打开';report('上看',s.status,true,source);render();return;}
        s.committed=kind==='keep'&&!same(values,s.original);s.receipt=s.stream.receipt;s.resultSnapshot=actual;
        report(kind==='keep'?'下看':'双眨',note+(kind==='keep'?'已保留 AB 当前音量并关闭':'已恢复 AB 打开时各自音量并关闭')+'；正常播放进度保持',true,source);
      }else report('关闭 AB 音量','已关闭；此前调节结果未确认，请重新连接核对',false,source);
      await s.stream.cancel();if(ticket===generation&&session===s){session=null;render();onState?.(false,s);}
    }catch(error){fail(s,error);}finally{if(session===s){s.finishing=false;render();}}
  }
  function gesture(g,source='手动控制',note=''){
    const s=session;if(!s||s.finishing)return;
    if(source==='眼动识别'&&(readiness(s)||now()-s.lastFace>750)){pause(s,readiness(s)||'未检测到近期有效视线，已停止新增调节');report(g,s.status,false,source);return;}
    if(g==='长眨'&&!s.error){s.observing=!s.observing;pause(s,s.observing?'观察模式：停止新增调节，音乐继续':'已恢复，请回中央后重新看向左右');report(g,s.status,true,source);render();}
    else if(g==='上看')return finish('restore',source,note);else if(g==='下看')return finish('keep',source,note);else if(g==='双眨')return finish('discard',source,note);
  }
  root.onclick=event=>{const b=event.target.closest('button');if(!b||b.disabled||!session)return;event.stopPropagation?.();
    const actions={scLinkedVolumeRestore:'上看',scLinkedVolumeKeep:'下看',scLinkedVolumeDiscard:'双眨',scLinkedVolumeObserve:'长眨'};
    if(actions[b.id])void gesture(actions[b.id]);else if(['scLinkedVolumeLess','scLinkedVolumeMore'].includes(b.id)){const s=session;s.zone='manual';setDelta(s,s.targetDelta+(b.id==='scLinkedVolumeMore'?1:-1));if(s.controller){s.controller.value=s.targetDelta;s.controller.pause(s.lastFeatureTime);}}};
  root.oninput=event=>{if(event.target.id!=='scLinkedVolumeRange'||!session)return;const s=session;s.zone='manual';setDelta(s,Number(event.target.value));if(s.controller){s.controller.value=s.targetDelta;s.controller.pause(s.lastFeatureTime);}};
  root.addEventListener('keydown',event=>{if(event.key==='Escape'&&session){event.preventDefault();event.stopPropagation?.();void finish('discard');}});
  render();return{
    isOpen:()=>!!session,
    open(ids){if(session)return false;if(!client.connected||!Array.isArray(ids)||ids.length!==2||new Set(ids).size!==2)throw new Error('请明确绑定 A、B 两条不同轨道');
      const opening=levels.snapshot,original=ids.map(track=>{const row=levelTarget(opening,track);if(!row?.available)throw new Error(row?.reason||'音量状态未读取');return{track,db:row.db};});
      if(opening.epoch!==client.snapshot.playbackRateEpoch||opening.projectKey!==client.snapshot.projectKey)throw new Error('音量会话已变化，请重新读取');
      const e=environment(),s={original,confirmed:structuredClone(original),min:Math.max(...original.map(x=>-144-x.db)),max:Math.min(...original.map(x=>12-x.db)),targetDelta:0,confirmedDelta:0,projectKey:opening.projectKey,epoch:opening.epoch,
        coreGeneration:client._generation,calibration:e.calibration,lastFace:-Infinity,lastFeatureTime:null,openedAt:now(),zone:'center',observing:false,finishing:false,error:null,committed:false,status:'共同 dB 偏移保留 A/B 音量差；眼动最大速度按设置值的 0.1 倍 dB/秒换算。'};
      const settings={...e.sliderSettings,minRatePerSec:(e.sliderSettings?.minRatePerSec??5)*.1,maxRatePerSec:(e.sliderSettings?.maxRatePerSec??35)*.1};
      s.controller=e.calibration?new GazeSliderController(e.calibration,settings,{min:s.min,max:s.max,initialValue:0}):null;
      s.stream=levels.createStream(ids,opening,{intervalMs:150,onConfirmed(result){if(session!==s)return;const previous=s.confirmed;s.confirmed=ids.map(track=>({track,db:levelTarget(result,track).db}));s.confirmedDelta=s.confirmed[0].db-s.original[0].db;
        if(['center','lost'].includes(s.zone)||s.observing){s.targetDelta=s.confirmedDelta;if(s.controller)s.controller.value=s.targetDelta;}
        if(!s.finishing){s.status=`AB 实际音量已确认：${s.confirmed.map(x=>db(x.db)).join(' / ')}`;if(!same(previous,s.confirmed))report(s.lastSource?.gesture||'AB 音量',s.status,true,s.lastSource?.source||'手动控制');}render();},onError:error=>fail(s,error)});
      generation++;session=s;render();onState?.(true,s);q('scLinkedVolumeRange').focus?.();return true;},
    gesture,
    frame(raw,t=now()){const s=session;if(!s||s.finishing||s.error)return;s.lastFeatureTime=t;const valid=raw&&gazeSignal(raw,environment().sliderSettings?.headCompensation)!==null;s.lastFace=valid?now():-Infinity;
      const issue=readiness(s);if(!valid||issue||s.observing){if(s.zone!=='manual'||s.observing)pause(s,s.observing?'观察模式：停止新增调节':issue||'人脸或虹膜信号丢失，已停止新增调节');return;}
      const next=s.controller.updateFrame(raw,t),manual=s.zone==='manual';if(!manual||Math.abs(next.delta)>0)s.zone=next.zone;
      if(Math.abs(next.delta)>0)setDelta(s,next.value,'眼动识别',next.delta>0?'右看':'左看');else if(next.zone==='center'&&!manual)pause(s,'回中央停止；两轨音量差保持');},
    tick(){const s=session;if(!s||s.finishing||s.error)return;const issue=identityIssue(s);if(issue){fail(s,new Error(issue));return;}if(s.zone!=='manual'&&now()-s.lastFace>750)pause(s,'画面中断，已停止新增调节');if(now()-s.openedAt>(environment().sliderSettings?.timeoutMs??20000))void finish('discard','系统','超时，');},
    detach(){generation++;const s=session;session=null;if(s){s.stream.dropPending();void s.stream.cancel().catch(()=>{});onState?.(false,s);}render();},
  };
}

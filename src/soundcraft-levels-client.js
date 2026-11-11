import { SoundCraftClientError } from './soundcraft-client.js';

const fail=(code,message,uncertain=false)=>new SoundCraftClientError(code,message,uncertain);
const clone=value=>structuredClone(value);
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const id=value=>Number.isSafeInteger(value)&&value>0;
const close=(a,b)=>finite(a)&&finite(b)&&Math.abs(a-b)<.00003;
const key=ids=>[...ids].sort((a,b)=>a-b).join(',');
export const levelTarget=(snapshot,track)=>snapshot?.tracks?.find(row=>row.track===track);
function parse(value,core,uncertain=false) {
  const reject=()=>{throw fail('invalid_levels','未取得可信的音轨音量读数，请重新连接核对',uncertain);};
  if(!value||value.version!==1||!value.epoch||value.epoch!==core?.playbackRateEpoch||value.projectKey!==core?.projectKey
    ||typeof value.projectPath!=='string'||value.projectPath!==core.projectPath||typeof value.projectName!=='string'||value.projectName!==core.projectName||!Array.isArray(value.trackIds)
    ||value.trackIds.some(track=>!id(track))||new Set(value.trackIds).size!==value.trackIds.length
    ||key(value.trackIds)!==key(core.tracks.map(track=>track.id))||typeof value.engineAudioReady!=='boolean'
    ||!(value.audioDevice===null||typeof value.audioDevice==='string')
    ||!Array.isArray(value.tracks)||value.tracks.length!==core.tracks.filter(track=>track.kind==='audio').length)reject();
  const seen=new Set();
  for(const row of value.tracks) {
    if(!row||!id(row.track)||seen.has(row.track)||!finite(row.db)||row.db< -144||row.db>12
      ||typeof row.available!=='boolean'||typeof row.reason!=='string'||!core.tracks.some(track=>track.id===row.track&&track.kind==='audio'))reject();
    seen.add(row.track);
  }
  return clone(value);
}
export class SoundCraftLevelsClient {
  constructor(core){this.core=core;this.snapshot=null;this._groups=new Map();}
  async _read(context){const reply=await this.core._request('/api/soundcraft/levels',{},context);const value=parse(reply.result,this.core.snapshot,context.mutationSent);this.core._assertCurrent(context);this.snapshot=value;return value;}
  async read(){const core=this.core;core._requireConnected();return core._run(async context=>{await core._refreshBound(context);return this._read(context);});}
  _identity(actual,expected){if(!expected||actual.epoch!==expected.epoch||actual.projectKey!==expected.projectKey)throw fail('levels_changed','音量会话已变化，未发送修改');}
  _params(snapshot){return{projectPath:snapshot.projectPath,projectName:snapshot.projectName,trackIds:snapshot.trackIds,epoch:snapshot.epoch};}
  _uncertain(){throw fail('levels_not_confirmed','音量回执或实际结果未确认，请重新连接核对，未自动重发',true);}
  async _post(action,params,context){context.mutationSent=true;const reply=await this.core._request('/api/soundcraft',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,params})},context);context.mutationAccepted=true;return parse(reply.result,this.core.snapshot,true);}
  _receipt(result,changed,receipt,restore=false){
    if(typeof result.changed!=='boolean'||result.changed!==!!changed.length||!Array.isArray(result.updated)||result.updated.some(track=>!id(track))
      ||new Set(result.updated).size!==result.updated.length||key(result.updated)!==key(changed)
      ||(restore?result.receipt!==null:receipt?result.receipt!==receipt:changed.length?typeof result.receipt!=='string'||!result.receipt||result.receipt.length>1024:result.receipt!==null))this._uncertain();
  }
  async _readback(after,beforeCore,context){
    const current=await this.core._refreshBound(context);
    if(current.projectKey!==after.projectKey||current.playbackRateEpoch!==after.epoch
      ||['playing','sampleRate','lengthSamples','durationSeconds','tempoMapKey'].some(field=>current[field]!==beforeCore[field])
      ||!beforeCore.playing&&current.positionSeconds!==beforeCore.positionSeconds)this._uncertain();
    const withoutLevel=track=>Object.fromEntries(Object.entries(track).filter(([field])=>field!=='volumeDb'));
    for(const track of beforeCore.tracks){const next=current.tracks.find(item=>item.id===track.id);
      if(!next||JSON.stringify(withoutLevel(track))!==JSON.stringify(withoutLevel(next)))this._uncertain();
      const actual=levelTarget(after,track.id);if(actual?!close(next.volumeDb,actual.db):!close(next.volumeDb,track.volumeDb))this._uncertain();}
    const actual=await this._read(context);
    this._identity(actual,after);
    if(after.tracks.some(row=>!close(row.db,levelTarget(actual,row.track)?.db)))this._uncertain();
  }
  async set(targets,expected,receipt=null){
    if(!Array.isArray(targets)||targets.length<1||targets.length>2||new Set(targets.map(t=>t?.track)).size!==targets.length
      ||targets.some(t=>!t||Object.keys(t).length!==2||!id(t.track)||!finite(t.db)||t.db< -144||t.db>12))throw fail('invalid_levels','需要一至两条不同轨道及 -144 至 +12 dB 音量');
    const core=this.core;core._requireConnected();
    return core._run(async context=>{
      await core._refreshBound(context);const before=await this._read(context),beforeCore=clone(core.snapshot);this._identity(before,expected);
      if(!before.engineAudioReady||!before.audioDevice)throw fail('levels_audio_unavailable','音频输出尚未就绪，未发送音量修改');
      let group;
      if(receipt){group=this._groups.get(receipt);if(!group||group.generation!==core._generation||group.binding!==core._binding||key(group.ids)!==key(targets.map(t=>t.track)))throw fail('invalid_level_receipt','音量分组凭据已失效，未发送修改');}
      const updates=targets.map(target=>{const row=levelTarget(before,target.track),prior=levelTarget(expected,target.track);
        if(!row?.available||!prior?.available||!close(row.db,prior.db))throw fail('levels_changed',row?.reason||'目标音量已在其他位置变化，未覆盖');
        if(group&&!close(row.db,levelTarget(group.after,target.track)?.db))throw fail('levels_changed','分组音量已被外部修改，未覆盖');
        return{track:target.track,expectedDb:row.db,db:Math.fround(target.db)};});
      if(updates.every(update=>Math.fround(update.expectedDb)===update.db)) {
        const unchanged={...clone(before),changed:false,updated:[],receipt:receipt||null};this.snapshot=unchanged;return unchanged;
      }
      const after=await this._post('SET_LEVELS',{...this._params(before),updates,...(receipt?{receipt}:{})},context);
      const wanted=new Map(updates.map(t=>[t.track,t.db])),changed=[];
      for(const row of before.tracks){const actual=levelTarget(after,row.track);
        if(!actual||!close(actual.db,wanted.has(row.track)?wanted.get(row.track):row.db))this._uncertain();
        if(actual.db!==row.db)changed.push(row.track);}
      this._receipt(after,changed,receipt);await this._readback(after,beforeCore,context);
      if(after.receipt){if(!receipt&&this._groups.has(after.receipt))this._uncertain();
        this._groups.set(after.receipt,{before:group?.before||clone(before),after:clone(after),ids:targets.map(t=>t.track),generation:core._generation,binding:core._binding});
        while(this._groups.size>64)this._groups.delete(this._groups.keys().next().value);}
      this.snapshot=after;return after;
    });
  }
  async restore(receipt,expected=this.snapshot){
    const core=this.core,group=this._groups.get(receipt);core._requireConnected();
    if(!group||group.generation!==core._generation||group.binding!==core._binding)throw fail('invalid_level_receipt','本次音量撤回凭据已失效');
    return core._run(async context=>{await core._refreshBound(context);const before=await this._read(context),beforeCore=clone(core.snapshot);this._identity(before,expected);this._identity(before,group.after);
      if(!before.engineAudioReady||!before.audioDevice)throw fail('levels_audio_unavailable','音频输出尚未就绪，未发送撤回');
      for(const track of group.ids)if(!levelTarget(before,track)?.available||!close(levelTarget(before,track).db,levelTarget(group.after,track).db))throw fail('levels_changed','目标音量已被外部修改，不覆盖新的音量');
      const after=await this._post('RESTORE_LEVELS',{...this._params(before),receipt},context),changed=[];
      for(const row of before.tracks){const value=group.ids.includes(row.track)?levelTarget(group.before,row.track).db:row.db;
        if(!close(levelTarget(after,row.track)?.db,value))this._uncertain();if(value!==row.db)changed.push(row.track);}
      this._receipt(after,changed,null,true);await this._readback(after,beforeCore,context);this._groups.delete(receipt);this.snapshot=after;return after;
    });
  }
  createStream(ids,opening,{onConfirmed,onError,intervalMs=150}={}){
    const core=this.core;core._requireConnected();
    if(core.busy||core.volumeStreaming||!Array.isArray(ids)||!ids.length||ids.length>2||new Set(ids).size!==ids.length)throw fail('busy','请先完成当前音量调节');
    for(const track of ids)if(!levelTarget(opening,track)?.available)throw fail('levels_unavailable','目标音量不可调节');
    const stream=new LinkedLevelStream(this,ids,opening,{onConfirmed,onError,intervalMs});core._volumeStream=stream;return stream;
  }
}
class LinkedLevelStream {
  constructor(client,ids,snapshot,options){this.client=client;this.ids=[...ids];this.snapshot=clone(snapshot);this.options=options;this.receipt=null;this.active=true;this.pending=null;this.running=null;this.timer=null;this.lastSent=-Infinity;this.error=null;}
  set(targets){if(!this.active||this.error)throw this.error||fail('stream_closed','音量调节已关闭');if(key(targets.map(t=>t.track))!==key(this.ids))throw fail('invalid_scope','音量目标不能在弹窗内切换');this.pending=clone(targets);this._schedule();}
  _schedule(){if(!this.active||this.running||this.timer||!this.pending)return;const wait=Math.max(0,(this.options.intervalMs??150)-(performance.now()-this.lastSent));this.timer=setTimeout(()=>{this.timer=null;void this._send();},wait);}
  async _send(){if(!this.active||this.running||!this.pending)return;const targets=this.pending;this.pending=null;this.lastSent=performance.now();
    this.running=this.client.set(targets,this.snapshot,this.receipt);
    try{const result=await this.running;this.snapshot=result;this.receipt=result.receipt;if(this.active)this.options.onConfirmed?.(result,{targets});}
    catch(error){this._fail(error);}
    finally{this.running=null;this._schedule();}
  }
  _fail(error){if(this.error)return;this.error=error;this.dropPending();this.active=false;this._release();this.options.onError?.(error);}
  dropPending(){this.pending=null;if(this.timer){clearTimeout(this.timer);this.timer=null;}}
  async flush(){if(this.error)throw this.error;while(this.running||this.pending){if(this.timer){clearTimeout(this.timer);this.timer=null;}if(this.running)await this.running.catch(()=>{});else await this._send();if(this.error)throw this.error;}return this.snapshot;}
  async cancel(){this.dropPending();if(this.running)await this.running.catch(()=>{});this.active=false;this._release();return this.snapshot;}
  _release(){if(this.client.core._volumeStream===this)this.client.core._volumeStream=null;}
}

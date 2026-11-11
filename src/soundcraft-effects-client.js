import { SoundCraftClientError } from './soundcraft-client.js';

export const EFFECTS = Object.freeze(['reverb','delay','chorus']);
export const EFFECT_LABELS = Object.freeze({reverb:'混响',delay:'延迟',chorus:'合唱'});
const NATIVE = {reverb:['room_reverb',.25],delay:['mod_delay',.3],chorus:['chorus',.5]};
const finite = value => typeof value === 'number' && Number.isFinite(value);
const amount = value => finite(value) && value >= 0 && value <= 1;
const id = value => Number.isSafeInteger(value) && value > 0;
const slot = value => Number.isInteger(value) && value >= 0 && value < 10;
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);
const fail = (code,message,uncertain=false) => new SoundCraftClientError(code,message,uncertain);
const idsKey = values => [...values].sort((a,b)=>a-b).join(',');
const closeAmount = (a,b) => Math.abs(a-b) <= 1e-7;
const validInsert = insert => plain(insert) && typeof insert.plugin === 'string' && !!insert.plugin
  && typeof insert.bypass === 'boolean' && plain(insert.params)
  && Object.entries(insert.params).every(([key,value])=>key.length>0 && finite(value));
export const effectInsertKey = insert => insert === null ? 'null' : validInsert(insert)
  ? JSON.stringify([insert.plugin,insert.bypass,Object.entries(insert.params).sort(([a],[b])=>a.localeCompare(b))]) : '';
const equalInsert = (a,b) => !!effectInsertKey(a) && effectInsertKey(a) === effectInsertKey(b);
const equalState = (a,b) => !!a && !!b && a.effect===b.effect && a.slot===b.slot && equalInsert(a.insert,b.insert)
  && a.enabled===b.enabled && a.amount===b.amount && a.available===b.available && a.reason===b.reason;
const entries = (snapshot,effect) => snapshot.tracks.map(track=>({track:track.track,state:track.effects.find(item=>item.effect===effect)}));

function parseSnapshot(value,coreSnapshot,uncertain=false) {
  const reject=()=>{throw fail('invalid_effects_reply','SoundCraft 效果状态或回执无效，请重新连接核对',uncertain);};
  const allIds=coreSnapshot?.tracks?.map(track=>track.id)||[];
  if (!plain(value) || value.version!==1 || typeof value.epoch!=='string' || !value.epoch || value.epoch.length>256
    || value.epoch!==coreSnapshot?.playbackRateEpoch
    || typeof value.projectPath!=='string' || typeof value.projectName!=='string' || value.projectKey!==coreSnapshot?.projectKey
    || value.projectKey!==JSON.stringify([value.projectPath,value.projectName,[...allIds].sort((a,b)=>a-b)])
    || !Array.isArray(value.trackIds) || value.trackIds.some(track=>!id(track)) || value.trackIds.length!==allIds.length
    || new Set(value.trackIds).size!==allIds.length || idsKey(value.trackIds)!==idsKey(allIds)
    || typeof value.engineAudioReady!=='boolean' || typeof value.audioDevice!=='string'
    || !Array.isArray(value.definitions) || value.definitions.length!==EFFECTS.length || !Array.isArray(value.tracks)) reject();
  for (const effect of EFFECTS) {
    const defs=value.definitions.filter(def=>def?.effect===effect), native=NATIVE[effect];
    if (defs.length!==1 || defs[0].plugin!==native[0] || defs[0].param!=='mix' || defs[0].defaultAmount!==native[1]
      || defs[0].min!==0 || defs[0].max!==1) reject();
  }
  const audioIds=coreSnapshot.tracks.filter(track=>track.kind==='audio').map(track=>track.id),seen=new Set();
  for (const track of value.tracks) {
    if (!track || !id(track.track) || !audioIds.includes(track.track) || seen.has(track.track)
      || !Array.isArray(track.effects) || track.effects.length!==EFFECTS.length) reject();
    seen.add(track.track);
    const occupied=new Set();
    for (const effect of EFFECTS) {
      const candidates=track.effects.filter(item=>item?.effect===effect),def=value.definitions.find(item=>item.effect===effect);
      if (candidates.length!==1) reject();
      const state=candidates[0];
      if (!(state.slot===null || slot(state.slot)) || !(state.insert===null || validInsert(state.insert))
        || typeof state.enabled!=='boolean' || !amount(state.amount) || typeof state.available!=='boolean'
        || typeof state.reason!=='string' || (!state.available && !state.reason.trim())
        || state.available && (state.slot===null || state.reason!=='') || state.insert!==null && state.slot===null) reject();
      if (state.insert!==null) {
        const wet=state.insert.params[def.param]??def.defaultAmount*100;
        // Inactive inserts and unsupported stored values remain visible read-only.
        // Their native active flag is not present in the public insert subset;
        // the inspector may also clamp its display amount for invalid raw mix.
        if (state.insert.plugin!==def.plugin || state.available && (state.enabled===state.insert.bypass
          || !amount(wet/100) || !closeAmount(state.amount,wet/100))
          || occupied.has(state.slot)) reject();
        occupied.add(state.slot);
      } else if (state.available && (state.enabled || state.amount!==def.defaultAmount)) reject();
    }
  }
  if (audioIds.some(track=>!seen.has(track))) reject();
  return structuredClone(value);
}

export function effectTarget(snapshot,trackId,effect) {
  const base={track:trackId,effect,slot:null,insert:null,enabled:false,amount:0,available:false,supported:false,reason:''};
  if (!EFFECTS.includes(effect)) return {...base,reason:'请选择混响、延迟或合唱效果'};
  const definition=snapshot?.definitions?.find(item=>item.effect===effect);
  const state=snapshot?.tracks?.find(item=>item.track===trackId)?.effects?.find(item=>item.effect===effect);
  if (!definition || !state) return {...base,reason:'所选音频轨道没有可读取的原生效果状态'};
  return {...base,...state,definition,supported:state.available===true};
}

function targetsOf(effect,targets) {
  if (!EFFECTS.includes(effect) || !Array.isArray(targets) || targets.length<1 || targets.length>2
    || targets.some(target=>!target || !id(target.track) || typeof target.enabled!=='boolean' || !amount(target.amount))
    || new Set(targets.map(target=>target.track)).size!==targets.length) {
    throw fail('invalid_effect','请选择 1–2 条不同的真实音轨及 0–100% 的效果强度');
  }
  return targets.map(({track,enabled,amount})=>({track,enabled,amount}));
}

export class SoundCraftEffectsClient {
  constructor(core) {this.core=core;this.snapshot=null;}
  async _read(context) {
    const reply=await this.core._request('/api/soundcraft/effects',{},context);
    const snapshot=parseSnapshot(reply.result,this.core.snapshot,context.mutationSent);
    this.core._assertCurrent(context);this.snapshot=snapshot;return snapshot;
  }
  async read() {
    const core=this.core;core._requireConnected();
    const generation=core._generation,binding=core._binding;
    try {return await core._run(async context=>{await core._refreshBound(context);return this._read(context);});}
    catch(error) {
      if (['effects_unsupported','effect_unsupported','not_found'].includes(error.code)
        && core._generation===generation && core._binding===binding) {
        core.connected=true;this.snapshot=null;
        throw fail('effects_unsupported','原生效果接口尚未加载，请重启桌面 serve.py 并使用 GazeDeck 扩展版 SoundCraft');
      }
      throw error;
    }
  }
  set(effect,rawTargets,expectedSnapshot) {
    let targets;try{targets=targetsOf(effect,rawTargets);}catch(error){return Promise.reject(error);}
    return this._apply(effect,targets,expectedSnapshot,false);
  }
  restore(effect,previous,expectedSnapshot) {
    if (!EFFECTS.includes(effect) || !Array.isArray(previous) || previous.length<1 || previous.length>2
      || previous.some(entry=>!entry || !id(entry.track) || !slot(entry.slot)
        || !(entry.insert===null || validInsert(entry.insert) && entry.insert.plugin===NATIVE[effect][0]))
      || new Set(previous.map(entry=>entry.track)).size!==previous.length) {
      return Promise.reject(fail('invalid_effect_expectation','效果撤销信息无效，请重新读取'));
    }
    return this._apply(effect,structuredClone(previous),expectedSnapshot,true);
  }
  async _apply(effect,targets,expectedSnapshot,restoring) {
    const core=this.core;
    if (!expectedSnapshot || typeof expectedSnapshot.epoch!=='string' || !expectedSnapshot.epoch
      || typeof expectedSnapshot.projectKey!=='string') throw fail('invalid_effect_expectation','缺少有效的效果会话，请重新打开弹窗');
    core._requireConnected();
    if(core.volumeStreaming)throw fail('busy','请先结束音量调节，再调整效果');
    return core._run(async context=>{
      await core._refreshBound(context);const before=await this._read(context),coreBefore=structuredClone(core.snapshot);
      if(before.projectKey!==expectedSnapshot.projectKey || before.epoch!==expectedSnapshot.epoch)
        throw fail('effect_changed','工程或效果会话已变化；未发送修改');
      if(!before.engineAudioReady || !before.audioDevice)throw fail('effects_audio_unavailable','SoundCraft 音频输出尚未就绪；未发送效果修改');
      const previous=targets.map(target=>{
        const state=effectTarget(before,target.track,effect),expected=effectTarget(expectedSnapshot,target.track,effect);
        if(!state.available)throw fail('effect_unavailable',state.reason||'此轨道效果不可用');
        if(!equalState(state,expected) || restoring && target.slot!==state.slot)
          throw fail('effect_changed','效果插槽或参数已在其他位置变化；未覆盖外部修改');
        return {track:target.track,slot:state.slot,insert:structuredClone(state.insert)};
      });
      const updates=targets.map((target,index)=>({track:target.track,slot:previous[index].slot,expectedInsert:previous[index].insert,
        ...(restoring?{restoreInsert:target.insert}:{enabled:target.enabled,amount:target.amount})}));
      const changed=targets.filter((target,index)=>restoring?!equalInsert(target.insert,previous[index].insert)
        : previous[index].insert===null ? target.enabled : target.enabled!==!previous[index].insert.bypass
          || (previous[index].insert.params.mix??NATIVE[effect][1]*100)!==Math.fround(target.amount*100));
      if(!changed.length)return {...before,effect,changed:false,updated:[],previous:[],after:[]};
      const params={projectPath:before.projectPath,projectName:before.projectName,trackIds:before.trackIds,epoch:before.epoch,effect,updates};
      core._assertCurrent(context);context.mutationSent=true;
      const reply=await core._request('/api/soundcraft',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({action:restoring?'RESTORE_EFFECT':'SET_EFFECT',params})},context);
      context.mutationAccepted=true;
      const after=parseSnapshot(reply.result,core.snapshot,true),reject=()=>{throw fail('effect_not_confirmed','SoundCraft 实际效果参数回执未确认，请重新连接核对；未自动重发',true);};
      const changedIds=changed.map(target=>target.track);
      if(after.epoch!==before.epoch || after.effect!==effect || after.changed!==true || !Array.isArray(after.updated)
        || after.updated.length!==changedIds.length || idsKey(after.updated)!==idsKey(changedIds)
        || !Array.isArray(after.previous) || after.previous.length!==changed.length
        || !Array.isArray(after.after) || after.after.length!==changed.length)reject();
      for (const target of targets) {
        const old=previous.find(entry=>entry.track===target.track),actual=effectTarget(after,target.track,effect);
        if((!restoring || target.insert!==null) && actual.slot!==old.slot || !actual.available)reject();
        if(!changedIds.includes(target.track)) {if(!equalState(effectTarget(before,target.track,effect),actual))reject();continue;}
        const reportedBefore=after.previous.find(entry=>entry.track===target.track),reportedAfter=after.after.find(entry=>entry.track===target.track);
        if(!reportedBefore || reportedBefore.slot!==old.slot || !equalInsert(reportedBefore.insert,old.insert)
          || !reportedAfter || reportedAfter.slot!==old.slot || !equalInsert(reportedAfter.insert,actual.insert))reject();
        if(restoring) {if(!equalInsert(actual.insert,target.insert))reject();}
        else {
          if(actual.enabled!==target.enabled || !closeAmount(actual.amount,target.amount) || !actual.insert
            || actual.insert.plugin!==NATIVE[effect][0] || actual.insert.bypass===target.enabled)reject();
          if(old.insert && (Object.keys(old.insert.params).filter(key=>key!=='mix').length!==Object.keys(actual.insert.params).filter(key=>key!=='mix').length
            || Object.keys(old.insert.params).some(key=>key!=='mix' && old.insert.params[key]!==actual.insert.params[key])))reject();
        }
      }
      for(const kind of EFFECTS)for(const old of entries(before,kind)) {
        if(kind===effect && changedIds.includes(old.track))continue;
        // Adding an effect consumes the shared first free slot, so an absent other
        // effect may acquire a different proposed slot without changing an insert.
        const actual=effectTarget(after,old.track,kind),prior=old.state;
        if(prior.insert===null && actual.insert===null) {
          if(prior.enabled!==actual.enabled || prior.amount!==actual.amount)reject();
        } else if(!equalState(prior,actual))reject();
      }
      const coreAfter=await core._refreshBound(context);
      if(coreAfter.playbackRateEpoch!==after.epoch)reject();
      // Full native session reads also protect plugins outside the three FX models.
      for(const oldTrack of coreBefore.tracks) {
        const newTrack=coreAfter.tracks.find(track=>track.id===oldTrack.id);
        if(!Array.isArray(oldTrack.inserts) || !Array.isArray(newTrack?.inserts))reject();
        const owned=previous.find(entry=>entry.track===oldTrack.id && changedIds.includes(entry.track));
        const protectedOld=oldTrack.inserts.filter(insert=>!owned || insert.slot!==owned.slot);
        const protectedNew=newTrack.inserts.filter(insert=>!owned || insert.slot!==owned.slot);
        if(protectedOld.length!==protectedNew.length || protectedOld.some(insert=>!equalInsert(insert,protectedNew.find(other=>other.slot===insert.slot))))reject();
        if(owned) {
          const actual=effectTarget(after,oldTrack.id,effect).insert,native=newTrack.inserts.find(insert=>insert.slot===owned.slot);
          if(actual===null?!!native:!equalInsert(actual,native))reject();
        }
      }
      core._assertCurrent(context);this.snapshot=after;return after;
    });
  }
}

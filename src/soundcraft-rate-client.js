import { SoundCraftClientError } from './soundcraft-client.js';

export const RATE_POLICY = 'fixed_seconds_independent_source_wrap';
export const MIN_TRACK_RATE = .5, MAX_TRACK_RATE = 2;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const id = value => Number.isSafeInteger(value) && value > 0;
const rate = value => finite(value) && value >= MIN_TRACK_RATE && value <= MAX_TRACK_RATE;
const fail = (code, message, uncertain = false) => new SoundCraftClientError(code, message, uncertain);
const idsKey = values => [...values].sort((a,b) => a-b).join(',');
const equalLoop = (a,b) => a === null && b === null || !!a && !!b && a.start === b.start && a.end === b.end;
const validLoop = (value, length = Number.MAX_SAFE_INTEGER) => !!value && typeof value === 'object'
  && Number.isSafeInteger(value.start) && Number.isSafeInteger(value.end)
  && value.start >= 0 && value.end > value.start && value.end <= length;
const stateOf = state => ({rate:state.rate,revision:state.revision,loop:state.loop === null ? null : {...state.loop}});
const equalState = (a,b) => !!a && !!b && a.rate === b.rate && a.revision === b.revision && equalLoop(a.loop,b.loop);

function targetsOf(targets) {
  if (!Array.isArray(targets) || targets.length < 1 || targets.length > 2 || targets.some(target => !target
    || !id(target.track) || !rate(target.rate)) || new Set(targets.map(target => target.track)).size !== targets.length) {
    throw fail('invalid_track_rate','请选择 1–2 条不同的真实音轨及 0.5–2.0 的播放倍率');
  }
  return targets.map(target => ({track:target.track,rate:target.rate}));
}

// Desired state and callback-applied state remain separately labelled on reads.
// A query is allowed to show a pending callback; only a confirmed write may say applied.
function parseSnapshot(value, coreSnapshot, uncertain = false) {
  const reject = () => { throw fail('invalid_rate_reply','SoundCraft 变速状态或回执无效，请重新连接核对',uncertain); };
  const allIds = coreSnapshot?.tracks?.map(track => track.id) || [];
  if (!value || value.version !== 1 || value.policy !== RATE_POLICY || value.min_rate !== MIN_TRACK_RATE || value.max_rate !== MAX_TRACK_RATE
    || typeof value.epoch !== 'string' || !value.epoch || value.epoch.length > 256
    || typeof value.projectPath !== 'string' || typeof value.projectName !== 'string'
    || value.projectKey !== coreSnapshot?.projectKey
    || value.projectKey !== JSON.stringify([value.projectPath,value.projectName,[...allIds].sort((a,b) => a-b)])
    || !Array.isArray(value.trackIds) || value.trackIds.some(track => !id(track))
    || new Set(value.trackIds).size !== value.trackIds.length || idsKey(value.trackIds) !== idsKey(allIds)
    || !Number.isSafeInteger(value.lengthSamples) || value.lengthSamples <= 0
    || !finite(value.sampleRate) || value.sampleRate <= 0 || typeof value.engineAudioReady !== 'boolean'
    || typeof value.audioDevice !== 'string' || !['fixed_pin','selection','project'].includes(value.sourceLoopOrigin)
    || value.sourceLoop !== null && !validLoop(value.sourceLoop,value.lengthSamples)
    || !Array.isArray(value.tracks) || !Array.isArray(value.applied)) reject();
  const seen = new Set();
  for (const entry of value.tracks) {
    if (!entry || !id(entry.track) || !allIds.includes(entry.track) || seen.has(entry.track) || !rate(entry.rate)
      || !Number.isSafeInteger(entry.revision) || entry.revision < 0
      || (entry.loop === null ? entry.rate !== 1 || entry.revision !== 0
        : !validLoop(entry.loop,value.lengthSamples))) reject();
    seen.add(entry.track);
  }
  const appliedIds = new Set();
  for (const entry of value.applied) {
    if (!entry || !id(entry.track) || !allIds.includes(entry.track) || appliedIds.has(entry.track)
      || typeof entry.epoch !== 'string' || !entry.epoch || entry.epoch.length > 256 || !rate(entry.rate)
      || !Number.isSafeInteger(entry.revision) || entry.revision < 0
      || !validLoop({start:entry.loop_start,end:entry.loop_end},value.lengthSamples)
      || !finite(entry.source_position) || entry.source_position < entry.loop_start || entry.source_position >= entry.loop_end) reject();
    appliedIds.add(entry.track);
  }
  return structuredClone(value);
}

export function appliedTrackRate(snapshot, trackId) {
  const desired = snapshot?.tracks?.find(entry => entry.track === trackId);
  const actual = snapshot?.applied?.find(entry => entry.track === trackId);
  if (!desired) return null;
  if (desired.revision === 0 && desired.rate === 1 && desired.loop === null && !actual) return desired;
  return actual && actual.epoch === snapshot.epoch && actual.rate === desired.rate && actual.revision === desired.revision
    && equalLoop(desired.loop,{start:actual.loop_start,end:actual.loop_end}) ? actual : null;
}

export class SoundCraftRateClient {
  constructor(core) {
    this.core = core;
    this.snapshot = null;
    this._stream = null;
  }

  async _read(context) {
    const reply = await this.core._request('/api/soundcraft/rates',{},context);
    const snapshot = parseSnapshot(reply.result,this.core.snapshot,context.mutationSent);
    this.core._assertCurrent(context);
    this.snapshot = snapshot;
    return snapshot;
  }

  async read() {
    const core = this.core;
    core._requireConnected();
    if (this._stream?.active) throw fail('busy','音轨变速弹窗正在控制参数，请先结束调节再刷新');
    const generation = core._generation, binding = core._binding;
    try {
      return await core._run(async context => { await core._refreshBound(context); return this._read(context); });
    } catch (error) {
      // Feature discovery against the unextended application must not break volume/playback.
      if (['rate_unsupported','not_found'].includes(error.code) && core._generation === generation && core._binding === binding) {
        core.connected = true;
        throw fail('rate_unsupported',error.code === 'not_found'
          ? '变速接口尚未加载，请重启桌面 serve.py 并使用 GazeDeck 扩展版 SoundCraft'
          : error.message);
      }
      throw error;
    }
  }

  set(targets, loop, expectedSnapshot) {
    if (this._stream?.active) return Promise.reject(fail('busy','连续变速正在进行，请通过当前弹窗调节'));
    return this._apply(targets,loop,expectedSnapshot);
  }

  async _apply(rawTargets, rawLoop, expectedSnapshot) {
    const targets = targetsOf(rawTargets), loop = {...rawLoop}, core = this.core;
    if (!validLoop(rawLoop) || !expectedSnapshot || typeof expectedSnapshot.epoch !== 'string'
      || typeof expectedSnapshot.projectKey !== 'string' || !Array.isArray(expectedSnapshot.tracks)) {
      throw fail('invalid_rate_expectation','缺少有效的变速会话或固定循环范围，请重新打开弹窗');
    }
    core._requireConnected();
    if (core.volumeStreaming) throw fail('busy','请先完成音量调节，再修改播放倍率');
    return core._run(async context => {
      await core._refreshBound(context);
      const before = await this._read(context);
      if (before.projectKey !== expectedSnapshot.projectKey || before.epoch !== expectedSnapshot.epoch) {
        throw fail('rate_changed','工程已重新打开或变速会话已变化；未发送倍率修改');
      }
      if (!before.engineAudioReady || !before.audioDevice) throw fail('rate_audio_unavailable','SoundCraft 音频输出尚未就绪，未发送倍率修改');
      if (!validLoop(loop,before.lengthSamples)) throw fail('invalid_rate_loop','固定音源循环范围超出当前工程内容');
      const previous = targets.map(target => {
        const current = before.tracks.find(entry => entry.track === target.track);
        const expected = expectedSnapshot.tracks.find(entry => entry.track === target.track);
        if (!equalState(current,expected)) throw fail('rate_changed','音轨倍率或循环范围已在其他位置变化；未覆盖外部修改');
        if (!appliedTrackRate(before,target.track)) throw fail('rate_not_applied','上一次倍率尚未被音频回调确认，请稍后重新读取');
        return current;
      });
      if (targets.every((target,index) => target.rate === previous[index].rate && equalLoop(loop,previous[index].loop))) {
        return {...before,changed:false,updated:targets.map(target => target.track),previous:structuredClone(previous)};
      }
      const params = {projectPath:before.projectPath,projectName:before.projectName,trackIds:before.trackIds,
        epoch:before.epoch,loop,updates:targets.map((target,index) => ({...target,expected:stateOf(previous[index])}))};
      core._assertCurrent(context); context.mutationSent = true;
      const reply = await core._request('/api/soundcraft',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({action:'SET_TRACK_RATE',params})},context);
      context.mutationAccepted = true;
      const after = parseSnapshot(reply.result,core.snapshot,true);
      if (after.epoch !== before.epoch || typeof after.changed !== 'boolean' || !Array.isArray(after.updated)
        || after.updated.some(track => !id(track)) || idsKey(after.updated) !== idsKey(targets.map(target => target.track)) || after.updated.length !== targets.length
        || !Array.isArray(after.previous) || after.previous.length !== previous.length) {
        throw fail('rate_not_confirmed','SoundCraft 变速提交回执未确认；不会自动重发',true);
      }
      for (let index=0; index<targets.length; index++) {
        const target = targets[index], old = previous[index], desired = after.tracks.find(entry => entry.track === target.track);
        const reportedBefore = after.previous.find(entry => entry.track === target.track);
        const changed = target.rate !== old.rate || !equalLoop(loop,old.loop);
        if (!equalState(old,reportedBefore) || !desired || desired.rate !== target.rate || !equalLoop(loop,desired.loop)
          || desired.revision !== old.revision + (changed ? 1 : 0) || !appliedTrackRate(after,target.track)) {
          throw fail('rate_not_applied','SoundCraft 音频回调未确认所请求的倍率及版本，请重新连接核对；未自动重发',true);
        }
      }
      if (!after.changed || before.tracks.some(old => !targets.some(target => target.track === old.track)
        && !equalState(old,after.tracks.find(entry => entry.track === old.track)))) {
        throw fail('rate_not_confirmed','SoundCraft 的其他音轨倍率或回执意外变化，请重新连接核对',true);
      }
      this.snapshot = after;
      return after;
    });
  }

  createStream(trackIds, loop, openingSnapshot, options = {}) {
    const core = this.core;
    core._requireConnected();
    if (core.busy || core.volumeStreaming || this._stream?.active) throw fail('busy','上一条请求或其他连续调节尚未完成');
    const opening = parseSnapshot(openingSnapshot,core.snapshot);
    if (!Array.isArray(trackIds)) throw fail('invalid_rate_target','请指定当前弹窗的目标音轨');
    targetsOf(trackIds.map(track => ({track,rate:opening.tracks.find(entry => entry.track === track)?.rate})));
    if (!validLoop(loop,opening.lengthSamples) || !opening.engineAudioReady || trackIds.some(track => !appliedTrackRate(opening,track))) {
      throw fail('rate_audio_unavailable','音频倍率状态或固定循环范围尚未确认，请重新读取');
    }
    const stream = new TrackRateStream(this,trackIds,loop,opening,options);
    this._stream = stream;
    return stream;
  }
}

class TrackRateStream {
  constructor(adapter, trackIds, loop, snapshot, {onConfirmed,onError,intervalMs=200} = {}) {
    this.adapter=adapter; this.trackIds=[...trackIds]; this.loop={...loop}; this.currentSnapshot=snapshot;
    this.onConfirmed=onConfirmed; this.onError=onError;
    this.intervalMs=finite(intervalMs) ? Math.max(16,Math.min(5000,intervalMs)) : 200;
    this.generation=adapter.core._generation; this.binding=adapter.core._binding;
    this.active=true; this.error=null; this.pending=undefined; this.inFlight=null;
    this.timer=null; this.lastStarted=-Infinity; this.flushing=false; this.waiters=[];
  }
  _assertCurrent() {
    const core=this.adapter.core;
    if (!core.connected || core._generation!==this.generation || core._binding!==this.binding) {
      throw fail('disconnected','工程或连接已变化，未发送的变速调节已丢弃');
    }
  }
  set(rawTargets) {
    if (!this.active) throw this.error || fail('stream_closed','本次连续变速已结束');
    const targets=targetsOf(rawTargets);
    if (idsKey(targets.map(target=>target.track))!==idsKey(this.trackIds)) throw fail('invalid_rate_target','当前弹窗的目标音轨已锁定');
    try { this._assertCurrent(); } catch(error) { this._fail(error); throw error; }
    this.pending=targets; this._schedule();
  }
  dropPending() {
    this.pending=undefined;clearTimeout(this.timer);this.timer=null;
    if(!this.inFlight)this._settle();
  }
  flush() {
    if(!this.active)return Promise.reject(this.error || fail('stream_closed','本次连续变速已结束'));
    try { this._assertCurrent(); } catch(error) { this._fail(error);return Promise.reject(error); }
    if(this.pending===undefined&&!this.inFlight)return Promise.resolve(this.currentSnapshot);
    this.flushing=true;
    const promise=new Promise((resolve,reject)=>this.waiters.push({resolve,reject}));
    if(!this.inFlight){clearTimeout(this.timer);this.timer=null;this._schedule();}
    return promise;
  }
  cancel() {
    const inFlight=this.inFlight;
    this.active=false;this.pending=undefined;clearTimeout(this.timer);this.timer=null;this._release();
    this._settle(fail('stream_closed','本次变速已结束；未发送的数值已丢弃'));
    return inFlight ? inFlight.then(snapshot=>snapshot) : Promise.resolve(this.currentSnapshot);
  }
  _schedule(busy=false) {
    if(!this.active||this.pending===undefined||this.inFlight||this.timer!==null)return;
    const delay=busy?16:this.flushing?0:Math.max(0,this.intervalMs-(performance.now()-this.lastStarted));
    this.timer=setTimeout(()=>{this.timer=null;void this._pump();},delay);
  }
  async _pump() {
    if(!this.active||this.pending===undefined||this.inFlight)return;
    try { this._assertCurrent(); } catch(error) { this._fail(error);return; }
    if(this.adapter.core.busy){this._schedule(true);return;}
    const targets=this.pending;this.pending=undefined;this.lastStarted=performance.now();
    this.inFlight=this.adapter._apply(targets,this.loop,this.currentSnapshot);
    try {
      const snapshot=await this.inFlight;
      this.currentSnapshot=snapshot;
      if(this.active){this._assertCurrent();try{this.onConfirmed?.(snapshot,targets);}catch{/* Presentation cannot replay a confirmed command. */}}
    } catch(error) {this._fail(error);}
    finally {
      this.inFlight=null;
      if(this.active&&this.pending!==undefined)this._schedule();else this._settle(this.error);
    }
  }
  _fail(error) {
    const notify=this.active;this.active=false;this.error=error;this.pending=undefined;
    clearTimeout(this.timer);this.timer=null;this._release();this._settle(error);
    if(notify){try{this.onError?.(error);}catch{/* Failure cannot restart the queue. */}}
  }
  _release(){if(this.adapter._stream===this)this.adapter._stream=null;}
  _settle(error=null){this.flushing=false;for(const waiter of this.waiters.splice(0)){if(error)waiter.reject(error);else waiter.resolve(this.currentSnapshot);}}
}

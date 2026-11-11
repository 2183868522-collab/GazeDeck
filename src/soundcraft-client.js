// Browser adapter for the local serve.py bridge. It never plays browser audio.
export class SoundCraftClientError extends Error {
  constructor(code, message, mayHaveExecuted = false) {
    super(message);
    this.name = 'SoundCraftClientError';
    this.code = code;
    this.mayHaveExecuted = mayHaveExecuted;
  }
}

const fail = (code, message, mayHaveExecuted = false) => new SoundCraftClientError(code, message, mayHaveExecuted);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const backgroundRetryDelays = [300, 750];
const transientReadCodes = new Set(['timeout', 'unavailable', 'network_error', 'busy']);

export const EQ_PARAMETERS = {low:'low_shelf_gain', mid:'mid_gain', high:'high_shelf_gain'};
const EQ_FREQUENCIES = {low:'low_shelf_freq', mid:'mid_freq', high:'high_shelf_freq'};
const numericParams = value => value && typeof value === 'object' && !Array.isArray(value)
  && Object.entries(value).every(([key,number]) => key.length > 0 && finite(number));
const validEqInsert = insert => insert && insert.plugin === 'eq_7band' && insert.bypass === false && numericParams(insert.params);
export function eqInsertKey(insert) {
  if (insert === null) return 'null';
  if (!validEqInsert(insert)) return '';
  return JSON.stringify([insert.plugin,insert.bypass,Object.entries(insert.params).sort(([a],[b]) => a.localeCompare(b))]);
}
function eqTrackSnapshot(track) {
  let inserts = null;
  if (Array.isArray(track.inserts) && track.inserts.length <= 10
    && track.inserts.every(insert => insert && Number.isInteger(insert.slot) && insert.slot >= 0 && insert.slot < 10
      && typeof insert.plugin === 'string' && insert.plugin && typeof insert.bypass === 'boolean' && numericParams(insert.params))
    && new Set(track.inserts.map(insert => insert.slot)).size === track.inserts.length) {
    inserts = track.inserts.map(insert => ({slot:insert.slot,plugin:insert.plugin,bypass:insert.bypass,params:{...insert.params}}));
  }
  return {inserts,kind:track.kind,inactive:track.inactive,automationMode:track.automation_mode,automation:track.automation};
}
// A missing full insert/automation read disables EQ alone, preserving transport/volume.
export function eqTarget(snapshot, trackId) {
  const base = {trackId,slot:null,insert:null,values:{low:0,mid:0,high:0},frequencies:{low:100,mid:1000,high:8000}};
  const reject = reason => ({...base,supported:false,reason});
  const track = snapshot?.tracks?.find(item => item.id === trackId);
  if (!track) return reject('所选真实轨道不存在，请重新连接');
  if (track.kind !== 'audio' || track.inactive === true) return reject('当前 EQ 仅支持已启用的音频轨道');
  if (!['read','off'].includes(track.automationMode) || !Array.isArray(track.automation)
    || track.automation.some(lane => !lane || !(lane.points === 0 || Array.isArray(lane.points) && lane.points.length === 0))) {
    return reject('轨道自动化未就绪或正在写入／含自动化曲线，暂不覆盖 EQ');
  }
  const inserts = track.inserts;
  if (!Array.isArray(inserts)) return reject('未取得完整插件参数，请重新连接读取');
  const candidates = inserts.filter(insert => insert.plugin === 'eq_7band');
  if (candidates.length > 1) return reject('轨道存在多个 EQ 7-Band，请先在 SoundCraft 中保留一个明确的控制目标');
  if (!candidates.length) {
    const slot = Array.from({length:10},(_,index) => index).find(index => !inserts.some(insert => insert.slot === index));
    return slot === undefined ? reject('轨道插件插槽已满，不会替换已有插件') : {...base,slot,supported:true,reason:''};
  }
  const {slot,...insert} = candidates[0];
  if (!validEqInsert(insert)) return reject('EQ 插件已旁路或参数无效，请先在 SoundCraft 中启用并检查');
  const values = Object.fromEntries(Object.entries(EQ_PARAMETERS).map(([band,param]) => [band,insert.params[param]]));
  const frequencies = Object.fromEntries(Object.entries(EQ_FREQUENCIES).map(([band,param]) => [band,insert.params[param]]));
  if (Object.values(values).some(value => !finite(value) || value < -24 || value > 24)
    || Object.values(frequencies).some(value => !finite(value) || value <= 0)) return reject('EQ 三频段增益或频率参数不完整，请重新连接检查');
  return {...base,slot,insert,values,frequencies,supported:true,reason:''};
}

function tempoSnapshot(raw) {
  const points = Array.isArray(raw) ? raw : [];
  const validPoint = point => point && Number.isSafeInteger(point.tick) && point.tick >= 0
    && finite(point.bpm) && point.bpm >= 5 && point.bpm <= 1000;
  const tempoMap = points.filter(validPoint).map(point => [point.tick, point.bpm]).sort((a, b) => a[0] - b[0]);
  let tempoReason = '';
  if (!Array.isArray(raw) || !points.length) tempoReason = '工程没有可读取的 BPM 信息';
  else if (tempoMap.length !== points.length) tempoReason = '工程速度图包含无效数据，暂不修改 BPM';
  else if (tempoMap.length !== 1 || tempoMap[0][0] !== 0) tempoReason = '工程包含多个速度点或非起点速度点，暂不覆盖速度图';
  else if (tempoMap[0][1] < 20 || tempoMap[0][1] > 300) tempoReason = '当前工程 BPM 超出本模块的 20–300 范围';
  const tempoBpm = tempoMap.length === 1 && tempoMap[0][0] === 0 && tempoMap.length === points.length ? tempoMap[0][1] : null;
  return {tempoMap, tempoMapKey: JSON.stringify(tempoMap), tempoBpm, tempoSupported: !tempoReason, tempoReason};
}

// The shared project playhead and each varispeed source phase are different.
// Only publish source positions when desired state and audio callback agree.
function sourcePositions(session,status,lengthSamples) {
  const rates=session.playback_rates,actual=status.track_rates;
  if(!rates||typeof rates.epoch!=='string'||!rates.epoch||rates.epoch.length>256||status.track_rates_epoch!==rates.epoch
    ||!Array.isArray(rates.tracks)||!Array.isArray(actual)||actual.length>session.tracks.length
    ||rates.tracks.length>session.tracks.length||typeof status.audio_device!=='string'||!status.audio_device
    ||!Number.isSafeInteger(lengthSamples)||lengthSamples<=0)return [];
  const desiredIds=new Set();
  for(const desired of rates.tracks){
    if(!desired||!Number.isSafeInteger(desired.track)||desiredIds.has(desired.track)
      ||!session.tracks.some(track=>track.id===desired.track)||!finite(desired.rate)||desired.rate<.5||desired.rate>2
      ||!Number.isSafeInteger(desired.revision)||desired.revision<0
      ||(desired.loop===null?desired.rate!==1||desired.revision!==0
        :!desired.loop||!Number.isSafeInteger(desired.loop.start)||!Number.isSafeInteger(desired.loop.end)
          ||desired.loop.start<0||desired.loop.end<=desired.loop.start||desired.loop.end>lengthSamples))return [];
    desiredIds.add(desired.track);
  }
  const seen=new Set(),positions=[];
  for(const row of actual){
    if(!row||!Number.isSafeInteger(row.track)||seen.has(row.track)||!session.tracks.some(track=>track.id===row.track)
      ||row.epoch!==rates.epoch||!finite(row.rate)||row.rate<.5||row.rate>2
      ||!Number.isSafeInteger(row.revision)||row.revision<0
      ||!Number.isSafeInteger(row.loop_start)||!Number.isSafeInteger(row.loop_end)
      ||row.loop_start<0||row.loop_end<=row.loop_start||row.loop_end>lengthSamples
      ||!finite(row.source_position)||row.source_position<row.loop_start||row.source_position>=row.loop_end)return [];
    seen.add(row.track);
    const desired=rates.tracks.find(entry=>entry.track===row.track);
    if(desired?.rate!==row.rate||desired.revision!==row.revision
      ||desired.loop?.start!==row.loop_start||desired.loop?.end!==row.loop_end)continue;
    positions.push({track:row.track,sourcePositionSamples:row.source_position,rate:row.rate,revision:row.revision});
  }
  return positions;
}

export class SoundCraftClient {
  constructor({ fetchImpl = globalThis.fetch, timeoutMs = 5000 } = {}) {
    this.fetchImpl = fetchImpl.bind(globalThis);
    this.timeoutMs = timeoutMs;
    this.snapshot = null;
    this.connected = false;
    this.busy = false;
    this._binding = null;
    this._generation = 0;
    this._controllers = new Set();
    this._volumeStream = null;
  }

  disconnect() {
    this._generation++;
    this.connected = false;
    this._binding = null;
    this._volumeStream?._fail(fail('disconnected', '连接已解除，未发送的音量调节已丢弃'));
    for (const controller of this._controllers) controller.abort(fail('disconnected', '连接已由用户解除'));
    // Retain the last snapshot for display only; connected=false prohibits commands.
  }

  async connect() {
    return this._run(async context => {
      this.connected = false;
      const snapshot = await this._readSnapshot(context);
      this._assertCurrent(context);
      this._binding = snapshot.projectKey;
      this.snapshot = snapshot;
      this.connected = true;
      return snapshot;
    });
  }

  async refresh({ retryTransient = false, onRetry } = {}) {
    this._requireConnected();
    const generation=this._generation,binding=this._binding;
    const epoch = this.snapshot?.playbackRateEpoch;
    try {
      return await this._run(async context => {
        for (let attempt = 0; ; attempt++) {
          try {
            return await this._refreshBound(context, attempt > 0 ? epoch : undefined);
          } catch (error) {
            if (!retryTransient || attempt >= backgroundRetryDelays.length
              || error.mayHaveExecuted !== false || !transientReadCodes.has(error.code)) throw error;
            this._assertCurrent(context);
            onRetry?.(attempt + 1, backgroundRetryDelays.length, error);
            await new Promise(resolve => setTimeout(resolve, backgroundRetryDelays[attempt]));
            this._assertCurrent(context);
          }
        }
      });
    }
    catch(error){
      // A definitive read-only overload is not a lost connection or an uncertain
      // write. The next command still re-reads the bound project before mutation.
      if(error.code==='busy'&&error.mayHaveExecuted===false&&this._generation===generation
        &&this._binding===binding&&this.snapshot?.projectKey===binding)this.connected=true;
      throw error;
    }
  }

  play() { return this._command('PLAY', {}, snapshot => snapshot.playing === true); }
  pause() { return this._command('PAUSE', {}, snapshot => snapshot.playing === false); }

  _audioResetParams(snapshot, bindings) {
    const deckA = Number(bindings?.A), deckB = Number(bindings?.B);
    if (!snapshot.projectPath || !snapshot.playbackRateEpoch
      || !Number.isSafeInteger(deckA) || !Number.isSafeInteger(deckB) || deckA === deckB
      || !snapshot.tracks.some(track => track.id === deckA)
      || !snapshot.tracks.some(track => track.id === deckB)) {
      throw fail('invalid_reset_binding', '请重新连接 SoundCraft 并绑定两条不同的 A/B 音频轨道');
    }
    return {projectPath:snapshot.projectPath,projectName:snapshot.projectName,
      trackIds:snapshot.tracks.map(track => track.id).sort((a,b) => a-b),
      epoch:snapshot.playbackRateEpoch,deckA,deckB};
  }

  async captureAudioBaseline(bindings) {
    this._requireConnected();
    return this._run(async context => {
      const snapshot = await this._refreshBound(context);
      const params = this._audioResetParams(snapshot, bindings);
      const reply = await this._request('/api/soundcraft', {method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({action:'CAPTURE_AUDIO_BASELINE',params})}, context);
      if (reply.result?.projectKey !== snapshot.projectKey || reply.result?.epoch !== params.epoch) {
        throw fail('reset_baseline_not_confirmed', 'SoundCraft 音频初始值未确认，请重新连接');
      }
      return reply.result;
    });
  }

  async resetAudio(bindings) {
    this._requireConnected();
    return this._run(async context => {
      const before = await this._refreshBound(context);
      const params = this._audioResetParams(before, bindings);
      context.mutationSent = true;
      const reply = await this._request('/api/soundcraft', {method:'POST',
        headers:{'Content-Type':'application/json'}, body:JSON.stringify({action:'RESET_AUDIO',params})},
      context, 60000);
      context.mutationAccepted = true;
      const expected = reply.result;
      if (expected?.projectKey !== before.projectKey || expected.playing !== false
        || expected.positionSamples !== 0 || !Array.isArray(expected.tracks)
        || expected.tracks.length !== 2) {
        throw fail('reset_not_confirmed', 'SoundCraft 音频重置回执无效；请刷新核对', true);
      }
      const snapshot = await this._refreshBound(context);
      if (snapshot.playing || snapshot.positionSamples !== 0
        || Math.abs(snapshot.tempoBpm - expected.tempoBpm) > .00001
        || expected.tracks.some(row => {
          const track = snapshot.tracks.find(item => item.id === row.id);
          return !track || track.activeSourceId !== row.sourceId
            || Math.abs(track.volumeDb - row.volumeDb) > .001 || track.muted !== row.muted
            || track.inserts?.length !== 0;
        })) {
        throw fail('reset_not_confirmed', 'SoundCraft 回读仍有曲目、音量、效果、BPM 或播放位置未恢复；请核对实际状态', true);
      }
      return {snapshot, ...expected};
    });
  }

  async setEq(trackId, band, db, options = {}) {
    if (!Number.isInteger(trackId) || trackId <= 0 || !Object.hasOwn(EQ_PARAMETERS,band)
      || !finite(db) || db < -24 || db > 24) throw fail('invalid_eq','EQ 需要有效轨道、Low/Mid/High 频段及 -24 至 +24 dB 数值');
    if (!options || typeof options !== 'object' || Array.isArray(options)
      || Object.keys(options).some(key => !['expectedInsert','slot'].includes(key))
      || (Object.hasOwn(options,'slot') && (!Number.isInteger(options.slot) || options.slot < 0 || options.slot > 9))
      || (Object.hasOwn(options,'expectedInsert') && !eqInsertKey(options.expectedInsert))) {
      throw fail('invalid_eq_expectation','EQ 校验信息无效，请重新打开弹窗');
    }
    this._requireConnected();
    if (this.volumeStreaming) throw fail('busy','请先结束音量调节，再调整 EQ');
    return this._run(async context => {
      const before = await this._refreshBound(context), target = eqTarget(before,trackId);
      if (!target.supported) throw fail('unsupported_eq',target.reason);
      if ((Object.hasOwn(options,'slot') && options.slot !== target.slot)
        || (Object.hasOwn(options,'expectedInsert') && eqInsertKey(options.expectedInsert) !== eqInsertKey(target.insert))) {
        throw fail('eq_changed','EQ 插槽或参数已在其他位置变化，请重新打开弹窗；不覆盖外部修改');
      }
      if (!before.projectPath) throw fail('invalid_project','请先保存有效的 SoundCraft 工程，再调整 EQ');
      const beforeDb = target.values[band];
      if (Math.abs(db-beforeDb) < .000001) return {snapshot:before,trackId,slot:target.slot,band,beforeDb,afterDb:beforeDb,created:false,changed:false,insert:target.insert};
      const params = {projectPath:before.projectPath,projectName:before.projectName,
        trackIds:before.tracks.map(track => track.id).sort((a,b) => a-b),trackId,slot:target.slot,
        expectedInsert:target.insert,band,db};
      this._assertCurrent(context); context.mutationSent = true;
      let reply;
      try {
        reply = await this._request('/api/soundcraft',{method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({action:'SET_EQ',params})},context);
      } catch (error) {
        if (error.code === 'invalid_action') throw fail('bridge_update_required',
          'EQ 接口尚未加载，请关闭旧 serve 窗口并重新双击桌面 serve.py，然后刷新网页',error.mayHaveExecuted);
        throw error;
      }
      context.mutationAccepted = true;
      const eq = reply.result?.eq;
      if (!eq || eq.projectKey !== before.projectKey || eq.trackId !== trackId || eq.slot !== target.slot
        || eq.band !== band || !finite(eq.beforeDb) || Math.abs(eq.beforeDb-beforeDb) > .000001
        || !finite(eq.afterDb) || Math.abs(eq.afterDb-db) > .001 || eq.created !== (target.insert === null)
        || eq.changed !== true || !eqInsertKey(eq.insert) || !finite(eq.insert.params[EQ_PARAMETERS[band]]) || Math.abs(eq.insert.params[EQ_PARAMETERS[band]]-db) > .001) {
        throw fail('not_confirmed','SoundCraft EQ 回执无效，请重新连接核对；未自动重发',true);
      }
      if (target.insert && (Object.keys(target.insert.params).length !== Object.keys(eq.insert.params).length
        || Object.keys(target.insert.params).some(param => param !== EQ_PARAMETERS[band]
        && eq.insert.params[param] !== target.insert.params[param]))) throw fail('not_confirmed','EQ 其他参数意外变化，请重新连接核对',true);
      if (!target.insert && Object.entries(EQ_PARAMETERS).some(([other,param]) => other !== band && eq.insert.params[param] !== 0)) {
        throw fail('not_confirmed','新建 EQ 的其他频段并非中性值，请重新连接核对',true);
      }
      const snapshot = await this._refreshBound(context), actual = eqTarget(snapshot,trackId);
      if (!actual.supported || actual.slot !== eq.slot || eqInsertKey(actual.insert) !== eqInsertKey(eq.insert)
        || Math.abs(actual.values[band]-db) > .001) throw fail('not_confirmed','SoundCraft 实际 EQ 参数未确认或已在其他位置变化，请重新连接核对；未自动重发',true);
      return {snapshot,...eq};
    });
  }

  async setTempo(bpm, {expectedTempoMapKey} = {}) {
    if (!finite(bpm) || bpm < 20 || bpm > 300) throw fail('invalid_tempo', '工程 BPM 必须是 20 至 300 的有限数值');
    if (expectedTempoMapKey !== undefined && typeof expectedTempoMapKey !== 'string') {
      throw fail('invalid_tempo_expectation', 'BPM 校验信息无效，请重新打开参数弹窗');
    }
    this._requireConnected();
    if (this.volumeStreaming) throw fail('busy', '请先结束音量调节，再调整工程 BPM');
    return this._run(async context => {
      const before = await this._refreshBound(context);
      if (!before.tempoSupported) throw fail('unsupported_tempo', before.tempoReason || '当前工程速度图暂不支持 BPM 调节');
      if (expectedTempoMapKey !== undefined && expectedTempoMapKey !== before.tempoMapKey) {
        throw fail('tempo_changed', '工程 BPM 已在其他位置变化，请重新打开弹窗核对，不覆盖外部修改');
      }
      if (!before.projectPath) throw fail('invalid_project', '请先保存有效的 SoundCraft 工程，再调整 BPM');
      if (bpm === before.tempoBpm) return {snapshot:before, beforeBpm:bpm, afterBpm:bpm, changed:false};
      const params = {projectPath:before.projectPath, projectName:before.projectName,
        trackIds:before.tracks.map(track => track.id).sort((a, b) => a - b), expectedTempoMap:before.tempoMap, bpm};
      this._assertCurrent(context);
      context.mutationSent = true;
      let reply;
      try {
        reply = await this._request('/api/soundcraft', {method:'POST', headers:{'Content-Type':'application/json'},
          body:JSON.stringify({action:'SET_TEMPO', params})}, context);
      } catch (error) {
        if (error.code === 'invalid_action') throw fail('bridge_update_required',
          'BPM 接口尚未加载，请关闭旧 serve 窗口并重新双击桌面 serve.py，然后刷新网页', error.mayHaveExecuted);
        throw error;
      }
      context.mutationAccepted = true;
      const tempo = reply.result?.tempo;
      if (!tempo || tempo.projectKey !== before.projectKey || tempo.beforeBpm !== before.tempoBpm
        || tempo.afterBpm !== bpm || tempo.changed !== true) {
        throw fail('not_confirmed', 'SoundCraft BPM 回执无效，请重新连接核对；未自动重发', true);
      }
      const snapshot = await this._refreshBound(context);
      if (!snapshot.tempoSupported || snapshot.tempoBpm !== bpm || snapshot.tempoMapKey !== JSON.stringify([[0, bpm]])) {
        throw fail('not_confirmed', 'SoundCraft 工程 BPM 尚未确认或已在其他位置变化，请重新连接核对；未自动重发', true);
      }
      return {snapshot, beforeBpm:tempo.beforeBpm, afterBpm:tempo.afterBpm, changed:true};
    });
  }

  async seekRelative(deltaSeconds) {
    if (!finite(deltaSeconds) || Math.abs(deltaSeconds) > 30) {
      throw fail('invalid_seek', '每次快进／快退必须是 -30 至 +30 秒的有限数值');
    }
    this._requireConnected();
    if (this.volumeStreaming) throw fail('busy', '请先结束音量调节，再调整播放位置');
    return this._run(async context => {
      const before = await this._refreshBound(context);
      if (!Number.isSafeInteger(before.lengthSamples) || before.lengthSamples <= 0
        || !Number.isSafeInteger(before.positionSamples) || before.positionSamples < 0
        || !before.projectPath || !finite(before.sampleRate) || before.sampleRate <= 0) {
        throw fail('invalid_seek_range', '工程时间范围尚未就绪，请打开并保存含有音频的 SoundCraft 工程');
      }
      const params = {
        projectPath: before.projectPath, projectName: before.projectName,
        trackIds: before.tracks.map(track => track.id).sort((a, b) => a - b),
        sampleRate: before.sampleRate, lengthSamples: before.lengthSamples, deltaSeconds,
      };
      this._assertCurrent(context);
      context.mutationSent = true;
      let reply;
      try {
        reply = await this._request('/api/soundcraft', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'SEEK_RELATIVE', params }),
        }, context);
      } catch (error) {
        if (error.code === 'invalid_action') {
          throw fail('bridge_update_required', '定位接口尚未加载，请关闭旧 serve 窗口并重新双击桌面 serve.py，然后刷新网页', error.mayHaveExecuted);
        }
        throw error;
      }
      context.mutationAccepted = true;
      const seek = reply.result?.seek;
      const integerFields = ['beforeSamples', 'afterSamples', 'lengthSamples', 'rangeStart', 'rangeEnd'];
      if (!seek || seek.projectKey !== before.projectKey
        || integerFields.some(key => !Number.isSafeInteger(seek[key]))
        || seek.beforeSamples < 0 || seek.afterSamples < 0
        || seek.sampleRate !== before.sampleRate || seek.lengthSamples !== before.lengthSamples
        || seek.rangeStart < 0 || seek.rangeEnd <= seek.rangeStart || seek.rangeEnd > seek.lengthSamples
        || seek.requestedDeltaSeconds !== deltaSeconds || !finite(seek.deltaSeconds)) {
        throw fail('not_confirmed', 'SoundCraft 定位回执无效，请重新连接核对；未自动重发', true);
      }
      const actualDelta = (seek.afterSamples - seek.beforeSamples) / seek.sampleRate;
      const beforeInside = seek.beforeSamples >= seek.rangeStart && seek.beforeSamples < seek.rangeEnd;
      const rewindFromEnd = deltaSeconds < 0 && seek.rangeStart === 0 && seek.rangeEnd === seek.lengthSamples
        && seek.beforeSamples === seek.lengthSamples;
      const target = deltaSeconds === 0 ? seek.beforeSamples
        : Math.max(seek.rangeStart, Math.min(seek.rangeEnd - 1,
          Math.round(seek.beforeSamples + deltaSeconds * seek.sampleRate)));
      if (seek.afterSamples !== target || Math.abs(seek.deltaSeconds - actualDelta) > 1e-9
        || (deltaSeconds !== 0 && !beforeInside && !rewindFromEnd)) {
        throw fail('not_confirmed', 'SoundCraft 未确认所请求的相对定位，请重新连接核对；未自动重发', true);
      }
      const snapshot = await this._refreshBound(context);
      if (snapshot.sampleRate !== before.sampleRate || snapshot.lengthSamples !== before.lengthSamples) {
        throw fail('project_changed', 'SoundCraft 工程时间范围已变化，请重新连接核对定位结果', true);
      }
      // The locate ACK names the exact applied sample. A subsequent playing read
      // may naturally advance or loop; never mistake that elapsed time for failure.
      return {
        snapshot, deltaSeconds: actualDelta, requestedDeltaSeconds: deltaSeconds,
        beforeSeconds: seek.beforeSamples / seek.sampleRate, afterSeconds: seek.afterSamples / seek.sampleRate,
      };
    });
  }

  enableFullLoop() { return this._setFullLoop(true); }
  disableFullLoop() { return this._setFullLoop(false); }

  async _setFullLoop(enabled) {
    this._requireConnected();
    return this._run(async context => {
      const before = await this._refreshBound(context);
      this._assertCurrent(context);
      context.mutationSent = true;
      const reply = await this._request('/api/soundcraft', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: enabled ? 'ENABLE_FULL_LOOP' : 'DISABLE_FULL_LOOP', params: {
          projectPath: before.projectPath, trackIds: before.tracks.map(track => track.id),
        } }),
      }, context);
      context.mutationAccepted = true;
      const loop = reply.result?.loop;
      const ids = before.tracks.map(track => track.id).sort((a, b) => a - b);
      if (!loop || loop.pinned !== enabled || loop.projectKey !== before.projectKey
        || (!enabled && loop.enabled !== false)
        || (enabled && (loop.start !== 0 || !Number.isSafeInteger(loop.end) || loop.end <= 0
        || !finite(loop.sampleRate) || loop.sampleRate <= 0
        || !Array.isArray(loop.trackIds) || JSON.stringify([...loop.trackIds].sort((a, b) => a - b)) !== JSON.stringify(ids)))) {
        throw fail('not_confirmed', '循环设置的回执无效，请检查 SoundCraft 后重新连接', true);
      }
      await this._refreshBound(context);
      return loop;
    });
  }

  setVolume(trackId, db) {
    if (!Number.isInteger(trackId) || trackId <= 0) return Promise.reject(fail('invalid_track', '请选择有效的 SoundCraft 轨道'));
    if (!finite(db) || db < -144 || db > 12) return Promise.reject(fail('invalid_volume', '音量必须是 -144 至 +12 dB 的有限数值'));
    if (!this.snapshot?.tracks.some(track => track.id === trackId)) return Promise.reject(fail('invalid_track', '所选轨道不在已连接的工程中'));
    return this._command('SET_VOLUME', { track: trackId, db }, snapshot => {
      const track = snapshot.tracks.find(item => item.id === trackId);
      return !!track && Math.abs(track.volumeDb - db) <= 0.02;
    });
  }

  get volumeStreaming() { return this._volumeStream?.active === true; }

  createVolumeStream(trackId, options = {}) {
    this._requireConnected();
    if (!Number.isInteger(trackId) || !this.snapshot?.tracks.some(track => track.id === trackId)) {
      throw fail('invalid_track', '请选择有效的 SoundCraft 轨道');
    }
    if (this.busy || this.volumeStreaming) throw fail('busy', '上一条请求或音量调节尚未完成');
    const stream = new SoundCraftVolumeStream(this, trackId, options);
    this._volumeStream = stream;
    return stream;
  }

  async _command(action, params, confirmed) {
    this._requireConnected();
    return this._run(async context => {
      await this._refreshBound(context);
      if (action === 'SET_VOLUME' && !this.snapshot.tracks.some(track => track.id === params.track)) {
        throw fail('invalid_track', '目标轨道已不可用，请重新连接');
      }
      this._assertCurrent(context);
      context.mutationSent = true;
      await this._request('/api/soundcraft', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, params }),
      }, context);
      context.mutationAccepted = true;
      let snapshot = await this._refreshBound(context);
      // A read may precede the audio/UI thread's application of the accepted command.
      // Only repeat reads; never repeat the POST after an ambiguous result.
      for (let attempt = 0; attempt < 2 && !confirmed(snapshot); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 50));
        this._assertCurrent(context);
        snapshot = await this._refreshBound(context);
      }
      if (!confirmed(snapshot)) throw fail('not_confirmed', 'SoundCraft 已接受指令，但实际状态尚未确认；请检查后重新连接', true);
      return snapshot;
    });
  }

  async loadDeckSong({ projectKey, epoch, track, song, songId, canLoad }) {
    this._requireConnected();
    const selectedSong = song || {id:songId};
    const response = await this._run(async context => {
      const snapshot = await this._refreshBound(context);
      if (snapshot.projectKey !== projectKey || snapshot.playbackRateEpoch !== epoch || !canLoad()) {
        return {error:fail('stale_target', '工程、音轨或控制状态已变化，请返回重新选曲')};
      }
      const choice = Number.isSafeInteger(selectedSong.sourceId)
        ? {sourceId:selectedSong.sourceId, sourceName:selectedSong.name, sourcePath:selectedSong.path}
        : {songId:selectedSong.id};
      const params = {
        projectPath: snapshot.projectPath, projectName: snapshot.projectName,
        trackIds: snapshot.tracks.map(item => item.id), epoch, track, ...choice,
      };
      context.mutationSent = true;
      let reply;
      try {
        reply = await this._request('/api/soundcraft', {
          method: 'POST', headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({action: 'LOAD_DECK_SONG', params}),
        }, context, 55000);
      } catch (error) {
        if (error.mayHaveExecuted) throw error;
        return {error};
      }
      context.mutationAccepted = true;
      const result = reply.result;
      if (result?.track !== track || result.song?.id !== selectedSong.id || typeof result.song.name !== 'string'
        || !Number.isSafeInteger(result.clipId) || result.clipId <= 0 || !finite(result.durationSeconds) || result.durationSeconds <= 0
        || typeof result.playing !== 'boolean' || typeof result.paused !== 'boolean') {
        throw fail('song_not_confirmed', '未取得有效的 SoundCraft 换曲回执', true);
      }
      await this._refreshBound(context);
      return {result};
    });
    if (response.error) throw response.error;
    return response.result;
  }

  _requireConnected() {
    if (!this.connected || !this._binding) throw fail('not_connected', '请先连接并确认 SoundCraft 测试工程');
  }

  _assertCurrent(context) {
    if (context.generation !== this._generation) throw fail('disconnected', '连接已解除，已忽略迟到的结果', context.mutationSent);
  }

  async _run(operation) {
    if (this.busy) throw fail('busy', '上一条请求尚未完成，请稍候');
    this.busy = true;
    const context = { generation: this._generation, mutationSent: false, mutationAccepted: false };
    try {
      const result = await operation(context);
      this._assertCurrent(context);
      return result;
    } catch (error) {
      if (context.generation !== this._generation) throw fail('disconnected', '连接已解除，未重新发送控制指令', context.mutationSent);
      const converted = error instanceof SoundCraftClientError ? error : fail('network_error', 'SoundCraft 请求失败，请重新连接', context.mutationSent);
      if (context.mutationAccepted) converted.mayHaveExecuted = true;
      // A definitive bridge overload did not reach the engine. Keep the bound
      // session so the next command can verify the project again before writing.
      if (!(converted.code === 'busy' && converted.mayHaveExecuted === false
        && this.connected && this._binding && this.snapshot?.projectKey === this._binding)) this.connected = false;
      throw converted;
    } finally {
      this.busy = false;
    }
  }

  async _refreshBound(context, expectedEpoch) {
    const snapshot = await this._readSnapshot(context);
    this._assertCurrent(context);
    if (snapshot.projectKey !== this._binding) throw fail('project_changed', 'SoundCraft 工程或轨道已变化，请核对后重新连接', context.mutationSent);
    if (expectedEpoch !== undefined && snapshot.playbackRateEpoch !== expectedEpoch) {
      throw fail('project_changed', 'SoundCraft 会话已更换，请核对工程并重新连接');
    }
    this.snapshot = snapshot;
    return snapshot;
  }

  async _readSnapshot(context) {
    const sessionReply = await this._request('/api/soundcraft/session?detail=full', {}, context);
    const statusReply = await this._request('/api/soundcraft/status', {}, context);
    const session = sessionReply.result, status = statusReply.result;
    if (!session || !status || typeof session.name !== 'string' || !Array.isArray(session.tracks)
      || !finite(session.sample_rate) || session.sample_rate <= 0
      || typeof status.playing !== 'boolean' || !finite(session.transport?.position) || session.transport.position < 0) {
      throw fail('invalid_reply', 'SoundCraft 返回的工程或播放状态无效', context.mutationAccepted);
    }
    const tracks = session.tracks.map(track => {
      if (!track || !Number.isInteger(track.id) || track.id <= 0 || typeof track.name !== 'string' || !finite(track.volume_db)) {
        throw fail('invalid_reply', 'SoundCraft 返回的轨道信息无效', context.mutationAccepted);
      }
      const activeSourceId = Array.isArray(track.clips) && track.clips.length === 1
        && Number.isSafeInteger(track.clips[0]?.source) && track.clips[0].source > 0
        ? track.clips[0].source : null;
      // Native Deck seek stops at the end of the last audio clip on this track.
      // Expose the same endpoint so the UI can size its slider to the material.
      const clipEnds = Array.isArray(track.clips) ? track.clips.map(clip =>
        Number.isSafeInteger(clip?.start) && clip.start >= 0
        && Number.isSafeInteger(clip?.length) && clip.length > 0
        && Number.isSafeInteger(clip.start + clip.length)
          ? clip.start + clip.length : null) : [];
      const seekEndSamples = clipEnds.filter(Number.isSafeInteger)
        .reduce((end, clipEnd) => Math.max(end, clipEnd), 0);
      const seekEndSeconds = seekEndSamples > 0 ? seekEndSamples / session.sample_rate : null;
      return { id: track.id, name: track.name, volumeDb: track.volume_db, muted: track.mute === true,
        activeSourceId, seekEndSeconds, ...eqTrackSnapshot(track) };
    });
    const ids = tracks.map(track => track.id).sort((a, b) => a - b);
    if (new Set(ids).size !== ids.length) throw fail('invalid_reply', 'SoundCraft 返回了重复轨道编号', context.mutationAccepted);
    const projectPath = typeof session.path === 'string' ? session.path : '';
    const sources = [];
    const sourceIds = new Set();
    if (Array.isArray(session.sources)) for (const source of session.sources) {
      if (!source || source.loaded !== true || !Number.isSafeInteger(source.id) || source.id <= 0
        || sourceIds.has(source.id) || typeof source.name !== 'string' || !source.name || source.name.length > 255
        || typeof source.path !== 'string' || !source.path || source.path.length > 4096
        || !Number.isSafeInteger(source.frames) || source.frames <= 0) continue;
      sourceIds.add(source.id);
      sources.push({id:`project:${source.id}`, sourceId:source.id, name:source.name, path:source.path,
        durationSeconds:source.frames / session.sample_rate});
    }
    const lengthSamples = Number.isSafeInteger(session.length_samples) && session.length_samples >= 0 ? session.length_samples : null;
    return {
      projectName: session.name, projectPath,
      projectKey: JSON.stringify([projectPath, session.name, ids]),
      playbackRateEpoch: typeof session.playback_rates?.epoch === 'string' && session.playback_rates.epoch.length > 0
        && session.playback_rates.epoch.length <= 256 ? session.playback_rates.epoch : null,
      tracks, sources, playing: status.playing, positionSeconds: session.transport.position / session.sample_rate,
      sampleRate: session.sample_rate, positionSamples: Number.isSafeInteger(session.transport.position) ? session.transport.position : null,
      lengthSamples, durationSeconds: lengthSamples === null ? null : lengthSamples / session.sample_rate,
      sourcePositions: sourcePositions(session,status,lengthSamples),
      ...tempoSnapshot(session.tempo),
      audioDevice: typeof status.audio_device === 'string' ? status.audio_device : '',
    };
  }

  async _request(path, options, context, timeoutMs = this.timeoutMs) {
    this._assertCurrent(context);
    const controller = new AbortController();
    this._controllers.add(controller);
    let timer;
    const interrupted = new Promise((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason || fail('disconnected', '请求已中止')), { once: true });
      timer = setTimeout(() => controller.abort(fail('timeout', 'SoundCraft 请求超时；请检查状态后重新连接', context.mutationSent)), timeoutMs);
    });
    const response = Promise.resolve().then(async () => {
      try {
        this._assertCurrent(context);
        const reply = await this.fetchImpl(path, { ...options, signal: controller.signal, cache: 'no-store' });
        this._assertCurrent(context);
        let body;
        try { body = await reply.json(); }
        catch { throw fail('invalid_reply', '服务未返回有效 JSON；请重启更新后的 serve.py', context.mutationSent); }
        this._assertCurrent(context);
        if (!reply.ok || body?.ok !== true) {
          const details = body?.error;
          throw fail(typeof details?.code === 'string' ? details.code : 'http_error',
            typeof details?.message === 'string' ? details.message : `SoundCraft 接口错误（${reply.status || '未知状态'}）`,
            typeof details?.mayHaveExecuted === 'boolean' ? details.mayHaveExecuted : context.mutationSent);
        }
        return body;
      } catch (error) {
        if (error instanceof SoundCraftClientError) throw error;
        throw fail('network_error', '无法读取 SoundCraft 接口；请检查 serve.py 与控制模式是否运行', context.mutationSent);
      }
    });
    try { return await Promise.race([response, interrupted]); }
    finally { clearTimeout(timer); this._controllers.delete(controller); }
  }
}

// The queue contains only the latest unsent value; transport acknowledgements remain authoritative.
class SoundCraftVolumeStream {
  constructor(client, trackId, { intervalMs = 150, onConfirmed, onError } = {}) {
    this.client = client; this.trackId = trackId;
    this.intervalMs = finite(intervalMs) ? Math.max(16, intervalMs) : 150;
    this.onConfirmed = onConfirmed; this.onError = onError;
    this.generation = client._generation; this.binding = client._binding;
    this.active = true; this.error = null; this.pending = undefined;
    this.timer = null; this.inFlight = null; this.lastStarted = -Infinity;
    this.waiters = []; this.flushing = false;
  }

  set(db) {
    if (!this.active) throw this.error || fail('stream_closed', '本次音量调节已结束');
    if (!finite(db) || db < -144 || db > 12) throw fail('invalid_volume', '音量范围为 -144 至 +12 dB');
    try { this._assertCurrent(); } catch (error) { this._fail(error); throw error; }
    this.pending = db;
    this._schedule();
  }

  dropPending() {
    this.pending = undefined;
    clearTimeout(this.timer); this.timer = null;
    if (!this.inFlight) this._settle();
  }

  flush() {
    if (!this.active) return Promise.reject(this.error || fail('stream_closed', '本次音量调节已结束'));
    try { this._assertCurrent(); } catch (error) { this._fail(error); return Promise.reject(error); }
    if (this.pending === undefined && !this.inFlight) return Promise.resolve(this.client.snapshot);
    this.flushing = true;
    const result = new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
    if (this.pending !== undefined && !this.inFlight) {
      clearTimeout(this.timer); this.timer = null; this._schedule();
    }
    return result;
  }

  cancel() {
    const inFlight = this.inFlight;
    this.active = false;
    this.pending = undefined; clearTimeout(this.timer); this.timer = null;
    this._release();
    const error = fail('stream_closed', '本次音量调节已结束，未发送的值已丢弃');
    this._settle(error);
    return inFlight ? inFlight.then(() => this.client.snapshot) : Promise.resolve(this.client.snapshot);
  }

  _assertCurrent() {
    if (!this.client.connected || this.client._generation !== this.generation || this.client._binding !== this.binding) {
      throw fail('disconnected', '连接或工程已变化，未发送的音量调节已丢弃');
    }
  }

  _schedule(retryBusy = false) {
    if (!this.active || this.pending === undefined || this.inFlight || this.timer !== null) return;
    const delay = retryBusy ? 16 : this.flushing ? 0 : Math.max(0, this.intervalMs - (performance.now() - this.lastStarted));
    this.timer = setTimeout(() => { this.timer = null; void this._pump(); }, delay);
  }

  async _pump() {
    if (!this.active || this.pending === undefined || this.inFlight) return;
    try { this._assertCurrent(); } catch (error) { this._fail(error); return; }
    if (this.client.busy) { this._schedule(true); return; }
    const db = this.pending; this.pending = undefined;
    this.lastStarted = performance.now();
    this.inFlight = this.client.setVolume(this.trackId, db);
    try {
      const snapshot = await this.inFlight;
      if (this.active) {
        this._assertCurrent();
        try { this.onConfirmed?.(snapshot, { trackId: this.trackId, db }); } catch { /* UI callback cannot invalidate an engine acknowledgement. */ }
      }
    } catch (error) {
      this._fail(error);
    } finally {
      this.inFlight = null;
      if (this.active && this.pending !== undefined) this._schedule();
      else this._settle(this.error);
    }
  }

  _fail(error) {
    const notify = this.active;
    this.active = false; this.error = error;
    this.pending = undefined; clearTimeout(this.timer); this.timer = null;
    this._release(); this._settle(error);
    if (notify) { try { this.onError?.(error); } catch { /* An error callback must not restart the queue. */ } }
  }

  _release() { if (this.client._volumeStream === this) this.client._volumeStream = null; }
  _settle(error = null) {
    this.flushing = false;
    for (const waiter of this.waiters.splice(0)) {
      if (error) waiter.reject(error); else waiter.resolve(this.client.snapshot);
    }
  }
}

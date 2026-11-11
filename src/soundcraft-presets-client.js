import {SoundCraftClientError} from './soundcraft-client.js';
import {normalizeTone, TONE_EFFECTS} from './soundcraft-preset-store.js';
const PLUGINS = Object.freeze({eq:'eq_7band', reverb:'room_reverb', delay:'mod_delay', chorus:'chorus'});
const DEFAULTS = Object.freeze({reverb:.25, delay:.3, chorus:.5});
const GAINS = Object.freeze({low:'low_shelf_gain', mid:'mid_gain', high:'high_shelf_gain'});
const clone = value => structuredClone(value);
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const id = value => Number.isSafeInteger(value) && value > 0;
const fail = (code, message, uncertain = false) => new SoundCraftClientError(code, message, uncertain);
const idsKey = values => [...values].sort((a,b)=>a-b).join(',');
const validInserts = inserts => Array.isArray(inserts) && inserts.length <= 10
  && inserts.every(insert => object(insert) && Object.keys(insert).length === 4
    && Number.isInteger(insert.slot) && insert.slot >= 0 && insert.slot < 10
    && typeof insert.plugin === 'string' && insert.plugin.length > 0 && typeof insert.bypass === 'boolean'
    && object(insert.params) && Object.entries(insert.params).every(([key,value])=>key.length > 0 && finite(value)))
  && new Set(inserts.map(insert=>insert.slot)).size === inserts.length;
const insertKey = insert => insert === undefined ? 'absent' : JSON.stringify([insert.slot,insert.plugin,insert.bypass,
  Object.entries(insert.params).sort(([a],[b])=>a.localeCompare(b))]);
const chainKey = inserts => JSON.stringify([...inserts].sort((a,b)=>a.slot-b.slot).map(insertKey));
const sameInsert = (a,b) => insertKey(a) === insertKey(b);
const sameChain = (a,b) => chainKey(a) === chainKey(b);
const close = (a,b) => Math.abs(a-b) <= 0.00001;
const sameTone = (a,b) => a.eq.enabled === b.eq.enabled && Object.keys(GAINS).every(key=>close(a.eq[key],b.eq[key]))
  && TONE_EFFECTS.every(key=>a.effects[key].enabled === b.effects[key].enabled && close(a.effects[key].amount,b.effects[key].amount));
const pluginAt = (row, key) => row.inserts.find(insert=>insert.plugin === PLUGINS[key]);

export function toneTarget(snapshot, trackId) {
  return snapshot?.tracks?.find(row=>row.track === trackId)
    ?? {track:trackId, available:false, reason:'尚未取得此真实音轨的完整音色状态', tone:null, inserts:[]};
}
function parseSnapshot(value, core, uncertain = false) {
  const reject = () => {throw fail('invalid_tone_reply','SoundCraft 音色状态或回执无效，请重新连接核对',uncertain);};
  const all = core?.tracks?.map(track=>track.id) || [], audio = core?.tracks?.filter(track=>track.kind === 'audio').map(track=>track.id) || [];
  if (!object(value) || value.version !== 1 || typeof value.epoch !== 'string' || !value.epoch || value.epoch.length > 256
    || value.epoch !== core?.playbackRateEpoch || typeof value.projectPath !== 'string' || typeof value.projectName !== 'string'
    || value.projectKey !== core?.projectKey || value.projectKey !== JSON.stringify([value.projectPath,value.projectName,[...all].sort((a,b)=>a-b)])
    || !Array.isArray(value.trackIds) || value.trackIds.some(track=>!id(track)) || value.trackIds.length !== all.length
    || new Set(value.trackIds).size !== all.length || idsKey(value.trackIds) !== idsKey(all)
    || typeof value.engineAudioReady !== 'boolean' || typeof value.audioDevice !== 'string' || !Array.isArray(value.tracks)) reject();
  const seen = new Set();
  for (const row of value.tracks) {
    if (!object(row) || !id(row.track) || !audio.includes(row.track) || seen.has(row.track)
      || typeof row.available !== 'boolean' || typeof row.reason !== 'string'
      || row.available && row.reason !== '' || !row.available && !row.reason.trim() || !validInserts(row.inserts)) reject();
    seen.add(row.track);
    try {normalizeTone(row.tone);} catch {reject();}
    if (!row.available) continue; // Native inspector exposes clamped/default controls on read-only rows.
    for (const [kind,plugin] of Object.entries(PLUGINS)) {
      const matches = row.inserts.filter(insert=>insert.plugin === plugin);
      if (matches.length > 1) reject();
      const insert = matches[0], controls = kind === 'eq' ? row.tone.eq : row.tone.effects[kind];
      if (controls.enabled !== (!!insert && !insert.bypass)) reject();
      if (kind === 'eq') {
        if (Object.entries(GAINS).some(([key,param])=>!close(controls[key],insert?.params[param] ?? 0))) reject();
      } else if (!close(controls.amount,(insert?.params.mix ?? DEFAULTS[kind]*100)/100)) reject();
    }
  }
  if (seen.size !== audio.length) reject();
  return clone(value);
}
function desiredTone(row, requested) {
  const wanted = normalizeTone(requested);
  if (!pluginAt(row,'eq') && !wanted.eq.enabled) wanted.eq = clone(row.tone.eq);
  else for (const key of Object.keys(GAINS)) wanted.eq[key] = Math.fround(wanted.eq[key]);
  for (const effect of TONE_EFFECTS) {
    if (!pluginAt(row,effect) && !wanted.effects[effect].enabled) wanted.effects[effect] = clone(row.tone.effects[effect]);
    else wanted.effects[effect].amount = Math.fround(wanted.effects[effect].amount * 100) / 100;
  }
  return wanted;
}
function protectedParams(before, after, kind) {
  const omit = kind === 'eq' ? Object.values(GAINS) : ['mix'];
  const params = value => Object.entries(value.params).filter(([key])=>!omit.includes(key)).sort(([a],[b])=>a.localeCompare(b));
  return before.slot === after.slot && before.plugin === after.plugin && JSON.stringify(params(before)) === JSON.stringify(params(after));
}
function protectedApply(before, after, wanted) {
  for (const insert of before.inserts) {
    const kind = Object.keys(PLUGINS).find(key=>PLUGINS[key] === insert.plugin);
    const next = after.inserts.find(item=>item.slot === insert.slot);
    if (!next || (kind ? !protectedParams(insert,next,kind) : !sameInsert(insert,next))) return false;
  }
  // Newly inserted plugins must be one of the four narrowly scoped tone processors.
  return after.inserts.filter(insert=>!before.inserts.some(old=>old.slot === insert.slot))
    .every(insert=>{
      const kind = Object.keys(PLUGINS).find(key=>PLUGINS[key] === insert.plugin);
      return kind && (kind === 'eq' ? wanted.eq.enabled : wanted.effects[kind].enabled);
    });
}
function changedSlots(before, after) {
  return Array.from({length:10},(_,slot)=>slot).filter(slot=>!sameInsert(before.inserts.find(insert=>insert.slot === slot),after.inserts.find(insert=>insert.slot === slot)));
}
function validateTargets(raw) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 2 || raw.some(target=>!object(target)
    || Object.keys(target).length !== 2 || !id(target.track)) || new Set(raw.map(target=>target.track)).size !== raw.length) {
    throw fail('invalid_tone','请选择一至两条不同的真实音轨及有效音色预设');
  }
  try {return raw.map(target=>({track:target.track,tone:normalizeTone(target.tone)}));}
  catch (error) {throw fail('invalid_tone',error.message);}
}
export class SoundCraftPresetsClient {
  constructor(core) {this.core = core; this.snapshot = null; this._receipts = new Map();}
  async _read(context) {
    const reply = await this.core._request('/api/soundcraft/tone',{},context);
    const snapshot = parseSnapshot(reply.result,this.core.snapshot,context.mutationSent);
    this.core._assertCurrent(context); this.snapshot = snapshot; return snapshot;
  }
  async read() {
    const core = this.core; core._requireConnected();
    const generation = core._generation, binding = core._binding;
    try {return await core._run(async context=>{await core._refreshBound(context);return this._read(context);});}
    catch (error) {
      if (['tone_unsupported','presets_unsupported','not_found'].includes(error.code)
        && core._generation === generation && core._binding === binding) {
        core.connected = true; this.snapshot = null;
        throw fail('tone_unsupported','音色事务接口尚未加载，请重启桌面 serve.py 并使用最新的 GazeDeck 扩展版 SoundCraft');
      }
      throw error;
    }
  }
  async apply(rawTargets, expected) {
    const targets = validateTargets(rawTargets), core = this.core;
    this._expectation(expected); core._requireConnected();
    if (core.volumeStreaming) throw fail('busy','请先结束音量调节，再应用音色预设');
    return core._run(async context=>{
      await core._refreshBound(context);
      const before = await this._read(context), coreBefore = clone(core.snapshot);
      this._identity(before,expected);
      if (!before.engineAudioReady || !before.audioDevice) throw fail('tone_audio_unavailable','SoundCraft 音频输出尚未就绪，未发送音色修改');
      const desired = new Map();
      const updates = targets.map(target=>{
        const row = toneTarget(before,target.track), prior = toneTarget(expected,target.track);
        if (!row.available) throw fail('tone_unavailable',row.reason || '目标音色不可用');
        if (!prior.available || !sameChain(row.inserts,prior.inserts)) throw fail('tone_changed','预览后的音色或插件链已变化，请重新预览；未覆盖外部修改');
        desired.set(target.track,desiredTone(row,target.tone));
        return {track:target.track,expectedInserts:clone(row.inserts),tone:target.tone};
      });
      const params = {...this._identityParams(before),updates};
      const after = await this._post('APPLY_TONE',params,context);
      const changed = [];
      for (const row of before.tracks) {
        const next = toneTarget(after,row.track);
        if (desired.has(row.track)) {
          if (!next.available || !sameTone(next.tone,desired.get(row.track)) || !protectedApply(row,next,desired.get(row.track))) this._uncertain();
        } else if (!sameChain(row.inserts,next.inserts) || !sameTone(row.tone,next.tone)) this._uncertain();
        if (!sameChain(row.inserts,next.inserts)) changed.push(row.track);
      }
      this._receipt(after,changed,false);
      await this._readback(after,coreBefore,context);
      if (after.receipt) {
        if (this._receipts.has(after.receipt)) this._uncertain();
        this._receipts.set(after.receipt,{before,after:clone(after),generation:core._generation,binding:core._binding});
        while (this._receipts.size > 64) this._receipts.delete(this._receipts.keys().next().value);
      }
      this.snapshot = after; return after;
    });
  }
  async restore(receipt, expected = this.snapshot) {
    const core = this.core, owned = this._receipts.get(receipt);
    if (typeof receipt !== 'string' || !receipt || !owned) throw fail('invalid_tone_receipt','没有可验证的本次音色修改回执，未发送撤回');
    this._expectation(expected); core._requireConnected();
    if (core.volumeStreaming) throw fail('busy','请先结束音量调节，再撤回音色预设');
    return core._run(async context=>{
      if (owned.generation !== core._generation || owned.binding !== core._binding) throw fail('tone_changed','连接会话已变化，不撤回旧音色');
      await core._refreshBound(context);const before = await this._read(context), coreBefore = clone(core.snapshot);
      this._identity(before,owned.after);this._identity(before,expected);
      if (!before.engineAudioReady || !before.audioDevice) throw fail('tone_audio_unavailable','SoundCraft 音频输出尚未就绪，未发送音色撤回');
      const changes = new Map();
      for (const track of owned.after.updated) {
        const original = toneTarget(owned.before,track), applied = toneTarget(owned.after,track), current = toneTarget(before,track);
        const slots = changedSlots(original,applied); changes.set(track,slots);
        if (slots.some(slot=>!sameInsert(current.inserts.find(insert=>insert.slot === slot),applied.inserts.find(insert=>insert.slot === slot)))) {
          throw fail('tone_changed','本次修改的音色插槽已在其他位置变化，未覆盖外部修改');
        }
      }
      const after = await this._post('RESTORE_TONE',{...this._identityParams(before),receipt},context), changed = [];
      for (const row of before.tracks) {
        const next = toneTarget(after,row.track), slots = changes.get(row.track) || [];
        for (let slot = 0; slot < 10; slot++) {
          const desired = slots.includes(slot) ? toneTarget(owned.before,row.track).inserts : row.inserts;
          if (!sameInsert(next.inserts.find(insert=>insert.slot === slot),desired.find(insert=>insert.slot === slot))) this._uncertain();
        }
        if (!sameChain(row.inserts,next.inserts)) changed.push(row.track);
      }
      this._receipt(after,changed,true);
      await this._readback(after,coreBefore,context);
      this._receipts.delete(receipt);this.snapshot = after;return after;
    });
  }
  _expectation(expected) {
    if (!expected || typeof expected.epoch !== 'string' || !expected.epoch || typeof expected.projectKey !== 'string') {
      throw fail('invalid_tone_expectation','缺少有效音色会话，请重新读取或预览');
    }
  }
  _identity(actual, expected) {
    if (actual.epoch !== expected.epoch || actual.projectKey !== expected.projectKey) throw fail('tone_changed','工程或音色会话已变化，未发送修改');
  }
  _identityParams(snapshot) {return {projectPath:snapshot.projectPath,projectName:snapshot.projectName,trackIds:snapshot.trackIds,epoch:snapshot.epoch};}
  _uncertain() {throw fail('tone_not_confirmed','SoundCraft 音色回执或实际参数未确认，请重新连接核对；未自动重发',true);}
  async _post(action, params, context) {
    this.core._assertCurrent(context);context.mutationSent = true;
    const reply = await this.core._request('/api/soundcraft',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,params})},context);
    context.mutationAccepted = true;
    const result = parseSnapshot(reply.result,this.core.snapshot,true);
    if (result.epoch !== params.epoch) this._uncertain();
    return result;
  }
  _receipt(result, changed, restoring) {
    if (typeof result.changed !== 'boolean' || result.changed !== !!changed.length || !Array.isArray(result.updated)
      || result.updated.some(track=>!id(track)) || new Set(result.updated).size !== changed.length || result.updated.length !== changed.length
      || idsKey(result.updated) !== idsKey(changed)
      || (restoring || !changed.length ? result.receipt !== null : typeof result.receipt !== 'string' || !result.receipt || result.receipt.length > 1024)) this._uncertain();
  }
  async _readback(expected, coreBefore, context) {
    const core = this.core, current = await core._refreshBound(context);
    if (current.playbackRateEpoch !== expected.epoch || current.projectKey !== expected.projectKey) this._uncertain();
    if (['playing','sampleRate','lengthSamples','durationSeconds','tempoMapKey'].some(key=>current[key] !== coreBefore[key])) this._uncertain();
    // Session parsing carries non-insert track state; a tone transaction cannot
    // change track levels, names, automations or routing.
    for (const old of coreBefore.tracks) {
      const next = current.tracks.find(track=>track.id === old.id);
      if (!next) this._uncertain();
      const withoutInserts = track => Object.fromEntries(Object.entries(track).filter(([key])=>key !== 'inserts'));
      if (JSON.stringify(withoutInserts(old)) !== JSON.stringify(withoutInserts(next))) this._uncertain();
      if (old.kind === 'audio' && !sameChain(next.inserts,toneTarget(expected,old.id).inserts)) this._uncertain();
    }
    const actual = await this._read(context);
    if (actual.epoch !== expected.epoch || actual.projectKey !== expected.projectKey
      || actual.tracks.some(row=>!sameChain(row.inserts,toneTarget(expected,row.track).inserts))) this._uncertain();
    this.core._assertCurrent(context);
  }
}

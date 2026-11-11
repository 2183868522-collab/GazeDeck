// Independent tone-preset storage. This module never reads training profiles.
export const PRESET_STORAGE_KEY = 'gazedeck.soundcraft.tone-presets.v1';
export const MAX_PRESETS = 40;
export const TONE_EFFECTS = Object.freeze(['reverb', 'delay', 'chorus']);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => object(value) && Object.keys(value).length === expected.length
  && expected.every(key => Object.hasOwn(value, key));
const clone = value => structuredClone(value);
export class SoundCraftPresetStoreError extends Error {
  constructor(code, message) { super(message); this.name = 'SoundCraftPresetStoreError'; this.code = code; }
}
const fail = (code, message) => new SoundCraftPresetStoreError(code, message);

export function normalizeTone(value) {
  if (!keys(value, ['eq', 'effects']) || !keys(value.eq, ['enabled', 'low', 'mid', 'high'])
    || typeof value.eq.enabled !== 'boolean' || ['low', 'mid', 'high'].some(key => !finite(value.eq[key]) || value.eq[key] < -24 || value.eq[key] > 24)
    || !keys(value.effects, TONE_EFFECTS)
    || TONE_EFFECTS.some(effect => !keys(value.effects[effect], ['enabled', 'amount'])
      || typeof value.effects[effect].enabled !== 'boolean' || !finite(value.effects[effect].amount)
      || value.effects[effect].amount < 0 || value.effects[effect].amount > 1)) {
    throw fail('invalid_tone', '音色仅包含 Low/Mid/High 增益（-24 至 +24 dB）及三种效果的开关和强度（0–100%）');
  }
  return {eq: {...value.eq}, effects: Object.fromEntries(TONE_EFFECTS.map(effect => [effect, {...value.effects[effect]}]))};
}
function normalizeName(raw) {
  if (typeof raw !== 'string') throw fail('invalid_name', '请输入预设名称');
  const name = raw.trim().normalize('NFC');
  if (!name || name.length > 60 || /[\u0000-\u001f\u007f]/u.test(name)) throw fail('invalid_name', '预设名称需要 1–60 个字符，不能含控制字符');
  return name;
}
function normalizeTones(mode, tones) {
  const expected = mode === 'single' ? ['A'] : mode === 'pair' ? ['A', 'B'] : null;
  if (!expected || !keys(tones, expected)) throw fail('invalid_preset', '单轨预设需要 A 音色，双轨配对预设需要独立的 A、B 音色');
  return Object.fromEntries(expected.map(key => [key, normalizeTone(tones[key])]));
}
function normalizeRecord(record) {
  if (!keys(record, ['id', 'name', 'createdAt', 'mode', 'tones'])
    || typeof record.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/u.test(record.id)
    || typeof record.createdAt !== 'string' || record.createdAt.length !== 24
    || !Number.isFinite(Date.parse(record.createdAt)) || new Date(record.createdAt).toISOString() !== record.createdAt) {
    throw fail('invalid_preset', '预设记录格式或时间无效');
  }
  return {id: record.id, name: normalizeName(record.name), createdAt: record.createdAt,
    mode: record.mode, tones: normalizeTones(record.mode, record.tones)};
}
function decode(raw) {
  if (raw === null) return [];
  if (typeof raw !== 'string' || raw.length > 524288) throw fail('preset_storage_corrupt', '音色预设存储过大或无效，未覆盖原内容');
  try {
    const value = JSON.parse(raw);
    if (!keys(value, ['schemaVersion', 'presets']) || value.schemaVersion !== 1 || !Array.isArray(value.presets)
      || value.presets.length > MAX_PRESETS) throw new Error('schema');
    const records = value.presets.map(normalizeRecord);
    if (new Set(records.map(record => record.id)).size !== records.length
      || new Set(records.map(record => record.name.toLocaleLowerCase())).size !== records.length) throw new Error('duplicate');
    return records;
  } catch { throw fail('preset_storage_corrupt', '音色预设存储内容损坏或版本不兼容，未覆盖原内容；请先保留备份并检查'); }
}
export function presetTargets(preset, scope, binding) {
  const record = normalizeRecord(preset);
  if (!['A', 'B', 'AB'].includes(scope) || !object(binding)) throw fail('invalid_scope', '请选择 A、B 或 AB 目标音轨');
  if (record.mode === 'pair' && scope !== 'AB') throw fail('pair_requires_ab', '双轨配对预设只能应用到 AB，避免丢失另一条音轨的音色');
  const decks = scope === 'AB' ? ['A', 'B'] : [scope];
  const targets = decks.map(deck => ({track: binding[deck], tone: clone(record.tones[record.mode === 'pair' ? deck : 'A'])}));
  if (targets.some(target => !Number.isSafeInteger(target.track) || target.track <= 0)
    || new Set(targets.map(target => target.track)).size !== targets.length) throw fail('invalid_scope', '请先明确绑定不同的 A、B 真实音轨');
  return targets;
}
export class SoundCraftPresetStore {
  constructor({storage, idFactory = () => globalThis.crypto.randomUUID(), now = () => new Date()} = {}) {
    this.storage = storage; this.idFactory = idFactory; this.now = now;
    this._records = []; this._raw = null; this._loaded = false; this._blocked = false;
  }
  _storage() {
    try {
      const storage = this.storage ?? globalThis.localStorage;
      if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') throw new Error('unavailable');
      return storage;
    } catch { throw fail('preset_storage_unavailable', '浏览器音色预设存储不可用，未保存'); }
  }
  load() {
    try {
      const raw = this._storage().getItem(PRESET_STORAGE_KEY), records = decode(raw);
      this._records = records; this._raw = raw; this._loaded = true; this._blocked = false;
      return this.list();
    } catch (error) {
      this._blocked = true;
      if (error instanceof SoundCraftPresetStoreError) throw error;
      throw fail('preset_storage_unavailable', '无法读取浏览器音色预设存储，未覆盖原内容');
    }
  }
  list() { return clone(this._records); }
  save({name, mode, tones} = {}) {
    if (this._blocked) throw fail('preset_storage_blocked', '音色预设存储尚未正常加载，未覆盖原内容；请先重新读取');
    if (!this._loaded) this.load();
    name = normalizeName(name); tones = normalizeTones(mode, tones);
    if (this._records.length >= MAX_PRESETS) throw fail('preset_limit', `最多保存 ${MAX_PRESETS} 个音色预设，本次未保存`);
    if (this._records.some(record => record.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw fail('duplicate_name', '此名称已存在，请输入新名称；不会覆盖已有预设');
    let record;
    try { record = normalizeRecord({id: this.idFactory(), name, mode, tones, createdAt: this.now().toISOString()}); }
    catch (error) { if (error instanceof SoundCraftPresetStoreError) throw error; throw fail('invalid_preset', '无法生成有效预设记录，未保存'); }
    if (this._records.some(item => item.id === record.id)) throw fail('duplicate_id', '预设标识重复，未保存');
    const records = [...this._records, record], raw = JSON.stringify({schemaVersion: 1, presets: records});
    try {
      const storage = this._storage();
      if (storage.getItem(PRESET_STORAGE_KEY) !== this._raw) throw fail('preset_storage_changed', '音色预设已在其他页面变化，请重新读取；未覆盖其他修改');
      storage.setItem(PRESET_STORAGE_KEY, raw);
    } catch (error) {
      if (error instanceof SoundCraftPresetStoreError) throw error;
      throw fail('preset_save_failed', '浏览器空间不足或保存被拒绝，本次音色预设未保存；已有预设保持原样');
    }
    this._records = records; this._raw = raw;
    return clone(record);
  }
}

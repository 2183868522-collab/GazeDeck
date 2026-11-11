import { DECK_GESTURES, GazeDeckFlow } from './gazedeck-flow.js';

const DECKS = ['A', 'B'];
const EFFECTS = { reverb: '混响', delay: '延迟', chorus: '合唱' };
const BANDS = { low: 'Low', mid: 'Mid', high: 'High' };
const TITLES = { volume: '音量', bpm: '速度调节', ...BANDS, seek: '快进 / 快退', track: '选择曲目',
  presetSelect: '选择音色预设', presetSave: '保存音色预设', presetApply: '应用音色预设',
  tempoReset: '恢复原速', tempoMatch: '匹配 BPM' };
const PAGE_NAMES = { boot: '1 · 启动界面', setup: '2 · 设备连接与校准', settings: '启动设置',
  home: '3 · 主界面', tracks: '4 · 曲目与播放管理', presets: '5 · 音色预设',
  sound: '6 · 声音与效果', eq: '6A · EQ', effects: '6B · Effects', speed: '7 · 速度控制' };
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const validBpm = bpm => Number.isFinite(bpm) && bpm >= 60 && bpm <= 200;
const fieldsForTone = ['low', 'mid', 'high', ...Object.keys(EFFECTS).flatMap(effect =>
  [`effects.${effect}.enabled`, `effects.${effect}.amount`])];

function valueOf(deck, field) {
  const [, effect, key] = field.split('.');
  return effect ? deck.effects[effect][key] : deck[field];
}

function writeValue(deck, field, value) {
  const [, effect, key] = field.split('.');
  if (effect) deck.effects[effect][key] = value;
  else deck[field] = value;
}

// Session-only operations for the browser demonstration. The two-ring menu is
// shared with the SoundCraft UI and supplies the page and scope through navigate/setScope.
export class GazeDeckAdvancedDemo extends GazeDeckFlow {
  constructor() {
    super();
    this.state.scope = 'A';
    this.currentEffect = 'reverb';
    this.presets = [];
    this.selectedPresetIds = {};
    this.nextPresetId = 1;
    this.nextInstance = 1;
    for (const deck of Object.values(this.state.decks)) {
      deck.instance = this.nextInstance++;
      deck.playRevision = 0;
      deck.effects = Object.fromEntries(Object.keys(EFFECTS).map(effect => [effect, { enabled: false, amount: 40 }]));
    }
  }

  get targets() { return this.state.scope === 'AB' ? DECKS.slice() : [this.state.scope]; }

  get selectedPreset() {
    return this.presets.find(preset => preset.id === this.selectedPresetIds[this.state.scope] && this.compatible(preset)) || null;
  }

  get presetDiffers() {
    const preset = this.selectedPreset;
    return Boolean(preset && this.targets.some(id => fieldsForTone.some(field =>
      valueOf(this.state.decks[id], field) !== valueOf(preset.tones[preset.mode === 'pair' ? id : 'A'], field))));
  }

  compatible(preset, scope = this.state.scope) { return preset.mode === (scope === 'AB' ? 'pair' : 'single'); }

  setScope(scope) {
    if (!['A', 'B', 'AB'].includes(scope) || this.state.popup) return false;
    this.state.scope = scope;
    if (scope !== 'AB') this.state.deck = scope;
    return true;
  }

  navigate(page) {
    if (!Object.hasOwn(PAGE_NAMES, page) || this.state.popup || this.state.observing) return false;
    this.state.page = page;
    return true;
  }

  changePage(page) { return this.navigate(page); }
  changeDeck(deck) { return this.setScope(deck); }

  setTracks(tracks) {
    this.cancelPopup();
    super.setTracks(tracks);
    for (const deck of Object.values(this.state.decks)) {
      if (!validBpm(deck.bpm)) deck.bpm = 120;
      deck.instance = this.nextInstance++;
      deck.playRevision++;
    }
  }

  // Reset only the browser's two audio decks. Keep the imported library,
  // saved presets, current page and training profile intact.
  resetAudio() {
    this.cancelPopup();
    this.state.observing = false;
    this.history = [];
    this.selectedPresetIds = {};
    for (const id of DECKS) {
      const deck = this.state.decks[id];
      Object.assign(deck, {
        track: 0, playing: false, position: 0, volume: 70,
        bpm: validBpm(this.tracks[0]?.bpm) ? this.tracks[0].bpm : 120,
        low: 0, mid: 0, high: 0,
        effect: 40, effectOn: false, effectType: 0,
        effects: Object.fromEntries(Object.keys(EFFECTS).map(effect =>
          [effect, { enabled: false, amount: 40 }])),
        instance: this.nextInstance++, playRevision: deck.playRevision + 1,
      });
    }
    return this.result('网页演示 A/B 音频已恢复初始值并停在开头');
  }

  setTrackBpm(index, bpm) {
    const track = this.tracks[index];
    if (!track || !validBpm(bpm) || this.state.observing || this.state.popup) return false;
    const previous = track.bpm;
    track.bpm = bpm;
    track.bpmKnown = true;
    for (const id of DECKS) {
      const deck = this.state.decks[id];
      if (deck.track !== index) continue;
      const ratio = validBpm(previous) ? deck.bpm / previous : 1;
      deck.bpm = clamp(bpm * ratio, ...this.bpmBounds(id));
    }
    // BPM undo entries depend on the original tempo of the affected loaded track.
    this.history = this.history.filter(change => !change.rows?.some(row =>
      row.field === 'bpm' && this.state.decks[row.deck].track === index));
    return true;
  }

  result(message, executed = true, extra = {}, from = PAGE_NAMES[this.state.page]) {
    return { message, executed, from, to: PAGE_NAMES[this.state.page], ...extra };
  }

  originalBpm(id) {
    const track = this.tracks[this.state.decks[id].track];
    return track && track.bpmKnown !== false && validBpm(track.bpm) ? track.bpm : null;
  }

  bpmBounds(id) {
    const original = this.originalBpm(id);
    return [Math.max(60, original * 0.5), Math.min(200, original * 2)];
  }

  seekBounds(targets) {
    const bounds = targets.map(id => {
      const deck = this.state.decks[id], track = this.tracks[deck.track];
      return track && track.durationKnown !== false && Number.isFinite(track.duration) && track.duration > 0
        ? [-deck.position, Math.max(0, track.duration - deck.position)] : null;
    });
    return bounds.every(Boolean) ? [Math.max(...bounds.map(bound => bound[0])), Math.min(...bounds.map(bound => bound[1]))] : null;
  }

  lockTargets(targets = this.targets) {
    return targets.map(deck => ({ deck, instance: this.state.decks[deck].instance }));
  }

  targetsStillLoaded(locks) {
    return locks.every(({ deck, instance }) => this.state.decks[deck].instance === instance);
  }

  parameterRows(targets, field) {
    return targets.map(deck => {
      const before = valueOf(this.state.decks[deck], field);
      return { deck, field, before, after: before };
    });
  }

  commitParameters(title, rows, locks = []) {
    const changed = rows.filter(row => row.before !== row.after);
    for (const row of changed) writeValue(this.state.decks[row.deck], row.field, row.after);
    if (changed.length) this.checkpoint({ type: 'parameters', title, rows: changed, locks });
    return changed.length > 0;
  }

  rangePopup(popup) {
    if (popup.kind === 'track') {
      const deck = this.state.decks[popup.deck];
      if (popup.targets.length !== 1) return '请先选择单独的 Deck A 或 Deck B 再装载曲目';
      if (deck.playing) return '请先暂停所选音轨再装载曲目';
      if (!this.tracks.length) return '曲库为空，请先添加曲目';
      return Object.assign(popup, { min: 1, max: this.tracks.length * 20, value: deck.track * 20 + 10, step: 20 });
    }
    if (popup.kind === 'seek') {
      const bounds = this.seekBounds(popup.targets);
      if (!bounds) return '所选音轨的时长尚未读取，暂不能定位';
      return Object.assign(popup, { min: bounds[0], max: bounds[1], value: 0, step: 10, unit: ' 秒' });
    }

    const kind = popup.kind;
    const field = kind === 'effect' ? `effects.${this.currentEffect}.amount` : kind;
    popup.params = this.parameterRows(popup.targets, field);
    popup.unit = kind === 'bpm' ? ' BPM' : kind === 'volume' || kind === 'effect' ? '%' : ' dB';
    if (kind === 'effect') popup.effect = this.currentEffect;
    if (kind === 'bpm' && popup.targets.some(id => !this.originalBpm(id))) return '请先填写所选曲目的原始 BPM';
    const bounds = popup.params.map(row => kind === 'bpm' ? this.bpmBounds(row.deck)
      : popup.unit === '%' ? [0, 100] : [-24, 24]);
    if (popup.targets.length === 1) {
      return Object.assign(popup, { min: bounds[0][0], max: bounds[0][1], value: popup.params[0].before,
        step: popup.unit === '%' ? 5 : 1 });
    }
    if (kind === 'bpm') {
      return Object.assign(popup, { min: Math.max(...bounds.map((bound, i) => bound[0] / popup.params[i].before)),
        max: Math.min(...bounds.map((bound, i) => bound[1] / popup.params[i].before)), value: 1, step: 0.02,
        unit: '×', relative: 'ratio' });
    }
    return Object.assign(popup, { min: Math.max(...bounds.map((bound, i) => bound[0] - popup.params[i].before)),
      max: Math.min(...bounds.map((bound, i) => bound[1] - popup.params[i].before)), value: 0,
      step: popup.unit === '%' ? 5 : 1, relative: 'delta' });
  }

  captureTone(id) {
    const deck = this.state.decks[id];
    return { low: deck.low, mid: deck.mid, high: deck.high,
      effects: Object.fromEntries(Object.entries(deck.effects).map(([effect, value]) => [effect, { ...value }])) };
  }

  matchTarget(deck, reference) {
    const bpm = this.state.decks[reference].bpm;
    if (!this.originalBpm(deck) || !this.originalBpm(reference) || !validBpm(bpm)) return null;
    const [min, max] = this.bpmBounds(deck);
    return bpm >= min && bpm <= max ? bpm : null;
  }

  openPopup(kind) {
    const state = this.state;
    const targets = this.targets;
    const popup = { kind, scope: state.scope, targets, deck: targets[0], locks: this.lockTargets(targets),
      title: TITLES[kind] || `${EFFECTS[this.currentEffect]}强度`, mode: 'range', value: 0, min: 0, max: 0, step: 1, unit: '' };
    if (state.popup || state.observing) return this.result('请先结束当前操作', false);
    if (kind === 'presetSelect') {
      const options = this.presets.filter(preset => this.compatible(preset)).map(({ id, name }) => ({ id, name }));
      const index = options.findIndex(option => option.id === this.selectedPreset?.id);
      Object.assign(popup, { mode: 'list', options, min: options.length ? 1 : 0, max: options.length,
        value: options.length ? Math.max(1, index + 1) : 0 });
    } else if (kind === 'presetSave') {
      let number = this.nextPresetId;
      while (this.presets.some(preset => preset.name === `演示预设 ${number}`)) number++;
      Object.assign(popup, { mode: 'confirm', name: `演示预设 ${number}`,
        tones: Object.fromEntries(targets.map(id => [targets.length === 1 ? 'A' : id, this.captureTone(id)])) });
    } else if (kind === 'presetApply') {
      const selected = this.selectedPreset;
      if (!selected) return this.result('请先选择与当前音轨范围兼容的预设', false);
      Object.assign(popup, { mode: 'confirm', presetId: selected.id });
    } else if (kind === 'tempoReset') {
      if (targets.some(id => !this.originalBpm(id))) return this.result('请先填写所选曲目的原始 BPM', false);
      Object.assign(popup, { mode: 'confirm', targetBpms: Object.fromEntries(targets.map(id => [id, this.originalBpm(id)])) });
    } else if (kind === 'tempoMatch') {
      if (targets.length > 1) return this.result('BPM 匹配需要单独选择 Deck A 或 Deck B', false);
      const reference = popup.deck === 'A' ? 'B' : 'A';
      const bpm = this.matchTarget(popup.deck, reference);
      if (bpm === null) return this.result('参考 BPM 不可用或超出目标范围，请先检查两轨的原始 BPM', false);
      Object.assign(popup, { mode: 'confirm', reference, referenceLock: this.lockTargets([reference]),
        targetBpms: { [popup.deck]: bpm } });
    } else {
      if (!['track', 'seek', 'volume', 'bpm', 'low', 'mid', 'high', 'effect'].includes(kind)) return this.result('此控制尚未分配', false);
      const range = this.rangePopup(popup);
      if (typeof range === 'string') return this.result(range, false);
    }
    popup.initialValue = popup.value;
    state.popup = popup;
    return this.result(`已打开 Deck ${popup.scope} ${popup.title}`);
  }

  open(kind) { return this.openPopup(kind).executed; }

  setPopupName(name) {
    if (this.state.popup?.kind !== 'presetSave' || this.state.observing || typeof name !== 'string') return false;
    this.state.popup.name = name;
    return true;
  }

  setPopupValue(value) {
    const popup = this.state.popup;
    if (!popup || popup.mode === 'confirm' || this.state.observing || !Number.isFinite(value)
        || !this.popupStillOwned(popup)) return false;
    if (popup.kind === 'track' || popup.mode === 'list') value = Math.round(value);
    popup.value = clamp(value, popup.min, popup.max);
    for (const row of popup.params || []) {
      row.after = popup.relative === 'ratio' ? row.before * popup.value
        : popup.relative === 'delta' ? row.before + popup.value : popup.value;
      writeValue(this.state.decks[row.deck], row.field, row.after);
    }
    return true;
  }

  popupStillOwned(popup) {
    return this.targetsStillLoaded(popup.locks) && !popup.params?.some(row =>
      valueOf(this.state.decks[row.deck], row.field) !== row.after);
  }

  cancelPopup() {
    const popup = this.state.popup;
    if (!popup) return false;
    for (const row of popup.params || []) {
      const lock = popup.locks.find(target => target.deck === row.deck);
      const deck = this.state.decks[row.deck];
      if (deck.instance === lock.instance && valueOf(deck, row.field) === row.after) writeValue(deck, row.field, row.before);
    }
    this.state.popup = null;
    return true;
  }

  popupReadout() {
    const popup = this.state.popup;
    const readout = { values: [], summary: '', candidate: null, canConfirm: true, reason: '' };
    if (!popup) return { ...readout, canConfirm: false };
    const reject = reason => ({ ...readout, canConfirm: false, reason });
    if (!this.popupStillOwned(popup)) return reject('目标曲目或参数已变化，请关闭并重新打开');
    if (popup.params) {
      readout.values = popup.params.map(({ deck, before, after }) => ({ deck, before, after,
        unit: popup.kind === 'bpm' ? ' BPM' : popup.unit }));
    } else if (popup.kind === 'track') {
      readout.candidate = this.tracks[this.trackIndex(popup.value)] || null;
      if (!readout.candidate || this.state.decks[popup.deck].playing) return reject('需暂停音轨并选择有效曲目');
    } else if (popup.kind === 'presetSelect' || popup.kind === 'presetApply') {
      const id = popup.kind === 'presetSelect' ? popup.options[popup.value - 1]?.id : popup.presetId;
      readout.candidate = this.presets.find(preset => preset.id === id && this.compatible(preset, popup.scope)) || null;
      if (!readout.candidate) return reject(popup.kind === 'presetSelect' && !popup.options.length ? '暂无兼容预设' : '候选预设已变化，请重新打开');
      if (popup.kind === 'presetApply') {
        for (const deck of popup.targets) {
          const tone = readout.candidate.tones[readout.candidate.mode === 'pair' ? deck : 'A'];
          for (const field of fieldsForTone) {
            const before = valueOf(this.state.decks[deck], field), after = valueOf(tone, field);
            if (before === after) continue;
            const [, effect, key] = field.split('.');
            readout.values.push({ deck, before, after, label: BANDS[field] || `${EFFECTS[effect]}${key === 'enabled' ? '开关' : '强度'}`,
              unit: BANDS[field] ? ' dB' : key === 'amount' ? '%' : '' });
          }
        }
        readout.summary = readout.values.length ? `确认应用「${readout.candidate.name}」` : '当前音色已与预设一致';
      }
    } else if (popup.kind === 'presetSave') {
      if (!popup.name.trim()) return reject('请输入预设名称');
      if (popup.name.trim().length > 60) return reject('预设名称最多 60 个字符');
      if (this.presets.some(preset => preset.name === popup.name.trim())) return reject('名称已存在，请修改名称');
      readout.summary = '将保存三段 EQ 和混响、延迟、合唱的开关及强度';
    } else if (popup.targetBpms) {
      if (popup.reference && this.matchTarget(popup.deck, popup.reference) === null) return reject('参考音轨的 BPM 已不可用');
      readout.values = popup.targets.map(deck => ({ deck, before: this.state.decks[deck].bpm,
        after: popup.targetBpms[deck], unit: ' BPM' }));
      if (popup.reference) readout.summary = `参考 Deck ${popup.reference} 当前速度`;
    }
    return readout;
  }

  loadTrack(id, index) {
    const deck = this.state.decks[id];
    const bpm = this.tracks[index].bpm;
    Object.assign(deck, { track: index, position: 0, playing: false,
      bpm: validBpm(bpm) ? bpm : 120, instance: this.nextInstance++ });
    deck.playRevision++;
  }

  playbackChange(rows, history, restoreHistory) {
    const applied = rows.map(row => {
      const deck = this.state.decks[row.deck];
      deck.playing = row.after;
      return { ...row, instance: deck.instance, revision: ++deck.playRevision };
    });
    return { playDecks: applied.map(row => row.deck), playbackTransaction: { rows: applied, history, restoreHistory } };
  }

  rollbackPlayback(result) {
    const transaction = result.playbackTransaction;
    if (!transaction || !transaction.rows.every(row => {
      const deck = this.state.decks[row.deck];
      return deck.instance === row.instance && deck.playRevision === row.revision;
    })) return false;
    for (const row of transaction.rows) {
      const deck = this.state.decks[row.deck];
      deck.playing = row.before;
      deck.playRevision++;
    }
    for (const { deck, position } of transaction.replay || []) {
      const track = this.state.decks[deck];
      track.position = Math.max(position, track.position);
    }
    if (transaction.history) this.history = this.history.filter(entry => entry !== transaction.history);
    if (transaction.restoreHistory) this.checkpoint(transaction.restoreHistory);
    return true;
  }

  togglePlayback() {
    const targets = this.targets;
    if (targets.some(id => !this.tracks[this.state.decks[id].track])) return this.result('所选音轨尚未装载曲目', false);
    const after = !targets.every(id => this.state.decks[id].playing);
    const rows = targets.map(deck => ({ deck, before: this.state.decks[deck].playing, after }));
    const history = { type: 'playing', rows, locks: this.lockTargets(targets) };
    this.checkpoint(history);
    const replay = after ? targets.filter(id => {
      const deck = this.state.decks[id], track = this.tracks[deck.track];
      return track.durationKnown !== false && deck.position >= track.duration;
    }) : [];
    const result = this.playbackChange(rows, history);
    result.playbackTransaction.replay = replay.map(deck => ({ deck, position: this.state.decks[deck].position }));
    for (const id of replay) this.state.decks[id].position = 0;
    return this.result(`Deck ${this.state.scope} 已${after ? '播放' : '暂停'}`, true,
      { ...result, seekDecks: replay });
  }

  confirmPopup() {
    const popup = this.state.popup;
    const readout = this.popupReadout();
    if (!readout.canConfirm) return this.result(readout.reason, false);
    const scope = popup.scope;
    let message = `Deck ${scope} 已确认${popup.title}`;
    let extra = {};
    if (popup.params) {
      this.commitParameters(popup.title, popup.params, popup.kind === 'bpm' ? popup.locks : []);
    } else if (popup.kind === 'track') {
      const index = this.trackIndex(popup.value), deck = this.state.decks[popup.deck];
      if (index !== deck.track) {
        const before = deck.track;
        this.loadTrack(popup.deck, index);
        this.checkpoint({ type: 'track', deck: popup.deck, before, locks: this.lockTargets(popup.targets) });
        message = `Deck ${scope} 已装载「${this.tracks[index].name}」，从起点保持暂停`;
      } else message = `Deck ${scope} 已保留当前曲目`;
    } else if (popup.kind === 'seek') {
      const bounds = this.seekBounds(popup.targets);
      if (!bounds) return this.result('音轨时长已变化，暂不能定位', false);
      const delta = clamp(popup.value, ...bounds);
      if (delta !== 0) {
        for (const id of popup.targets) this.state.decks[id].position += delta;
        this.checkpoint({ type: 'seek', title: popup.title, targets: popup.targets, locks: popup.locks, delta });
        extra = { seekDecks: popup.targets };
      }
      message = `Deck ${scope} ${delta ? `已相对定位 ${delta.toFixed(1)} 秒` : '保持当前播放位置'}`;
    } else if (popup.kind === 'presetSelect') {
      this.selectedPresetIds[scope] = readout.candidate.id;
      message = `Deck ${scope} 已选择「${readout.candidate.name}」`;
    } else if (popup.kind === 'presetSave') {
      const preset = { id: this.nextPresetId++, name: popup.name.trim(),
        mode: popup.targets.length === 2 ? 'pair' : 'single', tones: popup.tones };
      this.presets.push(preset);
      this.selectedPresetIds[scope] = preset.id;
      message = `已保存本次会话预设「${preset.name}」`;
    } else if (popup.kind === 'presetApply') {
      const rows = popup.targets.flatMap(deck => fieldsForTone.map(field => ({ deck, field,
        before: valueOf(this.state.decks[deck], field),
        after: valueOf(readout.candidate.tones[readout.candidate.mode === 'pair' ? deck : 'A'], field) })));
      this.commitParameters(popup.title, rows);
      message = `Deck ${scope} 已应用「${readout.candidate.name}」的音色设置`;
    } else if (popup.targetBpms) {
      if (popup.reference) {
        const fresh = this.matchTarget(popup.deck, popup.reference);
        if (fresh === null) return this.result('参考音轨的 BPM 已不可用', false);
        if (!this.targetsStillLoaded(popup.referenceLock) || fresh !== popup.targetBpms[popup.deck]) {
          popup.referenceLock = this.lockTargets([popup.reference]);
          popup.targetBpms[popup.deck] = fresh;
          return this.result('参考音轨或 BPM 已变化，已刷新目标值，请重新确认', false);
        }
      }
      const rows = this.parameterRows(popup.targets, 'bpm').map(row => ({ ...row, after: popup.targetBpms[row.deck] }));
      this.commitParameters(popup.title, rows, popup.locks);
    }
    this.state.popup = null;
    return this.result(message, true, extra);
  }

  undo() {
    const entry = this.history.at(-1);
    if (!entry) return this.result('没有可撤回的参数操作', false);
    if (!this.targetsStillLoaded(entry.locks || [])) {
      this.history.pop();
      return this.result('该记录关联的曲目已变化，已跳过整条撤回记录', false);
    }
    if (entry.type === 'track' && this.state.decks[entry.deck].playing) return this.result('请先暂停对应音轨再撤回换曲', false);
    this.history.pop();
    if (entry.type === 'track') {
      this.loadTrack(entry.deck, entry.before);
      return this.result(`Deck ${entry.deck} 已恢复原曲目并从起点保持暂停`);
    }
    if (entry.type === 'playing') {
      const rows = entry.rows.map(row => ({ deck: row.deck, before: this.state.decks[row.deck].playing, after: row.before }));
      return this.result(`已恢复 Deck ${rows.map(row => row.deck).join('')} 的播放状态`, true,
        this.playbackChange(rows, null, entry));
    }
    if (entry.type === 'seek') {
      const bounds = this.seekBounds(entry.targets);
      if (!bounds) return this.result('音轨时长已不可用，未撤回定位', false);
      const delta = clamp(-entry.delta, ...bounds);
      for (const id of entry.targets) this.state.decks[id].position += delta;
      return this.result(`已抵消 Deck ${entry.targets.join('')} 的定位量，保留期间经过的播放时间`, true,
        { seekDecks: delta ? entry.targets : [] });
    }
    if (entry.type !== 'parameters') return this.result('该记录已不可撤回', false);
    for (const row of entry.rows) writeValue(this.state.decks[row.deck], row.field, row.before);
    return this.result(`已恢复 Deck ${[...new Set(entry.rows.map(row => row.deck))].join('')} 的${entry.title}`);
  }

  dispatch(gesture) {
    const state = this.state;
    if (gesture === '长眨') {
      state.observing = !state.observing;
      return this.result(state.observing ? '进入观察模式，音乐继续播放' : '退出观察模式，已恢复控制');
    }
    if (state.observing) return this.result('观察模式中，仅长眨可恢复控制', false);
    const popup = state.popup;
    if (popup) {
      if (gesture === '双眨' || (popup.mode === 'confirm' && gesture === '上看')) {
        this.cancelPopup();
        return this.result(`已取消 Deck ${popup.scope} ${popup.title}`);
      }
      if (gesture === '下看') return this.confirmPopup();
      if (popup.mode !== 'confirm' && ['上看', '左看', '右看'].includes(gesture)) {
        const value = gesture === '上看' ? popup.initialValue : popup.value + (gesture === '左看' ? -popup.step : popup.step);
        if (!this.setPopupValue(value)) return this.result('目标曲目或参数已变化，请重新打开弹窗', false);
        return this.result(gesture === '上看' ? '已恢复打开时的值，弹窗保持打开' : `已调整${popup.title}`);
      }
      return this.result('此动作在当前弹窗中未分配', false);
    }
    if (gesture === '双眨') return this.undo();
    if (!DECK_GESTURES.slice(0, 4).includes(gesture)) return this.result('此动作未分配控制', false);
    const navigation = { boot: { 左看: 'settings', 右看: 'setup' }, settings: { 上看: 'boot' },
      tracks: { 上看: 'home' }, presets: { 上看: 'home' }, sound: { 上看: 'home', 左看: 'eq', 下看: 'effects' },
      speed: { 上看: 'home' }, eq: { 上看: 'sound' }, effects: { 上看: 'sound' } };
    const from = PAGE_NAMES[state.page];
    const next = navigation[state.page]?.[gesture];
    if (next && this.navigate(next)) return this.result(`已进入${PAGE_NAMES[next]}`, true, {}, from);
    if (state.page === 'tracks' && gesture === '左看') return this.togglePlayback();
    if (state.page === 'effects' && gesture === '右看') {
      const effects = Object.keys(EFFECTS);
      this.currentEffect = effects[(effects.indexOf(this.currentEffect) + 1) % effects.length];
      return this.result(`当前编辑${EFFECTS[this.currentEffect]}`);
    }
    if (state.page === 'effects' && gesture === '下看') {
      const rows = this.parameterRows(this.targets, `effects.${this.currentEffect}.enabled`);
      const after = !rows.every(row => row.before);
      this.commitParameters(`${EFFECTS[this.currentEffect]}开关`, rows.map(row => ({ ...row, after })));
      return this.result(`Deck ${state.scope} 已${after ? '开启' : '关闭'}${EFFECTS[this.currentEffect]}`);
    }
    const popupKinds = { tracks: { 下看: 'track', 右看: 'seek' },
      presets: { 下看: 'presetSelect', 左看: 'presetSave', 右看: 'presetApply' }, sound: { 右看: 'volume' },
      speed: { 下看: 'tempoMatch', 左看: 'tempoReset', 右看: 'bpm' },
      eq: { 下看: 'low', 左看: 'mid', 右看: 'high' }, effects: { 左看: 'effect' } };
    const kind = popupKinds[state.page]?.[gesture];
    return kind ? this.openPopup(kind) : this.result('此页面该方向暂不分配功能', false);
  }
}

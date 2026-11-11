// Independent, session-only UI state. Never reads or writes training profiles.
export const DECK_GESTURES = ['上看', '下看', '左看', '右看', '长眨', '双眨'];
export const DECK_PAGES = {
  boot: '1 · 启动界面', setup: '2 · 设备连接与校准', home: '3 · 主界面',
  tracks: '4 · 音轨管理', playback: '5 · 播放控制', sound: '6 · 声音与效果',
  speed: '7 · 速度控制', eq: '6A · EQ', effects: '6B · Effects', settings: '启动设置',
  presets: '音色预设',
};
export const DECK_CONTROLS = {
  boot: ['暂不分配', '暂不分配', '进入设置', '启动系统'],
  setup: ['由助手完成校准', '由助手完成校准', '暂不分配', '暂不分配'],
  settings: ['返回启动界面', '暂不分配', '暂不分配', '暂不分配'],
  home: ['进入音轨管理', '进入播放控制', '进入声音与效果', '进入速度控制'],
  tracks: ['返回主界面', '唤出曲目选择弹窗', '选择 Deck A', '选择 Deck B'],
  playback: ['返回主界面', '切换 Deck A / B', '播放 / 暂停', '快进 / 快退弹窗'],
  sound: ['返回主界面', '进入 Effects', '进入 EQ', '音量滑块弹窗'],
  speed: ['返回主界面', '切换 Deck A / B', 'Tempo Reset', 'BPM 滑块弹窗'],
  eq: ['返回声音与效果', 'Low 滑块弹窗', 'Mid 滑块弹窗', 'High 滑块弹窗'],
  effects: ['返回声音与效果', '效果器开启 / 关闭', '效果强度滑块弹窗', '切换：混响 → 延迟 → 合唱'],
  presets: ['返回主界面', '选择预设（不立即应用）', '保存当前音色为新预设', '预览并确认应用预设'],
};
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const makeDeck = () => ({ track: 0, playing: false, position: 0, volume: 70, bpm: 120,
  low: 0, mid: 0, high: 0, effect: 40, effectOn: false, effectType: 0 });

export class GazeDeckFlow {
  constructor() {
    this.state = { page: 'boot', deck: 'A', observing: false, demo: false, popup: null,
      decks: { A: makeDeck(), B: makeDeck() } };
    this.history = [];
    // Placeholder tracks model short loop material. Imported files replace this
    // duration with their measured audio length before seeking is enabled.
    this.tracks = Array.from({ length: 5 }, (_, i) => ({ name: `演示曲目 ${i + 1}`, duration: 15, bpm: 120, key: '—', demo: true }));
  }
  get deck() { return this.state.decks[this.state.deck]; }
  checkpoint(change) { this.history.push(change); if (this.history.length > 60) this.history.shift(); }
  changePage(page) {
    this.checkpoint({ type: 'page', before: this.state.page }); this.state.page = page;
  }
  changeDeck(deck) {
    if (deck === this.state.deck) return;
    this.checkpoint({ type: 'deck', before: this.state.deck }); this.state.deck = deck;
  }
  changeParameter(deck, key, value) {
    const d = this.state.decks[deck];
    if (d[key] === value) return;
    this.checkpoint({ type: 'parameter', deck, key, before: d[key] }); d[key] = value;
  }
  undo() {
    const change = this.history.pop();
    if (!change) return { executed: false, message: '没有可撤回的操作' };
    if (change.type === 'page') this.state.page = change.before;
    if (change.type === 'deck') this.state.deck = change.before;
    const d = this.state.decks[change.deck];
    if (change.type === 'parameter') d[change.key] = change.before;
    if (change.type === 'seek') {
      if (d.track !== change.track) return { executed: false, message: '曲目已变化，不恢复旧曲目的进度' };
      // Reverse only the explicit jump, not the time played since that jump.
      d.position = clamp(d.position - change.delta, 0, this.tracks[d.track]?.duration || 240);
      return { executed: true, message: '已撤回进度跳转，保留其后正常播放经过的时间', seekDeck: change.deck };
    }
    if (change.type === 'track') {
      // Reloading a song is explicit; never resurrect a historical playback timestamp/state.
      Object.assign(d, { track: change.before, position: 0, playing: false, bpm: this.tracks[change.before]?.bpm || 120 });
    }
    return { executed: true, message: change.type === 'page' ? '已撤回页面切换，播放保持不变'
      : change.type === 'parameter' ? `已恢复 Deck ${change.deck} 的 ${change.key}，其余参数与播放进度不变`
      : change.type === 'track' ? '已恢复原曲目并从起点待播放，不恢复历史播放时间' : '已撤回目标 Deck 切换' };
  }
  completeSetup(demo = false) {
    if (this.state.page !== 'setup' || this.state.observing) return false;
    this.changePage('home'); this.state.demo = demo; return true;
  }
  setTracks(tracks) {
    this.tracks = tracks.slice(0, 5); this.state.popup = null; this.history = [];
    for (const d of Object.values(this.state.decks)) Object.assign(d, { track: 0, playing: false, position: 0, bpm: this.tracks[0]?.bpm || 120 });
  }
  open(kind) {
    const d = this.deck, track = this.tracks[d.track];
    const ranges = {
      track: ['选择曲目', 1, this.tracks.length * 20, d.track * 20 + 10, 20, ''],
      seek: ['快进 / 快退', 0, track?.duration || 240, d.position, 10, '秒'],
      volume: ['音量', 0, 100, d.volume, 5, '%'], bpm: ['BPM', 60, 200, d.bpm, 1, ' BPM'],
      low: ['Low', -12, 12, d.low, 1, ' dB'], mid: ['Mid', -12, 12, d.mid, 1, ' dB'], high: ['High', -12, 12, d.high, 1, ' dB'],
      effect: ['效果强度', 0, 100, d.effect, 5, '%'],
    };
    if (kind === 'track' && !this.tracks.length) return false;
    const [title, min, max, value, step, unit] = ranges[kind];
    const initialValue = clamp(value, min, max);
    this.state.popup = { kind, title, min, max, value: initialValue, initialValue, deck: this.state.deck, step, unit }; return true;
  }
  setPopupValue(value) {
    const p = this.state.popup;
    if (p && !this.state.observing && Number.isFinite(value)) p.value = clamp(value, p.min, p.max);
  }
  trackIndex(value) { return clamp(Math.ceil(value / 20) - 1, 0, this.tracks.length - 1); }
  dispatch(gesture) {
    const s = this.state, from = DECK_PAGES[s.page];
    const result = (message, executed = true) => ({ message, executed, from, to: DECK_PAGES[this.state.page] });
    if (gesture === '长眨') { s.observing = !s.observing; return result(s.observing ? '进入观察模式：冻结导航和滑块，音轨可继续播放' : '退出观察模式：恢复控制'); }
    if (s.observing) return result('观察模式中，仅长眨可恢复控制', false);
    if (gesture === '双眨') {
      if (s.popup) { s.popup = null; return result('撤回弹窗操作，未保存的数值已丢弃'); }
      return { ...result(''), ...this.undo(), to: DECK_PAGES[this.state.page] };
    }
    if (!DECK_GESTURES.slice(0, 4).includes(gesture)) return result('此动作未分配控制', false);
    const d = this.deck;
    if (s.popup) {
      const p = s.popup;
      if (gesture === '上看') {
        this.setPopupValue(p.initialValue);
        return result(`已恢复 ${p.title} 打开时的原始数值，弹窗保持打开`);
      }
      if (gesture === '下看') {
        const target = s.decks[p.deck]; let seekDeck;
        if (p.kind === 'track') {
          const index = this.trackIndex(p.value);
          if (index !== target.track) {
            this.checkpoint({ type: 'track', deck: p.deck, before: target.track });
            Object.assign(target, { track: index, position: 0, playing: false, bpm: this.tracks[index]?.bpm || 120 });
          }
        } else if (p.kind === 'seek') {
          // Closing or restoring an untouched seek slider must not rewind a playing song.
          if (p.value !== p.initialValue && p.value !== target.position) {
            this.checkpoint({ type: 'seek', deck: p.deck, track: target.track, delta: p.value - target.position });
            target.position = p.value; seekDeck = p.deck;
          }
        } else this.changeParameter(p.deck, p.kind, p.value);
        s.popup = null; return { ...result(`已保留 ${p.title} 当前数值并关闭弹窗`), seekDeck };
      }
      if (gesture === '左看' || gesture === '右看') { this.setPopupValue(p.value + (gesture === '左看' ? -p.step : p.step)); return result(`调节 ${p.title}（尚未保存）`); }
      return result('弹窗内：左右调节，上看恢复原值，下看保留并关闭，双眨放弃调节', false);
    }
    const navigation = {
      boot: { 左看: 'settings', 右看: 'setup' }, settings: { 上看: 'boot' },
      home: { 上看: 'tracks', 下看: 'playback', 左看: 'sound', 右看: 'speed' },
      tracks: { 上看: 'home' }, playback: { 上看: 'home' },
      sound: { 上看: 'home', 下看: 'effects', 左看: 'eq' }, speed: { 上看: 'home' },
      eq: { 上看: 'sound' }, effects: { 上看: 'sound' },
      presets: { 上看: 'home' },
    };
    let message = '';
    const next = navigation[s.page]?.[gesture];
    if (next) { this.changePage(next); message = `进入${DECK_PAGES[next]}`; }
    else if (s.page === 'tracks') {
      if (gesture === '下看') return result(this.open('track') ? '唤出曲目选择弹窗' : '请添加曲目', !!s.popup);
      this.changeDeck(gesture === '左看' ? 'A' : 'B'); message = `目标 Deck ${s.deck}`;
    } else if (s.page === 'playback') {
      if (gesture === '下看') { this.changeDeck(s.deck === 'A' ? 'B' : 'A'); message = `切换操作 Deck ${s.deck}`; }
      if (gesture === '左看') { this.changeParameter(s.deck, 'playing', !d.playing); message = d.playing ? '播放' : '暂停'; }
      if (gesture === '右看') { this.open('seek'); return result('唤出快进 / 快退滑块'); }
    } else if (s.page === 'sound') { this.open('volume'); return result('唤出音量滑块'); }
    else if (s.page === 'speed') {
      if (gesture === '下看') { this.changeDeck(s.deck === 'A' ? 'B' : 'A'); message = `切换操作 Deck ${s.deck}`; }
      if (gesture === '左看') { this.changeParameter(s.deck, 'bpm', this.tracks[d.track]?.bpm || 120); message = '已重置为原始 BPM'; }
      if (gesture === '右看') { this.open('bpm'); return result('唤出 BPM 滑块'); }
    } else if (s.page === 'eq') {
      this.open({ 下看: 'low', 左看: 'mid', 右看: 'high' }[gesture]); return result('唤出 EQ 滑块');
    } else if (s.page === 'effects') {
      if (gesture === '下看') { this.changeParameter(s.deck, 'effectOn', !d.effectOn); message = `效果器${d.effectOn ? '开启' : '关闭'}`; }
      if (gesture === '左看') { this.open('effect'); return result('唤出效果强度滑块'); }
      if (gesture === '右看') { this.changeParameter(s.deck, 'effectType', (d.effectType + 1) % 3); message = `切换效果器：${['混响', '延迟', '合唱'][d.effectType]}`; }
    }
    if (!message) return result('此页面该方向暂不分配功能', false);
    return result(message);
  }
}

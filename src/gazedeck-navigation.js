// Navigation intent only. No engine, playback, profile or storage dependencies.
export const NAV_CATEGORIES = Object.freeze({
  tracks: '曲目与播放管理',
  presets: '音色预设',
  sound: '声音与效果',
  speed: '速度控制',
});

// All control labels use the shared Up / Down / Left / Right order.
export const outerLabels = Object.freeze([
  NAV_CATEGORIES.tracks, NAV_CATEGORIES.presets, NAV_CATEGORIES.sound, NAV_CATEGORIES.speed,
]);
export const innerLabels = Object.freeze(['取消选择／返回外圈', '同时控制 AB', '控制 A', '控制 B']);
const CATEGORY_FOR_DIRECTION = Object.freeze({上看:'tracks', 下看:'presets', 左看:'sound', 右看:'speed'});
const SCOPE_FOR_DIRECTION = Object.freeze({下看:'AB', 左看:'A', 右看:'B'});
const VALID_SCOPES = Object.freeze(['A', 'B', 'AB']);

export class GazeDeckNavigation {
  #state = {stage:'outer', category:null, scope:'A'};

  // A caller can render this snapshot without obtaining a mutable live state.
  get state() { return {...this.#state}; }

  selectCategory(category) {
    if (typeof category !== 'string' || !Object.hasOwn(NAV_CATEGORIES, category)) {
      return {handled:true, executed:false, message:'请选择有效的功能类别'};
    }
    if (this.#state.stage !== 'outer') {
      return {handled:true, executed:false, message:'请先取消当前音轨选择，再重新选择功能'};
    }
    this.#state = {...this.#state, stage:'inner', category};
    return {handled:true, executed:true,
      message:`已选择${NAV_CATEGORIES[category]}；请选择控制 A、B 或 AB，尚未进入功能页面`};
  }

  selectScope(scope) {
    if (!VALID_SCOPES.includes(scope)) {
      return {handled:true, executed:false, message:'请选择有效的 A、B 或 AB 音轨目标'};
    }
    if (this.#state.stage !== 'inner' || !Object.hasOwn(NAV_CATEGORIES, this.#state.category)) {
      return {handled:true, executed:false, message:'请先在外圈选择功能，再选择音轨'};
    }
    const page = this.#state.category;
    this.#state = {stage:'outer', category:null, scope};
    return {handled:true, executed:true,
      message:`已选择 Deck ${scope}，进入${NAV_CATEGORIES[page]}`,
      route:{page, scope}};
  }

  back() {
    const changed = this.#state.stage !== 'outer' || this.#state.category !== null;
    this.#state = {...this.#state, stage:'outer', category:null};
    return {handled:true, executed:changed,
      message:changed ? '已取消功能选择并返回外圈，音轨参数与播放保持不变' : '当前已在主界面外圈'};
  }

  reset() {
    const changed = this.#state.stage !== 'outer' || this.#state.category !== null || this.#state.scope !== 'A';
    this.#state = {stage:'outer', category:null, scope:'A'};
    return {handled:true, executed:changed, message:'主界面导航已重置为外圈，目标 Deck A'};
  }

  dispatch(gesture) {
    if (typeof gesture !== 'string' || !Object.hasOwn(CATEGORY_FOR_DIRECTION, gesture)) {
      return {handled:false, executed:false, message:'此动作由观察、撤回或其他控制规则处理'};
    }
    if (this.#state.stage === 'outer') return this.selectCategory(CATEGORY_FOR_DIRECTION[gesture]);
    if (gesture === '上看') return this.back();
    return this.selectScope(SCOPE_FOR_DIRECTION[gesture]);
  }
}

import { inlineMixer, applySVGBlocks, updateMixerDeck } from './gazemix-svg.js';
import { instrumentDeck } from './gazemix-blocks.js';
import { DECK_GESTURES, DECK_PAGES as BASE_PAGES, DECK_CONTROLS } from './gazedeck-flow.js';
import { GazeDeckAdvancedDemo } from './gazedeck-advanced-demo.js';
import { GazeSliderController } from './gaze-slider.js';
import { GestureEngine } from './engine.js';
import { UNKNOWN_LABEL } from './classifier.js';
import { mountSoundCraftPanel } from './soundcraft-panel.js';
import { eqTarget } from './soundcraft-client.js';
import { appliedTrackRate } from './soundcraft-rate-client.js';
import { effectTarget, EFFECTS } from './soundcraft-effects-client.js';
import { toneDescription } from './soundcraft-presets.js';
import { GazeDeckNavigation, NAV_CATEGORIES, outerLabels, innerLabels } from './gazedeck-navigation.js';
import {waveformMarkup,updateWaveformMarkers} from './soundcraft-waveform-view.js';
import {mountSoundCraftSongLibrary, SoundCraftSongLibrary} from './soundcraft-songs.js';
import {demoWaveformMarkup,readLocalWaveform,updateDemoWaveformMarkers} from './gazedeck-demo-waveforms.js';
import { bindSliderReadout } from './slider-readout.js';

const escape = text => String(text).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const clock = seconds => `${Math.floor((seconds || 0) / 60)}:${String(Math.floor((seconds || 0) % 60)).padStart(2, '0')}`;
const trackDuration = track => track?.durationKnown === false ? '时长待读取' : `${clock(track?.duration)}${track?.demo ? '（示意）' : ''}`;
const DECK_PAGES={...BASE_PAGES,tracks:'4 · 曲目与播放管理',presets:'5 · 音色预设'};
const deckIds=['A','B'];
const primaryPages=['tracks','presets','sound','speed'];
const effectNames={reverb:'混响',delay:'延迟',chorus:'合唱'};
const directionSides=['up','down','left','right'];
const REAL_CONNECTION_HOLD_MS = 60_000;
const iconPaths={
  tracks:'<path d="M3 13h4m-4 4h7m5-4V4l7-1v9m-7-6 7-1"/><ellipse cx="12.5" cy="14" rx="2.5" ry="1.6"/><ellipse cx="19.5" cy="12" rx="2.5" ry="1.6"/>',
  presets:'<path d="M6 4h12v16l-6-4-6 4zM9 8h6m-6 3h6"/>',
  sound:'<path d="M3 9h4l5-4v14l-5-4H3zM15 9c2 1.6 2 4.4 0 6m3-9c4 3 4 9 0 12"/>',
  speed:'<path d="m9 4-4 16h14l-4-16zM11 15l7-8"/><circle cx="11" cy="15" r="1"/>',
  eye:'<path d="M2 12s4-6 10-6 10 6 10 6-4 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="2.7"/>',
};
const icon=name=>iconPaths[name]?`<svg class="deck-action-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconPaths[name]}</svg>`:'';

const introIcons = {
  gear: '<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round" aria-hidden="true"><path d="M27 4h10l2 7 6 3 7-3 7 8-4 6 2 7 7 4-3 10-8 1-4 5 1 8-10 3-5-6h-7l-5 6-10-3 1-8-4-5-8-1-3-10 7-4 2-7-4-6 7-8 7 3 6-3z"/><circle cx="32" cy="32" r="10"/></svg>',
  play: '<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round" aria-hidden="true"><path d="M14 7v50l42-25z"/></svg>',
  camera: '<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="17" width="54" height="37" rx="7"/><path d="M20 17l4-7h16l4 7M25 54v6h14"/><circle cx="32" cy="35" r="11"/></svg>',
  eye: '<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="M3 32s13-17 29-17 29 17 29 17-13 17-29 17S3 32 3 32z"/><circle cx="32" cy="32" r="10"/></svg>',
};
const introEyePulse = '<svg class="deck-intro-eye-pulse" viewBox="0 0 370 92" fill="none" aria-hidden="true"><path d="M2 46h27l8-14 10 30 9-23 8 7h36" stroke="#4fc4b8" stroke-width="2.5" stroke-linecap="round"/><path d="M270 46h36l8-14 10 30 9-23 8 7h27" stroke="#ab91c6" stroke-width="2.5" stroke-linecap="round"/><path d="M111 46s33-35 74-35 74 35 74 35-33 35-74 35-74-35-74-35z" stroke="#a9ddff" stroke-width="5"/><circle cx="185" cy="46" r="20" stroke="#a9ddff" stroke-width="5"/><path d="M185 11v18m0 34v18m-39-35h18m42 0h18" stroke="#a9ddff" stroke-opacity=".38" stroke-width="5" stroke-linecap="round"/></svg>';

function introScreen(page, observing, realModeSelected = false) {
  const boot = page === 'boot';
  return `<div class="deck-orbit deck-advanced-page deck-intro-orbit" data-advanced-page="${page}">
    <div class="deck-intro-ring-title">${boot ? '欢迎使用' : '连接与校准'}</div>
    ${boot ? `<div class="deck-center deck-intro-center deck-intro-boot">
      ${introEyePulse}<h2>GazeDeck</h2><p class="deck-intro-tagline">眼动驱动的双音轨控制系统</p>
      <p class="deck-intro-muted">以视线切换界面，以眼动调节音乐</p>
      <div class="deck-intro-chips"><span>● 系统就绪</span><span id="deckIntroDevice">● 设备待连接</span></div>
      <p class="deck-intro-muted">首次使用可直接点击「启动系统」</p>
      <div class="deck-intro-original-actions"><button type="button" class="primary" data-deck-command="右看">启动系统</button><button type="button" data-deck-start-demo>${realModeSelected ? '进入主界面（真实控制）' : '进入主界面（手动演示）'}</button></div>
    </div>
    <button type="button" class="deck-direction deck-direction-left deck-intro-side" data-deck-command="左看" aria-label="左看进入设置" title="左看" ${observing ? 'disabled' : ''}>${introIcons.gear}<b>进入设置</b><span>配置与偏好</span></button>
    <button type="button" class="deck-direction deck-direction-right deck-intro-side" data-deck-command="右看" aria-label="右看启动系统" title="右看" ${observing ? 'disabled' : ''}>${introIcons.play}<b>启动系统</b><span>连接设备与校准</span></button>
    <p class="deck-intro-ring-bottom">启动后，由助手协助完成连接与校准</p>` : `<div class="deck-center deck-intro-center deck-intro-setup">
      <div class="deck-intro-user">当前用户 <strong id="deckIntroUser">—</strong></div>
      <h2 id="deckIntroReady">请完成设备连接与校准</h2>
      <div class="deck-intro-setup-grid">
        <div class="deck-intro-preview" id="deckIntroPreview"><video id="deckIntroVideo" autoplay muted playsinline></video><div class="deck-intro-preview-placeholder">${introIcons.camera}<span>等待摄像头预览</span></div><small id="deckIntroPreviewBadge">摄像头待连接</small></div>
        <div class="deck-intro-checklist">
          <div data-intro-step="baseline"><i>✓</i><span><strong>静息校准</strong><small>建立当前环境的静息基线</small></span><b data-deck-readiness="baseline">待完成</b></div>
          <div data-intro-step="personal"><i>✓</i><span><strong>五方向校准</strong><small>记录个人眼动范围</small></span><b data-deck-readiness="personal">待完成</b></div>
          <div data-intro-step="samples"><i>✓</i><span><strong>动作样本训练</strong><small>载入已录制的动作样本</small></span><b data-deck-readiness="samples">待完成</b></div>
        </div>
      </div>
      <div class="deck-intro-static-controls" aria-label="设备与校准状态示意"><span id="deckIntroCameraName">摄像头待选择</span><span>刷新设备</span><span>重新校准</span><span>录制样本</span></div>
      <p class="deck-intro-result" id="deckIntroResult">校准结果待完成</p>
      <p class="deck-intro-muted deck-intro-setup-note" id="deckIntroSlider">视线滑块待校准；重新校准保留已有动作样本</p>
      <button type="button" class="deck-intro-demo" data-deck-complete="demo" ${observing ? 'disabled' : ''}>${realModeSelected ? '进入主界面（真实控制）' : '进入主界面（手动演示）'}</button>
    </div>
    <button type="button" class="deck-intro-side deck-intro-side-status deck-direction-left" data-deck-intro-camera aria-label="启动或重新连接摄像头" title="启动或重新连接摄像头">${introIcons.camera}<b>摄像头</b><span id="deckIntroCameraSide">待连接</span></button>
    <button type="button" class="deck-intro-side deck-intro-side-status deck-direction-right" data-deck-intro-recognition aria-label="前往眼动校准与录制" title="前往眼动校准与录制">${introIcons.eye}<b>眼动识别</b><span id="deckIntroModelSide">待就绪</span></button>
    <button type="button" class="deck-intro-enter" data-deck-complete="live" ${observing ? 'disabled' : ''}>进入主界面 <span aria-hidden="true">→</span></button>`}
  </div>`;
}

export function mountGazeDeck(root, { environment, onLog, onExit, onActive, onIntroCamera, onIntroRecognition, previewSource, soundcraftClient, soundcraftRateClient, soundcraftEffectsClient, soundcraftPresetsClient, soundcraftLevelsClient, soundcraftWaveformsClient, soundcraftDeckPlaybackClient, soundcraftSongLibrary, presetStore }) {
  let flow = new GazeDeckAdvancedDemo(), active = false, controller = null, popupOwner = null;
  let lastFrame = -Infinity, lastRender = -Infinity, popupOpenedAt = 0;
  let lastGlowAt = -Infinity, feedbackZone = 'center';
  // User intent stays real even after a failure; never silently fall back to demo.
  let realModeSelected = false;
  let realSession = { snapshot: null, connected: false, formalEnabled: false, connectionIssue: '', bindings: {} };
  let connectionHoldTimer = null, connectionHoldDeadline = 0;
  let rateScope = 'A', rateMessage = '进入速度页后刷新实际倍率。';
  let rateReading = false, rateMetadataKey = null;
  const sourceBpm = { A: null, B: null };
  let matchBpm = null;
  let effectScope = 'A', editedEffect = 'reverb', effectsReading = false;
  let effectsMessage = '进入 Effects 页面后读取真实状态。';
  let presetScope='A';
  const navigation=new GazeDeckNavigation();
  let controlScope='A', overviewReading=false, overviewMessage='';
  let waveformReading=false,lastWaveformRead=-Infinity,waveformGeneration=0,waveformBlockedKey=null;
  let waveformMessage='进入真实控制后读取素材波形。';
  const waveformViews=new WeakMap();
  function setControlScope(scope) {
    if(!['A','B','AB'].includes(scope)||!flow.setScope(scope))return;
    controlScope=scope;rateScope=scope;effectScope=scope;presetScope=scope;
  }
  function returnHome() {navigation.back();flow.navigate('home');}
  function pulseSuccess(gesture) {
    const now = performance.now();
    if (now - lastGlowAt < 800 || !q('deckBlueFeedback').checked) return;
    lastGlowAt = now;
    const glow = q('deckSuccessGlow');
    glow.dataset.direction = ({ 上看: 'up', 下看: 'down', 左看: 'left', 右看: 'right' })[gesture] || 'all';
    glow.dataset.tone = glow.dataset.direction === 'all' ? 'orange' : 'blue';
    glow.classList.toggle('is-pulsing', false);
    void glow.offsetWidth; // Restart one gentle pulse, never an endless strobe.
    glow.classList.toggle('is-pulsing', true);
  }
  const decision = new GestureEngine();
  let mapping = Object.fromEntries(DECK_GESTURES.map(g => [g, g]));
  let personalMappingBeforeQuick = null;
  const events = [], media = { A: new Audio(), B: new Audio() };
  let mediaGeneration=0,libraryGeneration=0,demoTransportPending=false,libraryAnalysis=null,audioResetPending=false;
  const q = id => root.querySelector(`#${id}`);
  const record = (gesture, result, source) => {
    events.unshift({ time: new Date().toLocaleTimeString(), gesture, ...result, source });
    events.length = Math.min(events.length, 40);
    q('deckLastAction').textContent = `${source} · ${gesture} → ${result.message}`;
    q('deckEvents').innerHTML = events.map(e => `<li class="${e.executed ? '' : 'muted'}"><time>${escape(e.time)}</time> ${escape(e.source)} · <b>${escape(e.gesture)}</b> → ${escape(e.message)}<small>${escape(e.from)} → ${escape(e.to)}</small></li>`).join('');
    onLog?.(`GazeDeck · ${source}「${gesture}」→ ${result.message}`, result.executed);
    if (active && source === '眼动识别' && result.executed && result.feedback !== false) pulseSuccess(gesture);
  };
  root.classList.toggle('gazedeck-advanced',true);
  root.classList.toggle('gazemix',true);
  root.innerHTML = `
    <div id="deckSuccessGlow" class="deck-success-glow" aria-hidden="true"></div>
    <div class="deck-heading"><div><span class="eyebrow">眼动页面控制 · 进阶</span><h2>GazeDeck</h2></div>
      <div id="deckEnvironment" class="deck-environment" role="status"></div>
      <div class="row"><span class="pill deck-mode-badge" id="deckModeBadge">网页演示</span><button data-deck-soundcraft>SoundCraft 连接测试</button><button data-deck-settings>曲库与设置</button><button data-deck-exit>返回训练</button><label class="language-switch deck-language-switch"><select data-language-select aria-label="语言"><option value="zh-CN" data-i18n-skip>简体中文</option><option value="en" data-i18n-skip>English</option></select></label></div></div>
    <div id="deckPageTools" class="deck-page-tools" role="group" aria-label="页面控制"><button id="deckBackBoot" type="button" data-deck-back-boot>返回启动界面</button><button id="deckResetAudio" type="button" data-deck-audio-reset>恢复音频初始状态</button></div>
    <aside id="deckConfigPanel" class="deck-config-panel hidden" aria-label="GazeDeck 曲库与设置">
    <div class="row"><h3>曲库与设置</h3><button data-deck-settings>收起设置</button></div>
    <label>控制版本 <select aria-label="GazeDeck 控制版本"><option disabled>基础版（待接入）</option><option selected>进阶版</option><option disabled>高级版（待接入）</option></select></label>
    <p class="hint">先在外圈选功能，再在内圈选 A、B 或 AB。长眨观察／恢复，双眨取消弹窗或撤回最近的参数操作。滑块上看恢复原值，下看确认；确认窗上看取消。</p>
    <fieldset id="deckLocalLibrary" style="border:0;padding:0;margin:0;min-width:0"><div class="row"><label class="file-btn">添加 / 替换本机曲目（最多 5 首）<input id="deckFiles" type="file" multiple accept="audio/*,.mp3,.wav,.ogg,.m4a,.flac"></label>
      <button data-deck-reset>重置界面流程</button><span class="muted">只重置本模块，不删除眼动档案。</span></div>
    <p class="muted">默认曲目为无声演示。导入后可在浏览器播放和调节音量、位置、速度。演示 EQ、效果器与预设用于练习流程；连接 SoundCraft 后调节真实音色。曲目和演示预设刷新后重置。</p></fieldset>
    <h3>进阶页真实音乐控制</h3><p id="deckRealModeStatus" role="status">当前为网页演示模式。</p>
    <button data-deck-soundcraft>连接 SoundCraft 并绑定 A/B 轨道</button>
    <p class="muted">明确绑定 A/B 后启用真实控制。在曲目与播放管理页，选择 A 或 B 可独立播放／暂停和实时快进／快退；播放中的目标 Deck 可直接换曲并从新曲开头继续播放，另一轨保持原状态。选择 AB 可控制工程播放与定位。音量、EQ 按轨道控制。速度页支持 A、B 或 AB 实际音频变速。Effects 支持 A、B、AB 的混响、延迟、合唱：下看开关、左看强度、右看切换编辑类型。三个效果可同时开启，切换编辑类型不改变其他效果。强度弹窗与 EQ 一致：左右调草稿，上看恢复，下看应用一次。真实控制主界面按外圈功能、内圈 A/B/AB 选择进入页面。AB 的音量与三段 EQ 采用共同 dB 偏移并保留两轨差值；音量实时应用，EQ 下看确认后一次应用。</p>
    <section id="deckSoundCraftLibrary" aria-label="SoundCraft 曲库"></section>
    <h3>SoundCraft 工程循环</h3>
    <div class="row" style="justify-content:flex-start;gap:10px"><button id="deckFullLoop" data-deck-full-loop class="primary">选中全部音轨并固定循环</button><button id="deckCancelLoop" data-deck-cancel-loop>取消全音轨循环</button></div>
    <p id="deckLoopStatus" role="status" aria-live="polite">请先暂停 SoundCraft。点击后选中当前工程全部音轨，按完整片段范围开启并保存固定循环；之后通过网页播放时会自动恢复此范围，不受普通鼠标选区变化影响。设置不会自动播放，不修改音频文件。</p>
    <label><input id="deckBlueFeedback" type="checkbox" checked> 成功触发时显示边缘光效反馈</label>
    <p class="muted">上下左右动作仅在对应屏幕边缘闪蓝光；长眨、双眨等非方向动作在四边闪橙光。每次约 0.65 秒淡入淡出，不连续频闪；不适时可关闭。手动模拟与拒识不触发光效。</p>
    <details class="deck-mapping"><summary>识别动作绑定</summary><p class="muted">每个指令绑定一个已训练的动作名称；重命名后可在此重新绑定。</p>
      <div id="deckBindings" class="deck-bindings"></div></details>
    </aside>
    <div id="deckScreen" class="deck-screen"></div>
    <section id="deckSoundCraft" class="sc-panel hidden" aria-label="SoundCraft 真实连接测试"></section>
    <div id="deckSoundCraftVolume" class="sc-volume-popup hidden" role="dialog" aria-modal="true" aria-label="SoundCraft 连续音量弹窗"></div>
    <div id="deckSoundCraftSeek" class="sc-volume-popup hidden" role="dialog" aria-modal="true" aria-label="SoundCraft 快进快退弹窗"></div>
    <div id="deckSoundCraftTempo" class="sc-volume-popup hidden" role="dialog" aria-modal="true" aria-label="SoundCraft 工程 BPM 弹窗"></div>
    <div id="deckSoundCraftEq" class="sc-volume-popup hidden" role="dialog" aria-modal="true" aria-label="SoundCraft 三段 EQ 弹窗"></div>
    <div id="deckSoundCraftRate" class="sc-volume-popup hidden" role="dialog" aria-modal="true" aria-label="SoundCraft 音频变速弹窗"></div>
    <div id="deckSoundCraftEffects" class="sc-volume-popup hidden" role="dialog" aria-modal="true" aria-label="SoundCraft 效果强度弹窗"></div>
    <div id="deckSoundCraftPresets" class="sc-volume-popup hidden" role="dialog" aria-modal="true" aria-label="SoundCraft 音色预设弹窗"></div>
    <div id="deckSoundCraftLinkedVolume" class="sc-volume-popup hidden" role="dialog" aria-modal="true" aria-label="SoundCraft AB 联动音量"></div>
    <div id="deckSoundCraftLinkedEq" class="sc-volume-popup hidden" role="dialog" aria-modal="true" aria-label="SoundCraft AB 联动 EQ"></div>
    <div id="deckSoundCraftSong" class="sc-volume-popup hidden" role="dialog" aria-modal="true" aria-label="SoundCraft 选曲"></div>
    <div id="deckPopup" class="deck-popup hidden" role="dialog" aria-modal="false" aria-labelledby="deckPopupTitle">
      <div class="deck-popup-card"><span id="deckPopupMode" class="eyebrow"></span><h2 id="deckPopupTitle"></h2>
        <p id="deckPopupDecks" class="muted"></p>
        <strong id="deckPopupValue"></strong><p id="deckPopupState" role="status"></p>
        <input id="deckRange" type="range" aria-label="弹窗调节值" step="0.1">
        <label id="deckPopupNameField" class="hidden">预设名称 <input id="deckPopupName" type="text" maxlength="60" autocomplete="off"></label>
        <ol id="deckPopupTracks" class="deck-track-options"></ol>
        <p id="deckPopupInstructions"></p>
        <div class="row"><button id="deckPopupLess" data-deck-command="左看">左看 · 减少</button><button id="deckPopupMore" data-deck-command="右看">右看 · 增加</button>
          <button id="deckPopupReset" data-deck-command="上看">上看 · 恢复原值</button><button id="deckPopupCommit" data-deck-command="下看" class="primary">下看 · 确认</button><button id="deckPopupCancel" data-deck-command="双眨">双眨 · 取消</button><button data-deck-command="长眨">长眨 · 观察 / 恢复</button></div>
      </div>
    </div>
    <footer class="deck-console">
      <div class="deck-feedback" aria-live="polite"><b>动作与结果</b><p id="deckLastAction">等待操作：右看启动系统，左看进入设置。</p><button data-deck-history>操作记录</button></div>
      <div class="row deck-manual"><span id="deckManualLabel" class="muted">手动模拟：</span>${DECK_GESTURES.map(g => `<button type="button" data-deck-command="${g}">${g}</button>`).join('')}<small>长眨：观察 / 恢复 · 双眨：撤回</small></div>
    </footer>
    <aside id="deckHistoryPanel" class="deck-history-panel hidden" aria-label="本模块操作记录"><div class="row"><h3>本模块操作记录</h3><button data-deck-history>收起记录</button></div><ol id="deckEvents" class="deck-events"></ol></aside>`;

  const songLibrary = soundcraftSongLibrary || new SoundCraftSongLibrary(soundcraftClient?.fetchImpl);
  const songCatalog = mountSoundCraftSongLibrary(q('deckSoundCraftLibrary'), { library:songLibrary });
  const soundcraft = mountSoundCraftPanel(q('deckSoundCraft'), {
    environment, client: soundcraftClient, rateClient: soundcraftRateClient, effectsClient:soundcraftEffectsClient, presetsClient:soundcraftPresetsClient, levelsClient:soundcraftLevelsClient, waveformsClient:soundcraftWaveformsClient, deckPlaybackClient:soundcraftDeckPlaybackClient, presetStore, linkedVolumePopupRoot:q('deckSoundCraftLinkedVolume'),linkedEqPopupRoot:q('deckSoundCraftLinkedEq'),presetsPopupRoot:q('deckSoundCraftPresets'), popupRoot: q('deckSoundCraftVolume'), seekPopupRoot: q('deckSoundCraftSeek'), tempoPopupRoot: q('deckSoundCraftTempo'), eqPopupRoot: q('deckSoundCraftEq'), ratePopupRoot: q('deckSoundCraftRate'), effectsPopupRoot:q('deckSoundCraftEffects'),
    songLibrary, songPopupRoot:q('deckSoundCraftSong'),
    onSongLoaded: deck => {
      sourceBpm[deck] = null;
      waveformGeneration++;
      waveformReading = false;
      waveformBlockedKey = null;
      lastWaveformRead = performance.now();
      waveformMessage = '已切换曲目，正在读取新素材波形。';
    },
    onResult: (gesture, result, source) => record(gesture, realModeSelected && !soundcraft.isOpen()
      ? { ...result, from: DECK_PAGES[flow.state.page], to: DECK_PAGES[flow.state.page] } : result, source),
    onSessionChange: session => {
      realSession = session;
      const key = session.snapshot?.projectKey + ':' + session.snapshot?.playbackRateEpoch + ':' + JSON.stringify(session.bindings);
      if (rateMetadataKey !== key) { rateMetadataKey = key; sourceBpm.A = null; sourceBpm.B = null; matchBpm = null; effectsMessage='工程或绑定已变化，请刷新效果器状态。'; waveformGeneration++;waveformReading=false;lastWaveformRead=performance.now();waveformBlockedKey=null;waveformMessage='工程或绑定已变化，正在等待读取素材波形。'; if(realModeSelected&&navigation.state.stage==='inner'){navigation.back();if(flow.state.page==='home')render();} }
      renderRealReadouts();
    },
    onFormalMode: enabled => {
      realModeSelected = enabled;
      flow.cancelPopup();flow.state.observing=false;
      navigation.reset();setControlScope('A');
      flow.state.popup = null; controller = null; popupOwner = null; flow.history = [];
      if (enabled) {
        lastWaveformRead = performance.now();
        mediaGeneration++;demoTransportPending=false;
        for (const d of Object.values(flow.state.decks)) d.playing = false;
        for (const a of Object.values(media)) a.pause();
      }
      flow.navigate('home');
      render();
      record('真实控制模式', { executed: true, message: enabled
        ? '已启用真实控制：先在外圈选择功能，再在内圈选择 A、B 或 AB；选择与返回不会改变声音。'
        : '已返回网页演示模式；SoundCraft 工程播放保持不变。', from: 'SoundCraft 连接测试', to: DECK_PAGES[flow.state.page] }, '助手操作');
    },
    onVolumeClose: kind => {
      if (!soundcraft.isOpen()) root.querySelector(kind === 'tempo-reset' || kind === 'eq-mid' || kind === 'effects' ? '.deck-direction-left' : kind === 'eq-low' || kind === 'song' ? '.deck-direction-down' : '.deck-direction-right')?.focus?.();
    },
    onVisibility: visible => {
      root.classList.toggle('soundcraft-mode', visible);
      q('deckLocalLibrary').disabled = visible || realModeSelected;
      q('deckScreen').classList.toggle('hidden', visible);
      if (visible) {
        q('deckLastAction').textContent = 'SoundCraft 测试区：请先连接，再使用本区真实控制按钮。';
        flow.cancelPopup(); controller = null; popupOwner = null;
        q('deckPopup').classList.toggle('hidden', true);
        q('deckConfigPanel').classList.toggle('hidden', true);
        q('deckHistoryPanel').classList.toggle('hidden', true);
      }
      renderRealReadouts();
    },
  });
  function clearConnectionHold() {
    if (connectionHoldTimer !== null) clearTimeout(connectionHoldTimer);
    connectionHoldTimer = null;
    connectionHoldDeadline = 0;
  }
  function expireConnectionHold() {
    if (!connectionHoldDeadline || active) return;
    const remaining = connectionHoldDeadline - performance.now();
    if (remaining > 0) { connectionHoldTimer = setTimeout(expireConnectionHold, remaining); return; }
    clearConnectionHold();
    soundcraft.close(true);
  }
  function holdConnection() {
    clearConnectionHold();
    connectionHoldDeadline = performance.now() + REAL_CONNECTION_HOLD_MS;
    connectionHoldTimer = setTimeout(expireConnectionHold, REAL_CONNECTION_HOLD_MS);
  }
  for (const [rangeId, valueId] of [
    ['scLiveRange', 'scLiveTarget'], ['scSeekRange', 'scSeekOffset'],
    ['scTempoRange', 'scTempoValue'], ['scEqRange', 'scEqValue'],
    ['scRateRange', 'scRateTarget'], ['scFxRange', 'scFxValue'],
    ['scLinkedVolumeRange', 'scLinkedVolumeOffset'], ['scLinkedEqRange', 'scLinkedEqOffset'],
  ]) bindSliderReadout(q(rangeId), q(valueId));
  const deckRangeReadout = bindSliderReadout(q('deckRange'), q('deckPopupValue'),
    { hideRow: false, enabled: false });
  function realReady() { return realSession.connected && realSession.formalEnabled; }
  function realTrack(id = flow.state.deck) {
    return realSession.snapshot?.tracks.find(track => track.id === realSession.bindings?.[id]);
  }
  function realDeckPlayback() {
    const playback = realSession.deckPlaybackSnapshot;
    return realReady() && playback?.projectKey === realSession.snapshot?.projectKey ? playback : null;
  }
  function soloPlaybackIssue() {
    if (!realReady()) return '请重新连接并启用真实控制。';
    if (realSession.deckPlaybackUnsupported) return realSession.deckPlaybackMessage;
    if (deckIds.some(id => realTrack(id)?.kind !== 'audio')) return '请为 A、B 绑定两条不同的音频轨道。';
    return '';
  }
  function actualRate(deck) {
    const snapshot = realSession.rateSnapshot;
    if (!realReady() || !snapshot?.engineAudioReady || snapshot?.projectKey !== realSession.snapshot?.projectKey
      || snapshot.epoch !== realSession.snapshot?.playbackRateEpoch) return null;
    return appliedTrackRate(snapshot, realSession.bindings?.[deck]);
  }
  function realEffect(deck, effect = editedEffect) {
    const snapshot=realSession.effectsSnapshot;
    if (!realReady() || !snapshot?.engineAudioReady || snapshot.projectKey!==realSession.snapshot?.projectKey
      || snapshot.epoch!==realSession.snapshot?.playbackRateEpoch) return null;
    return effectTarget(snapshot,realSession.bindings?.[deck],effect);
  }
  async function refreshEffects() {
    if (effectsReading || soundcraft.isAdjusting()) return;
    effectsReading=true;effectsMessage='正在读取真实效果器状态…';renderRealReadouts();
    try {await soundcraft.readEffects();effectsMessage='已读取真实状态；强度为干湿混合比例，切换编辑类型不会关闭其他效果。';}
    catch(error){effectsMessage=error.message;}
    finally{effectsReading=false;renderRealReadouts();}
  }
  async function refreshRates() {
    if (rateReading || soundcraft.isAdjusting()) return;
    rateReading = true; rateMessage = '正在读取音频引擎实际倍率…'; renderRealReadouts();
    try { await soundcraft.readRates(); rateMessage = '已读取实际倍率；循环范围固定，以各轨道倍率独立循环。'; }
    catch (error) { rateMessage = error.message; }
    finally { rateReading = false; renderRealReadouts(); }
  }
  async function refreshOverview() {
    if(overviewReading||flow.state.observing||!realReady()||soundcraft.isBusy()||soundcraft.isAdjusting())return;
    overviewReading=true;overviewMessage='正在只读刷新双轨效果与实际倍率…';renderRealReadouts();
    try {await refreshWaveforms(true);await soundcraft.readEffects();await soundcraft.readRates();overviewMessage='';}
    catch(error){overviewMessage=error.message;}
    finally{overviewReading=false;renderRealReadouts();}
  }
  async function refreshWaveforms(manual=false){
    if(waveformReading||!active||!realReady()||soundcraft.isAdjusting()||soundcraft.isBusy())return;
    if(!manual&&waveformBlockedKey===rateMetadataKey)return;
    const ticket=waveformGeneration,key=rateMetadataKey;
    waveformReading=true;lastWaveformRead=performance.now();waveformMessage='正在读取真实素材包络…';renderRealReadouts();
    try{
      await soundcraft.readWaveforms();
      if(ticket!==waveformGeneration||!realReady()||key!==rateMetadataKey)return;
      waveformBlockedKey=null;waveformMessage='素材包络 · 橙线：工程播放头 · 蓝线：已回读的独立素材位置';
    }catch(error){
      if(ticket!==waveformGeneration)return;
      waveformMessage=error.message;
      if(error.code==='waveforms_unsupported')waveformBlockedKey=key;
    }finally{if(ticket===waveformGeneration){waveformReading=false;lastWaveformRead=performance.now();renderRealReadouts();}}
  }
  function renderWaveforms(){
    const snapshot=realSession.snapshot,model=realSession.waveformsSnapshot;
    const current=realReady()&&model?.projectKey===snapshot?.projectKey&&model?.epoch===snapshot?.playbackRateEpoch
      &&model?.lengthSamples===snapshot?.lengthSamples&&model?.sampleRate===snapshot?.sampleRate;
    root.querySelectorAll('[data-real-waveform]').forEach(host=>{
      const deck=host.dataset.realWaveform,trackId=realSession.bindings?.[deck];
      const track=current?model.tracks.find(row=>row.track===trackId):null;
      const signature=JSON.stringify([current,deck,track,model?.sampleRate,model?.lengthSamples,track?null:waveformMessage]);
      if(waveformViews.get(host)!==signature){
        host.innerHTML=waveformMarkup(track||{track:trackId,available:false,reason:realReady()?waveformMessage:'连接失效；波形已隐藏'},
          {deck,sampleRate:current?model.sampleRate:snapshot?.sampleRate,lengthSamples:current?model.lengthSamples:snapshot?.lengthSamples});
        waveformViews.set(host,signature);
      }
    });
    const trackPositions = new Map();
    if (realReady()) {
      for (const row of snapshot?.sourcePositions || []) trackPositions.set(row.track, row.sourcePositionSamples);
      for (const row of realDeckPlayback()?.tracks || []) {
        if (Number.isFinite(row.position)) trackPositions.set(row.track, row.position);
      }
    }
    updateWaveformMarkers(root, { positionSamples:realReady()?snapshot?.positionSamples:null, lengthSamples:snapshot?.lengthSamples,
      trackPositions: [...trackPositions].map(([track, sourcePositionSamples]) => ({ track, sourcePositionSamples, sourcePositionVerified:true })) });
    root.querySelectorAll('[data-waveforms-status]').forEach(el=>{el.textContent=waveformMessage;});
    root.querySelectorAll('[data-deck-refresh-waveforms]').forEach(el=>{el.disabled=waveformReading||!realReady()||soundcraft.isAdjusting()||soundcraft.isBusy();});
  }
  async function openRealRate(kind, source = '手动控制', gesture = '实际变速', note = '') {
    if (kind !== 'match') {
      await soundcraft.openFormalRate(rateScope, source, gesture, note, kind === 'reset' ? { reset: true } : {}); return;
    }
    try {
      await soundcraft.readRates();
      if (!realReady() || !active || flow.state.observing) throw new Error('连接或控制状态已变化，请重新选择');
      const selected = rateScope === 'AB' ? ['A', 'B'] : [rateScope];
      const other = rateScope === 'A' ? 'B' : 'A';
      const target = rateScope === 'AB' ? matchBpm : sourceBpm[other] * actualRate(other)?.rate;
      if (!(target > 0) || !Number.isFinite(target)) throw new Error('请先填写两轨的原始 BPM；AB 匹配还需要填写共同目标 BPM');
      const targets = selected.map(deck => {
        const rate = target / sourceBpm[deck];
        if (!(sourceBpm[deck] > 0) || !Number.isFinite(rate) || rate < .5 || rate > 2) throw new Error(`Deck ${deck} 匹配结果超出 0.5–2 倍或缺少原始 BPM，未发送修改`);
        return { track: realSession.bindings[deck], rate };
      });
      await soundcraft.openFormalRate(rateScope, source, gesture, note, { confirmTargets: targets, title: `匹配至 ${target.toFixed(1)} BPM · 确认` });
    } catch (error) { record(gesture, { executed: false, message: note + error.message, from: DECK_PAGES[flow.state.page], to: DECK_PAGES[flow.state.page] }, source); }
  }
  function realModeText() {
    if (!realModeSelected) return '网页演示模式';
    if (realSession.checkingConnection) return '正在核对原 SoundCraft 工程，确认后可继续控制';
    if (!realReady()) return `真实控制已停止：${realSession.connectionIssue || '连接或绑定未就绪'}；请重新连接并确认 A/B 绑定`;
    return `SoundCraft 真实控制 · ${realSession.snapshot.projectName} · A → ${realTrack('A')?.name}（ID ${realTrack('A')?.id}） · B → ${realTrack('B')?.name}（ID ${realTrack('B')?.id}）`;
  }
  function updateSvgReadouts() {
    const board=root.querySelector('.mix-inline-board');
    if(!board?.querySelectorAll)return;
    for(const id of deckIds){
      if(!realModeSelected){
        const lane=flow.state.decks[id],track=flow.tracks[lane.track];
        const host=board.querySelector(`[data-mix-wave="${id}"]`);
        const title=track?.demo&&globalThis.document?.documentElement.lang==='en'?`Demo track ${lane.track+1}`:track?.name;
        updateMixerDeck(root,id,{name:title,elapsed:lane.position,duration:track?.durationKnown===false?null:track?.duration,
          bpm:track?.bpmKnown===false?null:lane.bpm,volume:lane.volume,meterLevel:lane.volume/100,
          eq:Object.fromEntries(['low','mid','high'].map(band=>[band,lane[band]])),
          effects:Object.fromEntries(EFFECTS.map(effect=>[effect,lane.effects[effect].enabled?lane.effects[effect].amount:0])),
          playing:lane.playing,waveform:host&&!host.firstElementChild?demoWaveformMarkup(track,id,lane):null});
      }else{
        const ready=realReady(),track=realTrack(id),snapshot=realSession.snapshot;
        const deck=realDeckPlayback()?.tracks.find(row=>row.track===track?.id),rate=actualRate(id),eq=eqTarget(snapshot,track?.id);
        updateMixerDeck(root,id,{live:true,name:ready?track?.name:'—',
          elapsed:ready&&Number.isFinite(deck?.position)&&snapshot?.sampleRate>0?deck.position/snapshot.sampleRate:null,
          duration:null,bpm:ready&&sourceBpm[id]>0&&rate?sourceBpm[id]*rate.rate:null,
          volume:ready?track?.volumeDb:null,volumeUnit:'dB',
          meterLevel:ready&&Number.isFinite(track?.volumeDb)?(track.volumeDb+60)/66:null,
          eq:ready&&eq.supported?eq.values:{},effects:Object.fromEntries(EFFECTS.map(effect=>{const fx=realEffect(id,effect);return[effect,fx?.available?(fx.enabled?fx.amount*100:0):null];})),
          playing:ready&&deck?(!deck.paused&&snapshot.playing):null});
      }
    }
  }
  function renderRealReadouts() {
    applySVGBlocks(root,navigation.state,flow.state.observing);
    updateSvgReadouts();
    q('deckRealModeStatus').textContent = realModeText();
    q('deckModeBadge').textContent = realModeSelected
      ? (realSession.checkingConnection ? 'SoundCraft 核对连接中' : realReady() ? 'SoundCraft 真实控制' : 'SoundCraft 待重连')
      : '网页演示';
    q('deckModeBadge').dataset.mode=realModeSelected?'real':'demo';
    q('deckManualLabel').textContent = realModeSelected ? '手动控制（真实）：' : '手动模拟：';
    q('deckLocalLibrary').disabled = realModeSelected || root.classList.contains('soundcraft-mode');
    root.classList.toggle('soundcraft-formal-mode', realModeSelected);
    root.querySelectorAll('[data-real-mode-status]').forEach(el => { el.textContent = realModeText(); });
    root.querySelectorAll('[data-overview-status]').forEach(el=>{el.textContent=overviewMessage;});
    root.querySelectorAll('[data-deck-refresh-overview]').forEach(el=>{el.disabled=overviewReading||soundcraft.isBusy()||soundcraft.isAdjusting()||flow.state.observing;});
    const snapshot = realSession.snapshot, ready = realReady();
    const bpm = snapshot?.tempoSupported && Number.isFinite(snapshot.tempoBpm) ? snapshot.tempoBpm : null;
    const reference = realSession.tempoReferenceBpm;
    const tempoValues = {
      'data-real-tempo': bpm === null ? '—' : `${bpm.toFixed(1)} BPM${ready ? '' : '（上次读数）'}`,
      'data-real-tempo-ref': Number.isFinite(reference) ? `${reference.toFixed(1)} BPM` : '未记录',
      'data-real-tempo-diff': bpm !== null && reference > 0 ? `${((bpm / reference - 1) * 100).toFixed(1)}%` : '—',
      'data-real-tempo-status': snapshot?.tempoSupported ? '工程节拍由 A/B 共用；实际音频变速使用独立倍率控制'
        : snapshot?.tempoReason || '请重新连接读取工程 BPM',
    };
    for (const [attribute, value] of Object.entries(tempoValues)) root.querySelectorAll(`[${attribute}]`).forEach(el => { el.textContent = value; });
    root.querySelectorAll('[data-real-rate-status]').forEach(el => { el.textContent = rateMessage; });
    root.querySelectorAll('[data-real-effects-status]').forEach(el=>{el.textContent=effectsMessage;});
    root.querySelectorAll('[data-deck-effects-scope]').forEach(el=>{el.disabled=effectsReading || flow.state.observing || soundcraft.isBusy() || soundcraft.isAdjusting();});
    root.querySelectorAll('[data-deck-preset-scope]').forEach(el=>{el.disabled=flow.state.observing || soundcraft.isBusy() || soundcraft.isAdjusting();});
    const preset=realSession.presetSummary;
    root.querySelectorAll('[data-preset-summary]').forEach(el=>{el.textContent=preset?.storageError?`预设存储不可用：${preset.storageError}`:preset?.selected?`已选：${preset.selected.name} · ${preset.selected.mode==='pair'?'AB 双轨预设':'单轨通用预设'} · 共 ${preset.count} 个`:`尚未选择预设 · 已保存 ${preset?.count||0} 个`;});
    root.querySelectorAll('[data-preset-details]').forEach(el=>{el.innerHTML=preset?.selected?Object.entries(preset.selected.tones).map(([id,tone])=>`<p style="font-size:13px">${preset.selected.mode==='pair'?`Deck ${id}`:'通用音色'}：${escape(toneDescription(tone))}</p>`).join(''):'';});
    root.querySelectorAll('[data-deck-rate-scope], [data-deck-source-bpm], [data-deck-match-bpm]').forEach(el => {
      el.disabled = rateReading || flow.state.observing || soundcraft.isBusy() || soundcraft.isAdjusting();
    });
    const playback = realDeckPlayback();
    const projectPlaying = !ready ? '连接失效 · 状态待确认' : snapshot.playing ? '▶ 工程播放中' : 'Ⅱ 工程已暂停';
    const projectTime = snapshot ? `${clock(snapshot.positionSeconds)} / ${snapshot.durationSeconds > 0 ? clock(snapshot.durationSeconds) : '时长未读取'}${ready ? '' : '（上次读数）'}` : '—';
    const soloIssue = controlScope === 'AB' ? '' : soloPlaybackIssue();
    let seekIssue = '';
    if (controlScope !== 'AB') {
      if (ready && realTrack(controlScope)?.kind !== 'audio') seekIssue = '请选择已绑定的音频轨道。';
      else if (realSession.deckPlaybackUnsupported || (playback && playback.seekSupported !== true)) {
        seekIssue = '单轨实时快进／快退需要新版 SoundCraft 控制模式与桌面网页服务。';
      }
    }
    root.querySelectorAll('[data-real-project-playing]').forEach(el => { el.textContent = projectPlaying; });
    root.querySelectorAll('[data-real-project-time]').forEach(el => { el.textContent = projectTime; });
    root.querySelectorAll('[data-real-deck-playback-status]').forEach(el => {
      el.textContent = soloIssue || (controlScope === 'AB' ? '' : realSession.deckPlaybackMessage || '');
    });
    root.querySelectorAll('[data-deck-real-playback], [data-deck-real-playback-direction]').forEach(el => {
      el.disabled = !ready || !!soloIssue || flow.state.observing || soundcraft.isBusy() || soundcraft.isAdjusting();
    });
    root.querySelectorAll('[data-deck-real-seek], [data-deck-real-seek-direction]').forEach(el => {
      el.disabled = !ready || !!seekIssue || flow.state.observing || soundcraft.isBusy() || soundcraft.isAdjusting();
    });
    root.querySelectorAll('[data-real-deck-seek-status]').forEach(el => { el.textContent = seekIssue; });
    let songIssue = '';
    if (controlScope === 'AB') songIssue = '换曲请选定 A 或 B。';
    else if (playback?.loadSupported === false) songIssue = '请通过桌面快捷方式重开支持换曲的 SoundCraft 控制模式。';
    root.querySelectorAll('[data-real-deck-song-status]').forEach(el => { el.textContent = songIssue; });
    root.querySelectorAll('[data-deck-real-song], [data-deck-real-song-direction]').forEach(el => {
      el.disabled = !ready || !!songIssue || flow.state.observing || soundcraft.isBusy() || soundcraft.isAdjusting();
    });
    for (const id of ['A', 'B']) {
      const track = realTrack(id);
      const deck = playback?.tracks.find(row => row.track === track?.id);
      const deckPlaying = !ready ? '连接失效 · 状态待确认' : deck?.paused ? 'Ⅱ Deck 已暂停'
        : deck ? snapshot.playing ? '▶ Deck 播放中' : 'Ⅱ 随工程暂停'
          : realSession.deckPlaybackUnsupported ? '单轨状态不可用' : '单轨状态待确认';
      const deckTime = Number.isFinite(deck?.position) && snapshot?.sampleRate > 0
        ? `素材 ${clock(deck.position / snapshot.sampleRate)}` : `工程 ${projectTime}`;
      const rate = actualRate(id);
      const fx=realEffect(id);
      const eq = eqTarget(snapshot, track?.id);
      const eqReadout = band => eq.supported ? `${eq.values[band].toFixed(1)} dB${ready ? '' : '（上次读数）'}` : '—';
      const values = {
        rate: rate ? `${rate.rate.toFixed(3)}× · ${((rate.rate - 1) * 100).toFixed(1)}%` : '待实际回读',
        'source-bpm': sourceBpm[id] > 0 ? `${sourceBpm[id].toFixed(1)} BPM（手动参考）` : '原始 BPM 未填写',
        'calculated-bpm': sourceBpm[id] > 0 && rate ? `${(sourceBpm[id] * rate.rate).toFixed(1)} BPM（按倍率计算）` : '—',
        'mix-bpm': sourceBpm[id] > 0 && rate ? (sourceBpm[id] * rate.rate).toFixed(1) : '—',
        ...Object.fromEntries(EFFECTS.map(effect=>{const value=realEffect(id,effect);return [`mix-${effect}`,value?.available?(value.enabled?`${(value.amount*100).toFixed(0)}%`:'关闭'):'—'];})),
        'fx-selected': !fx ? '效果器状态需刷新' : !fx.available ? fx.reason : `${effectNames[editedEffect]} · ${fx.enabled?'开启':'关闭'} · ${(fx.amount*100).toFixed(1)}%${fx.insert?` · 插槽 ${fx.slot+1}`:' · 尚未添加，请先开启'}`,
        'fx-summary': EFFECTS.map(effect=>{const state=realEffect(id,effect);return state?.available?`${effectNames[effect]} ${state.enabled?`${(state.amount*100).toFixed(0)}%`:'关闭'}`:'';}).filter(Boolean).join(' · ') || '效果器状态需刷新',
        low: eqReadout('low'), mid: eqReadout('mid'), high: eqReadout('high'),
        'eq-status': eq.supported ? (eq.insert ? `EQ 7-Band · 插槽 ${eq.slot + 1}` : '尚未添加 EQ；首次提交时使用空闲插槽') : eq.reason,
        track: track ? `${track.name} · ID ${track.id}` : '未绑定轨道',
        volume: track && Number.isFinite(track.volumeDb) ? `${track.volumeDb.toFixed(1)} dB${ready ? '' : '（上次读数）'}` : '—',
        playing: deckPlaying,
        time: deckTime,
        'time-total': deckTime,
      };
      for (const [key, value] of Object.entries(values)) root.querySelectorAll(`[data-real-${key}="${id}"]`).forEach(el => { el.textContent = value; });
      root.querySelectorAll(`[data-real-project-progress="${id}"]`).forEach(el=>{el.value=snapshot?.durationSeconds>0?Math.max(0,Math.min(1,snapshot.positionSeconds/snapshot.durationSeconds)):0;});
    }
    renderWaveforms();
  }
  function renderBindings() {
    const labels = environment().gestures;
    q('deckBindings').innerHTML = DECK_GESTURES.map(g => `<label>${g}<select data-deck-binding="${g}"><option value="">未绑定</option>${labels.map(l => `<option ${mapping[g] === l ? 'selected' : ''} value="${escape(l)}">${escape(l)}</option>`).join('')}</select></label>`).join('');
    for (const g of DECK_GESTURES) if (!labels.includes(mapping[g])) mapping[g] = '';
  }
  function mirrorIntroPreview() {
    const preview = q('deckIntroVideo');
    if (!preview) return;
    const stream = previewSource?.srcObject;
    q('deckIntroPreview').dataset.preview = stream?.getVideoTracks?.().some(track => track.readyState === 'live' && !track.muted) ? 'true' : 'false';
    if (stream && preview.srcObject !== stream) {
      preview.srcObject = stream;
      void preview.play().catch(() => {});
    } else if (!stream && preview.srcObject) preview.srcObject = null;
  }
  function renderEnvironment() {
    const e = environment();
    const missing = DECK_GESTURES.filter(g => !mapping[g] || !e.labels.includes(mapping[g]));
    q('deckEnvironment').textContent = `用户：${e.user} · 摄像头${e.camera ? '运行中' : '未运行'} · 静息${e.baseline ? '已校准' : '未校准'} · 滑块${e.calibration ? '已校准' : '未校准'}${missing.length ? ` · 未具备可识别样本：${missing.join('、')}` : ' · 六个指令样本已就绪'}`;
    const complete = root.querySelector('[data-deck-complete="live"]');
    if (complete) complete.disabled = !e.camera || !e.baseline || missing.length > 0 || flow.state.observing;
    const readiness={camera:e.camera,baseline:e.baseline,slider:!!e.calibration,samples:missing.length===0};
    for(const [key,ready] of Object.entries(readiness))root.querySelectorAll(`[data-deck-readiness="${key}"]`).forEach(el=>{el.textContent=ready?'已就绪':'待完成';el.dataset.ready=String(ready);});
    if (root.querySelector('.deck-intro-orbit')) {
      mirrorIntroPreview();
      if (q('deckIntroDevice')) q('deckIntroDevice').textContent = e.camera ? '● 设备已连接' : '● 设备待连接';
      if (q('deckIntroUser')) q('deckIntroUser').textContent = e.user;
      if (q('deckIntroReady')) q('deckIntroReady').textContent = e.camera && e.baseline && readiness.samples ? '准备就绪，可以开始眼动控制' : '请完成设备连接与校准';
      if (q('deckIntroPreviewBadge')) q('deckIntroPreviewBadge').textContent = e.cameraStream ? '● 摄像头已连接' : e.camera ? '● 视频输入已就绪' : '● 摄像头待连接';
      if (q('deckIntroCameraName')) q('deckIntroCameraName').textContent = e.cameraLabel || '摄像头待选择';
      if (q('deckIntroCameraSide')) q('deckIntroCameraSide').textContent = e.cameraStream ? '已连接' : e.camera ? '视频已就绪' : '待连接';
      if (q('deckIntroModelSide')) q('deckIntroModelSide').textContent = readiness.samples ? '已就绪' : '待训练';
      const personal = !!e.eyeCalibration;
      const personalStatus = q('deckIntroReady')?.closest('.deck-intro-orbit')?.querySelector('[data-deck-readiness="personal"]');
      if (personalStatus) { personalStatus.textContent = personal ? '已完成' : '待完成'; personalStatus.dataset.ready = String(personal); personalStatus.closest('[data-intro-step]').dataset.ready = String(personal); }
      for (const key of ['baseline', 'samples']) {
        const item = root.querySelector(`.deck-intro-orbit [data-deck-readiness="${key}"]`);
        if (item) { item.textContent = readiness[key] ? key === 'samples' ? '已就绪' : '已完成' : '待完成'; item.closest('[data-intro-step]').dataset.ready = String(readiness[key]); }
      }
      const axis = status => status === 'good' ? '可用' : status === 'partial' ? '一般' : '需加强';
      if (q('deckIntroResult')) q('deckIntroResult').textContent = personal ? `✓ 校准结果：横向${axis(e.eyeCalibration.horizontal?.status)} · 纵向${axis(e.eyeCalibration.vertical?.status)}` : '校准结果：五方向待完成';
      if (q('deckIntroSlider')) q('deckIntroSlider').textContent = `视线滑块${readiness.slider ? '已校准' : '待校准'}；重新校准保留已有动作样本`;
    }
    const popup = flow.state.popup;
    const calibration=popup&&popup.mode!=='confirm'&&popup.max>popup.min&&e.sliderSettings?.enabled&&active?e.calibration:null;
    if (popup && (popupOwner !== popup || (controller?.calibration||null) !== calibration)) startController();
  }
  const scopeDecks=()=>controlScope==='AB'?deckIds:[controlScope];
  function updatePageTools() {
    const back = q('deckBackBoot'), reset = q('deckResetAudio');
    back.disabled = audioResetPending || flow.state.page === 'boot';
    reset.disabled = audioResetPending;
    reset.setAttribute('aria-busy', String(audioResetPending));
    reset.textContent = audioResetPending ? '正在恢复音频…' : '恢复音频初始状态';
  }
  async function resetAudioFromToolbar() {
    const page = DECK_PAGES[flow.state.page];
    const report = (executed, message) => record('恢复音频初始状态', { executed, message, from: page, to: DECK_PAGES[flow.state.page] }, realModeSelected ? '手动控制' : '手动模拟');
    if (audioResetPending) return;
    if (demoTransportPending || flow.state.popup || soundcraft.isBusy() || soundcraft.isAdjusting()) {
      report(false, '请先完成当前播放指令或关闭参数弹窗，再恢复音频');
      return;
    }
    if (realModeSelected && !realReady()) {
      report(false, '真实连接或 A/B 绑定未就绪，请重新连接后再恢复音频');
      return;
    }
    audioResetPending = true;
    updatePageTools();
    try {
      const result = realModeSelected ? await soundcraft.resetAudio() : flow.resetAudio();
      if (result?.executed !== true) throw new Error(result?.message || '音频未能恢复');
      if (!realModeSelected) {
        mediaGeneration++;
        for (const audio of Object.values(media)) {
          audio.pause();
          if (audio.readyState > 0) audio.currentTime = 0;
        }
        syncMedia({ seekDecks: ['A', 'B'] });
      }
      render();
      report(true, result?.message || '音频已恢复初始状态');
    } catch (error) {
      report(false, `${error.message || '音频恢复失败'}${error.mayHaveExecuted ? '；部分操作可能已生效，请核对实际状态后再重试' : ''}`);
    } finally {
      audioResetPending = false;
      updatePageTools();
    }
  }
  function demoFxText(lane){
    return EFFECTS.filter(effect=>lane.effects?.[effect]?.enabled).map(effect=>`${effectNames[effect]} ${lane.effects[effect].amount.toFixed(0)}%`).join(' · ')||'效果器未开启';
  }
  function demoBpm(track,lane){return track?.bpmKnown===false?'BPM 待填写':`${lane.bpm.toFixed(1)} BPM`;}
  function demoDeckCard(id,showWave=true){
    const lane=flow.state.decks[id],track=flow.tracks[lane.track];
    if (showWave && flow.state.page === 'home') return instrumentDeck({
      id, track:track?.name||'未装载曲目', time:`${clock(lane.position)} / ${trackDuration(track)}`,
      bpm:track?.bpmKnown===false?'—':lane.bpm.toFixed(1), volume:`${lane.volume.toFixed(0)}%`, playing:lane.playing?'▶':'Ⅱ',
      eq:Object.fromEntries(['low','mid','high'].map(band=>[band,`${lane[band].toFixed(1)} dB`])),
      effects:Object.fromEntries(EFFECTS.map(effect=>[effect,lane.effects[effect].enabled?`${lane.effects[effect].amount.toFixed(0)}%`:'关闭'])),
      waveform:demoWaveformMarkup(track,id,lane),
    });
    return `<article class="deck-card ${scopeDecks().includes(id)?'active':''}" data-deck-lane="${id}"><div class="deck-home-track-title"><b>Deck ${id}</b> <strong>${escape(track?.name||'未装载曲目')}</strong></div>
      <p><span data-deck-playing="${id}">${lane.playing?'▶':'Ⅱ'}</span> · <span data-deck-time="${id}">${clock(lane.position)} / ${trackDuration(track)}</span> · ${demoBpm(track,lane)} · 音量 <b>${lane.volume.toFixed(0)}%</b></p>
      ${showWave?demoWaveformMarkup(track,id,lane):''}<p>LOW ${lane.low.toFixed(1)} · MID ${lane.mid.toFixed(1)} · HIGH ${lane.high.toFixed(1)} dB · ${demoFxText(lane)}</p></article>`;
  }
  let lastRenderedPage = null;
  function finishScreenRender() {
    const page=flow.state.page;
    if(lastRenderedPage!==null&&lastRenderedPage!==page)q('deckScreen').querySelector?.('.deck-orbit')?.classList.add('mix-page-enter');
    lastRenderedPage=page;
    renderPopup();renderEnvironment();renderRealReadouts();
  }
  function render({navigationOnly=false}={}) {
    const s = flow.state;
    updatePageTools();
    if (s.page === 'boot' || s.page === 'setup') {
      q('deckScreen').innerHTML = introScreen(s.page, s.observing, realModeSelected);
      finishScreenRender();
      return;
    }
    if(s.page==='home') {
      const nav=navigation.state,outer=nav.stage==='outer';
      const ringLabels=(stage,labels)=>labels.map((label,i)=>{
        const letter=stage==='inner'&&i>=2?`<b class="deck-target-letter" aria-hidden="true">${i===2?'A':'B'}</b>`:'';
        const content=`${stage==='outer'?icon(primaryPages[i]):letter}<span>${escape(label)}</span>`;
        const selected=stage==='outer'&&nav.category===primaryPages[i]?' is-selected':'';
        return outer===(stage==='outer')
          ?`<button type="button" class="deck-home-label deck-home-label--${stage} is-active" data-side="${directionSides[i]}" data-deck-command="${DECK_GESTURES[i]}" title="${DECK_GESTURES[i]}" ${s.observing?'disabled':''}>${content}</button>`
          :`<span class="deck-home-label deck-home-label--${stage}${selected}" data-side="${directionSides[i]}" aria-hidden="true">${content}</span>`;
      }).join('');
      const currentOrbit=navigationOnly?q('deckScreen').querySelector?.('.deck-home-orbit'):null;
      if(currentOrbit?.querySelector('.mix-inline-board')) {
        // Stage selection changes only navigation, not the instrument DOM.
        // Keeping the SVG mounted preserves waveform paint and CSS transitions.
        currentOrbit.dataset.navStage=nav.stage;
        currentOrbit.querySelectorAll('.deck-home-label').forEach(node=>node.remove());
        currentOrbit.insertAdjacentHTML('beforeend',ringLabels('outer',outerLabels)+ringLabels('inner',innerLabels));
        const status=currentOrbit.querySelector('.deck-status-line');
        if(status)status.innerHTML=`<span class="pill">${outer?'① 选择功能':'② 选择音轨'}</span><span class="muted">${outer?'先选功能，再选音轨':`已选：${NAV_CATEGORIES[nav.category]}`}</span>`;
        finishScreenRender();return;
      }
      const liveCards=()=>deckIds.map(id=>instrumentDeck({id,live:true})).join('');
      q('deckScreen').innerHTML=`<div class="deck-orbit deck-home-orbit" data-advanced-page="home" data-nav-stage="${nav.stage}">${inlineMixer()}
        <div class="deck-home-rings" aria-hidden="true"><div class="deck-home-ring deck-home-ring--outer"></div><div class="deck-home-ring deck-home-ring--inner"></div><div class="deck-home-ring deck-home-ring--center"></div></div>
        <div class="deck-center deck-home-center"><div class="deck-status-line"><span class="pill ${s.observing?'warn':''}">${s.observing?'观察模式 · 控制已冻结':outer?'① 选择功能':'② 选择音轨'}</span><span class="muted">${outer?'先选功能，再选音轨':`已选：${NAV_CATEGORIES[nav.category]}`}</span></div>
        <div class="deck-page-content"><div class="deck-home-title"><h2>3 · 主界面</h2>${realModeSelected?'<button data-deck-refresh-overview>刷新双轨概览</button>':''}</div><div class="deck-home-overview">${realModeSelected?liveCards():deckIds.map(id=>demoDeckCard(id)).join('')}</div>
          ${realModeSelected?'<p class="muted" data-waveforms-status></p><p class="muted" data-overview-status></p><p class="muted">工程节拍 <b data-real-tempo></b> · 橙线：工程 · 蓝线：独立素材</p>':'<p class="muted">网页演示 · <button class="deck-inline-action" data-deck-soundcraft>连接 SoundCraft 启用真实控制</button></p>'}
        </div></div>${ringLabels('outer',outerLabels)}${ringLabels('inner',innerLabels)}</div>`;
      finishScreenRender();return;
    }
    let controlLabels={tracks:['返回主界面','选择曲目','播放／暂停','快进／快退'],speed:['返回主界面','匹配另一轨 BPM','恢复原速','调节速度'],effects:['返回声音与效果',`${effectNames[flow.currentEffect]} 开关`,`${effectNames[flow.currentEffect]} 强度`,'切换编辑效果器']}[s.page]||DECK_CONTROLS[s.page];
    const mediaList=flow.tracks.map((track,i)=>`<li class="${scopeDecks().some(id=>s.decks[id].track===i)?'selected':''}"><span>${i+1}. ${escape(track.name)} · ${trackDuration(track)}</span><label>原始 BPM <input aria-label="第 ${i+1} 首原始 BPM" data-deck-bpm="${i}" type="number" min="60" max="200" step="0.1" value="${track.bpmKnown===false?'':track.bpm}" ${s.observing||s.popup?'disabled':''}></label></li>`).join('');
    const scopeSummary=renderRow=>`<div class="deck-parameters">${scopeDecks().map(id=>`<div data-deck-lane="${id}"><b>Deck ${id}</b>${renderRow(s.decks[id],id)}</div>`).join('')}</div>`;
    const content = {
      boot: `<div class="deck-launch-mark">${icon('eye')}</div><h3 class="deck-brand-title">GazeDeck</h3><p>眼动驱动的双音轨控制</p><p class="muted">先完成校准，或直接练习新版操作。</p><div class="row"><button class="primary" data-deck-command="右看">启动系统</button><button data-deck-start-demo>进入主界面（手动演示）</button></div>`,
      setup: `<div class="deck-readiness">${[['camera','摄像头'],['baseline','静息校准'],['slider','左右标尺'],['samples','动作样本']].map(([key,label])=>`<div><b>${label}</b><span data-deck-readiness="${key}"></span></div>`).join('')}</div><p class="muted">需要补录或校准时，返回「① 校准与录制」完成后再进入。</p><div class="row"><button class="primary" data-deck-complete="live">校准完成，进入主界面</button><button data-deck-complete="demo" ${s.observing ? 'disabled' : ''}>进入主界面（手动演示）</button></div>`,
      settings: '<p>六个动作绑定、音频导入与蓝光反馈可通过右上角「曲库与设置」调整。摄像头与眼动参数仍在原有「⑤ 设置」中配置。上看返回启动界面。</p>',
      tracks: `<div class="deck-real-waveform-pair">${scopeDecks().map(id=>demoDeckCard(id)).join('')}</div><p class="muted">${controlScope==='AB'?'AB 可同时播放、暂停与相对定位；装载曲目时请选择单轨。':'暂停当前音轨后，下看选择并确认曲目。'}</p><details><summary>曲库 · ${flow.tracks.length} 首</summary><ol class="deck-library">${mediaList}</ol></details>`,
      playback: '<p>播放控制已并入「曲目与播放管理」。上看返回主界面。</p>',
      sound: `${scopeSummary(lane=>`<strong>音量 <b>${lane.volume.toFixed(0)}%</b></strong><small>${demoFxText(lane)}</small>`)}<p class="muted">右侧调音量，左侧进入三段 EQ，下方进入效果器。</p><button data-deck-open-presets>打开音色预设</button>`,
      speed: `${scopeSummary(lane=>{const track=flow.tracks[lane.track];return`<strong>${demoBpm(track,lane)}</strong><small>原始 ${track?.bpmKnown===false?'待填写':`${track?.bpm||120} BPM`} · ${(lane.bpm/(track?.bpm||120)).toFixed(3)}×</small>`;})}<p class="muted">${controlScope==='AB'?'两轨按共同系数调速；匹配另一轨 BPM 时请选择单轨。':'下看匹配另一轨 BPM；左右分别恢复原速、调节速度。'}</p><details><summary>填写曲目参考 BPM</summary><ol class="deck-library">${mediaList}</ol></details>`,
      eq: `<div class="deck-parameters">${['low','mid','high'].map((band,i)=>`<div><button data-deck-command="${['下看','左看','右看'][i]}">${band.toUpperCase()}</button>${scopeDecks().map(id=>`<small>Deck ${id}</small><strong>${s.decks[id][band].toFixed(1)} dB</strong>`).join('')}</div>`).join('')}</div><p class="muted">网页演示参数。连接 SoundCraft 后调节实际 EQ。</p>`,
      effects: `<h3>${effectNames[flow.currentEffect]}</h3>${scopeSummary(lane=>{const fx=lane.effects[flow.currentEffect];return`<strong>${fx.enabled?'已开启':'已关闭'} · ${fx.amount.toFixed(0)}%</strong><small>${demoFxText(lane)}</small>`;})}<p class="muted">右看切换编辑效果器；各效果可独立开启。网页演示参数不处理本地音频。</p>`,
      presets: `<p>${flow.selectedPreset?`已选：<b>${escape(flow.selectedPreset.name)}</b>`:'尚未选择预设'} · 共 ${flow.presets.length} 个演示预设</p>${scopeSummary(lane=>`<small>LOW ${lane.low.toFixed(1)} · MID ${lane.mid.toFixed(1)} · HIGH ${lane.high.toFixed(1)} dB</small><small>${demoFxText(lane)}</small>`)}<div class="row"><button data-deck-preset="select">选择预设</button><button data-deck-preset="save">保存当前音色</button><button data-deck-preset="apply" class="primary">预览并应用</button></div><p class="muted">预设只包含 EQ 与效果器；这里的演示预设不写入 SoundCraft。</p>`,
    };
    if (realModeSelected) {
      const current = controlScope==='AB'?'<b>Deck AB</b> · A → <span data-real-track="A"></span> · B → <span data-real-track="B"></span>':`<b>Deck ${controlScope}</b> → <span data-real-track="${controlScope}"></span>`;
      const playbackLabel = controlScope === 'AB' ? '播放／暂停整个工程' : `播放／暂停 Deck ${controlScope}`;
      const seekLabel = controlScope === 'AB' ? '工程快进／快退' : `Deck ${controlScope} 实时快进／快退`;
      content.presets=`<label>作用对象 <select data-deck-preset-scope aria-label="音色预设作用对象">${['A','B','AB'].map(id=>`<option value="${id}" ${presetScope===id?'selected':''}>Deck ${id}</option>`).join('')}</select></label>
        <p data-preset-summary></p><div data-preset-details></div>
        <div class="row"><button data-deck-preset="select">选择预设</button><button data-deck-preset="save">保存当前音色</button><button data-deck-preset="apply" class="primary">预览并应用</button></div>
        <p class="muted">单轨预设可用于 A／B／AB；双轨预设分别保留两轨参数，只能应用到 AB。选择与预览不改变声音，下看确认后才应用；双眨撤回最近一次真实参数修改。预设保存在当前浏览器中，与眼动档案分开。</p>`;
      content.tracks = `<p><b data-real-project-playing></b> · <span data-real-project-time></span></p>
        <div class="deck-real-waveform-pair">${scopeDecks().map(id=>`<article data-deck-lane="${id}"><b>Deck ${id}</b> · <span data-real-track="${id}"></span><p><span data-real-playing="${id}"></span> · <span data-real-time="${id}"></span></p><div data-real-waveform="${id}"></div></article>`).join('')}</div>
        <p class="muted" data-waveforms-status></p><div class="row"><button data-deck-real-playback class="primary">${playbackLabel}</button><button data-deck-real-seek>打开${seekLabel}</button><button data-deck-refresh-waveforms>刷新素材波形</button><button data-deck-real-song>选择曲目</button></div>
        <p data-real-deck-playback-status role="status"></p><p data-real-deck-seek-status role="status"></p><p data-real-deck-song-status role="status"></p><p class="muted">左看${playbackLabel}，右看打开${seekLabel}。${controlScope === 'AB' ? '下看确认后定位整个工程。' : '下看选择当前工程素材或网页曲库曲目；目标 Deck 保持原播放状态，另一轨继续播放。'}</p>`;
      content.sound = `<p>当前目标：${current}</p><p>${(controlScope==='AB'?['A','B']:[controlScope]).map(id=>`Deck ${id} 音量 <b data-real-volume="${id}"></b>`).join(' · ')}</p><button data-deck-real-volume class="primary">${controlScope==='AB'?'打开 AB 联动音量':'打开当前 Deck 的真实音量滑块'}</button><p class="muted">右看音量 · 左看三段 EQ · 下看真实 Effects。${controlScope==='AB'?'AB 音量实时调节共同 dB 偏移；EQ 先调共同偏移草稿，下看时一起应用，保留两轨原有差值。':''}</p>`;
      content.speed = `<p><b>实际音频变速 · 固定素材循环</b></p><div class="row"><label>目标 <select data-deck-rate-scope aria-label="实际变速目标">${['A','B','AB'].map(id=>`<option value="${id}" ${rateScope===id?'selected':''}>Deck ${id}</option>`).join('')}</select></label><button data-deck-read-rates>刷新实际倍率</button></div><div class="deck-parameters">${['A','B'].map(id=>`<div>Deck ${id}<strong data-real-rate="${id}"></strong><small data-real-calculated-bpm="${id}"></small></div>`).join('')}</div><div class="row">${['A','B'].map(id=>`<label>Deck ${id} 原始 BPM <input data-deck-source-bpm="${id}" aria-label="Deck ${id} 原始 BPM" type="number" min="1" max="999" step="0.1" value="${sourceBpm[id] || ''}" placeholder="手动填写" style="width:85px"></label>`).join('')}<label>AB 共同目标 <input data-deck-match-bpm aria-label="AB 共同目标 BPM" type="number" min="1" max="999" step="0.1" value="${matchBpm || ''}" placeholder="BPM" style="width:85px"></label></div><div class="row"><button data-deck-real-rate class="primary">调节实际速度</button><button data-deck-reset-rate>恢复 1×</button><button data-deck-match-rate>匹配 BPM</button></div><p class="muted" data-real-rate-status></p><p class="muted">0.5–2×，音调随速度变化。AB 调节保持原倍率比例；匹配操作确认后才应用。原始 BPM 是曲目参考，不自动采用工程 BPM。每轨按固定秒数范围独立循环，暂停／继续保留进度；显式定位重设素材位置。新开工程倍率回到 1×。</p><details><summary>工程节拍（与音频倍率分开）</summary><p>工程 BPM <b data-real-tempo></b></p><div class="row"><button data-deck-real-tempo>调整工程 BPM</button><button data-deck-reset-tempo>恢复参考工程 BPM</button></div></details>`;
      content.eq = `<p>当前目标：${current}</p><div class="deck-parameters">${['low','mid','high'].map(band => `<div><button data-deck-real-eq="${band}">${band.toUpperCase()}</button>${(controlScope==='AB'?['A','B']:[controlScope]).map(id=>`<small>Deck ${id}</small><strong data-real-${band}="${id}"></strong>`).join('')}</div>`).join('')}</div>${(controlScope==='AB'?['A','B']:[controlScope]).map(id=>`<p class="muted" data-real-eq-status="${id}"></p>`).join('')}<p class="muted">下看 Low · 左看 Mid · 右看 High；左右视线调节草稿，下看提交后作用于真实音频。${controlScope==='AB'?'共同偏移保留 A/B 增益差，两轨整体校验和应用。':'只控制当前 Deck。'}其他参数与播放时间保持。</p>`;
      content.effects = `<p><b>当前编辑：${effectNames[editedEffect]}</b></p><div class="row"><label>作用目标 <select data-deck-effects-scope aria-label="真实效果器作用目标">${['A','B','AB'].map(id=>`<option value="${id}" ${effectScope===id?'selected':''}>Deck ${id}</option>`).join('')}</select></label><button data-deck-read-effects>刷新效果器状态</button></div><div class="deck-parameters">${(effectScope==='AB'?['A','B']:[effectScope]).map(id=>`<div>Deck ${id}<strong style="font-size:17px" data-real-fx-selected="${id}"></strong><small data-real-fx-summary="${id}"></small></div>`).join('')}</div><div class="row"><button data-deck-toggle-effect class="primary">开启／关闭 ${effectNames[editedEffect]}</button><button data-deck-effect-amount>调节强度</button><button data-deck-next-effect>切换编辑效果器</button></div><p class="muted" data-real-effects-status></p><p class="muted">下看：全部已开启时统一关闭，否则统一开启。左看：强度草稿，下看应用一次；关闭的效果器不会自动开启，尚未添加时请先开启。右看只切换编辑类型，已开启的其他效果保持。AB 参数整批应用，双眨只撤回对应修改，不恢复历史播放时刻。</p>`;
      const labels = {
        tracks: ['返回主界面', controlScope === 'AB' ? '请选择单轨换曲' : '选择曲目', playbackLabel, seekLabel],
        playback: ['返回主界面', '暂不分配', playbackLabel, seekLabel],
        sound: ['返回主界面', 'Effects（真实效果器）', 'EQ（三段真实控制）', '真实音量滑块'],
        speed: ['返回主界面', '匹配另一轨 BPM / AB 共同 BPM', '恢复原速（确认）', '实际音频变速'],
        eq: ['返回声音与效果', 'Low（真实 EQ）', 'Mid（真实 EQ）', 'High（真实 EQ）'],
        effects: ['返回声音与效果', `${effectNames[editedEffect]} 开启 / 关闭`, `${effectNames[editedEffect]} 强度`, '切换编辑效果器'],
      };
      controlLabels = labels[s.page] || controlLabels;
    }
    if(realModeSelected)content.sound+='<button data-deck-open-presets>打开音色预设</button>';
    const showScope=primaryPages.includes(s.page)||['eq','effects','playback'].includes(s.page);
    const showMiniPair=showScope&&s.page!=='tracks';
    q('deckScreen').innerHTML = `<div class="deck-orbit deck-advanced-page" data-advanced-page="${s.page}"><div class="deck-center"><div class="deck-status-line"><span class="pill ${s.observing ? 'warn' : ''}">${s.observing ? '观察模式 · 控制已冻结' : realModeSelected?'真实控制':'网页演示'}</span>${showScope?`<span class="muted">当前控制：Deck ${controlScope}</span>`:''}</div>
      <div class="deck-page-content"><h2>${escape(DECK_PAGES[s.page])}</h2>${realModeSelected ? '<p class="deck-real-status" data-real-mode-status></p>' : ''}${content[s.page]||''}</div>
      ${showMiniPair?`<div class="deck-pair">${deckIds.map(id=>realModeSelected?`<article class="deck-card ${scopeDecks().includes(id)?'active':''}" data-deck-lane="${id}"><b>Deck ${id}</b><strong data-real-track="${id}"></strong><p>音量 <b data-real-volume="${id}"></b></p><p><span data-real-playing="${id}"></span> · <span data-real-time="${id}"></span></p></article>`:demoDeckCard(id,false)).join('')}</div>`:''}</div>
      <div class="deck-controls">${DECK_GESTURES.slice(0, 4).map((g,i)=>{
        const label=controlLabels[i];
        if(label==='暂不分配'||s.page==='setup')return '';
        const unavailable=s.page==='tracks'&&i===1&&(controlScope==='AB'||!realModeSelected&&flow.deck.playing)||!realModeSelected&&s.page==='speed'&&controlScope==='AB'&&i===1;
        const livePlayback = realModeSelected && ['tracks', 'playback'].includes(s.page) && i === 2;
        const realSeek = realModeSelected && ['tracks', 'playback'].includes(s.page) && i === 3;
        const realSong = realModeSelected && s.page === 'tracks' && i === 1;
        return `<button type="button" class="deck-direction deck-direction-${directionSides[i]}" data-deck-command="${g}" aria-label="${g} ${escape(label)}" title="${g}" ${livePlayback ? 'data-deck-real-playback-direction' : ''} ${realSeek ? 'data-deck-real-seek-direction' : ''} ${realSong ? 'data-deck-real-song-direction' : ''} ${s.observing||s.popup||unavailable?'disabled':''}><span>${escape(label)}</span></button>`;
      }).join('')}</div></div>`;
    finishScreenRender();
  }
  function startController() {
    const p = flow.state.popup, e = environment();
    const scale = p ? (p.max - p.min) / 100 : 1;
    const settings = { ...e.sliderSettings, minRatePerSec: (e.sliderSettings.minRatePerSec ?? 5) * scale, maxRatePerSec: (e.sliderSettings.maxRatePerSec ?? 35) * scale };
    popupOwner = p; controller = p && p.mode!=='confirm' && p.max>p.min && e.calibration && e.sliderSettings.enabled && active
      ? new GazeSliderController(e.calibration, settings, { min: p.min, max: p.max, initialValue: p.value }) : null;
    lastFrame = -Infinity;
  }
  function renderPopup(zone = '') {
    const p = flow.state.popup, box = q('deckPopup'), observing = flow.state.observing;
    const changed = popupOwner !== p;
    box.classList.toggle('hidden', !p); if (!p) { controller = null; popupOwner = null; return; }
    if (changed) { popupOpenedAt = performance.now(); startController(); }
    const confirmation=p.mode==='confirm',readout=flow.popupReadout();
    q('deckPopupMode').textContent = `Deck ${p.scope} · ${observing ? '观察模式（已冻结）' : '网页演示'}`;
    q('deckPopupTitle').textContent = p.title;
    q('deckPopupDecks').textContent = p.targets.map(id => {
      const d = flow.state.decks[id], track = flow.tracks[d.track];
      return `Deck ${id}：${track?.name || '无'} · ${d.playing ? '播放' : '暂停'} · ${d.bpm.toFixed(0)} BPM · ${d.volume.toFixed(0)}%`;
    }).join(' ｜ ');
    const index = p.kind === 'track' ? flow.trackIndex(p.value) : p.kind==='presetSelect'?p.value-1:-1;
    const format=(value,unit)=>typeof value==='boolean'?(value?'开启':'关闭'):`${Number(value.toFixed(3))}${unit||''}`;
    q('deckPopupValue').textContent = readout.candidate&&['track','presetSelect'].includes(p.kind)
      ?`${index+1}. ${readout.candidate.name}${p.kind==='presetSelect'?` · ${index+1}/${p.options.length}`:''}`
      :confirmation?readout.summary||'请核对后确认':p.mode==='list'?'暂无兼容预设':`${p.value.toFixed(p.relative==='ratio'?3:1)}${p.unit}`;
    q('deckPopupState').textContent = readout.reason|| (observing?'长眨恢复后继续操作，或手动取消':confirmation?'等待确认':!controller?'可用鼠标或下方手动按键操作；眼动滑块需要左右标尺校准。':zone==='lost'?'画面中断，已停止移动':zone==='left'?'向左调节中':zone==='right'?'向右调节中':'回中央停止');
    const range=q('deckRange');range.classList.toggle('hidden',confirmation);range.min=p.min;range.max=p.max;
    range.step=p.relative==='ratio'?'.001':p.mode==='list'||p.kind==='track'?'1':'.1';range.value=p.value;range.disabled=observing||confirmation||p.max<=p.min;
    deckRangeReadout.setEnabled(!confirmation && p.mode==='range' && p.kind!=='track');
    const naming=p.kind==='presetSave';q('deckPopupNameField').classList.toggle('hidden',!naming);
    const name=q('deckPopupName');if(naming&&name.value!==p.name)name.value=p.name??'';name.disabled=observing;
    const rows=p.kind==='track'?flow.tracks.map((t,i)=>`<li class="${i===index?'selected':''}">${i+1}. ${escape(t.name)} · ${i*20+1}–${(i+1)*20}</li>`)
      :p.kind==='presetSelect'?p.options.map((t,i)=>`<li class="${i===index?'selected':''}">${i+1}. ${escape(t.name)}</li>`)
      :readout.values.map(row=>`<li>Deck ${row.deck}${row.label?` · ${escape(row.label)}`:''}：${escape(format(row.before,row.unit))} → ${escape(format(row.after,row.unit))}</li>`);
    q('deckPopupTracks').innerHTML=rows.join('');
    q('deckPopupInstructions').textContent=confirmation?'上看或双眨取消，下看确认。长眨观察／恢复。':'左右调节，上看恢复打开时的值并停留，下看确认并关闭。双眨取消，长眨观察／恢复。';
    for(const id of ['deckPopupLess','deckPopupMore']){q(id).classList.toggle('hidden',confirmation);q(id).disabled=observing||confirmation||p.max<=p.min;}
    q('deckPopupReset').textContent=confirmation?'上看 · 取消':'上看 · 恢复原值';q('deckPopupReset').disabled=observing;
    q('deckPopupCommit').disabled=observing||!readout.canConfirm;
    if(changed){if(naming)name.focus();else if(confirmation)q('deckPopupCommit').focus();else range.focus();}
  }
  function capturePlaybackPositions() {
    for (const id of ['A', 'B']) {
      const d = flow.state.decks[id], track = flow.tracks[d.track], a = media[id];
      if (track?.url && a.dataset.trackUrl === track.url && a.readyState > 0 && Number.isFinite(a.currentTime)) d.position = a.currentTime;
    }
  }
  function syncMedia({ seekDecks = [], deferPause = false } = {}) {
    if (realModeSelected) return;
    for (const id of ['A', 'B']) {
      const d = flow.state.decks[id], a = media[id], track = flow.tracks[d.track];
      if (a.dataset.trackUrl !== (track?.url || '')) {
        a.pause(); a.dataset.trackUrl = track?.url || '';
        if (track?.url) a.src = track.url; else { a.removeAttribute('src'); a.load(); }
      }
      a.volume = d.volume / 100; a.playbackRate = Math.max(.25, Math.min(4, d.bpm / (track?.bpm || 120))); a.preservesPitch = false;
      if (seekDecks.includes(id) && track?.url && a.readyState > 0) a.currentTime = Math.min(d.position, a.duration || d.position);
      if (!d.playing&&!deferPause) a.pause();
    }
  }
  function demoTransport(gesture,result,source,note){
    const starts=(result.playDecks||[]).filter(id=>flow.state.decks[id].playing&&flow.tracks[flow.state.decks[id].track]?.url&&media[id].paused);
    const seekDecks=result.seekDecks||(result.seekDeck?[result.seekDeck]:[]);
    syncMedia({seekDecks,deferPause:starts.length>0});
    if(!starts.length){record(gesture,note?{...result,message:note+result.message}:result,source);render();return;}
    demoTransportPending=true;
    const owner=flow,ticket=mediaGeneration;
    let timer;
    const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('本地音频未及时开始播放')),6000);});
    const playing=starts.map(id=>{try{return Promise.resolve(media[id].play());}catch(error){return Promise.reject(error);}});
    void Promise.race([Promise.all(playing),timeout]).then(()=>{
      if(owner!==flow||ticket!==mediaGeneration)return;
      syncMedia();record(gesture,note?{...result,message:note+result.message}:result,source);
    },()=>{
      if(owner!==flow||ticket!==mediaGeneration)return;
      const restored=owner.rollbackPlayback(result);
      syncMedia({seekDecks:restored?(result.playbackTransaction?.replay||[]).map(row=>row.deck):[]});
      record(gesture,{...result,executed:false,message:'浏览器未能开始所选音轨，已恢复本次播放状态；可检查音频后用鼠标重试'},source);
    }).finally(()=>{clearTimeout(timer);if(owner===flow&&ticket===mediaGeneration){demoTransportPending=false;if(active)render();}});
  }
  function command(gesture, source = '手动模拟', recognitionNote = '') {
    if (!active) return;
    if (realModeSelected && source === '手动模拟') source = '手动控制';
    if (soundcraft.isAdjusting() || soundcraft.isOpen()) { void soundcraft.gesture(gesture, source, recognitionNote); return; }
    if(demoTransportPending){record(gesture,{executed:false,message:'正在确认本次播放操作，请稍候',from:DECK_PAGES[flow.state.page],to:DECK_PAGES[flow.state.page]},source);return;}
    if(commandNavigation(gesture,source,recognitionNote))return;
    if (realModeSelected && commandReal(gesture, source, recognitionNote)) return;
    capturePlaybackPositions();
    if (gesture === '长眨') popupOpenedAt = performance.now();
    const p = flow.state.popup;
    if(!realModeSelected&&p&&flow.state.observing&&gesture==='双眨'&&source!=='眼动识别'){
      flow.cancelPopup();syncMedia();record(gesture,{executed:true,message:'已手动取消弹窗，观察模式保持',from:DECK_PAGES[flow.state.page],to:DECK_PAGES[flow.state.page]},source);render();return;
    }
    // Classified left/right already drive the continuous controller each frame.
    if (source === '眼动识别' && p && controller && !flow.state.observing && ['左看', '右看'].includes(gesture)) {
      record(gesture, { executed: true, feedback: false, message: `${recognitionNote}弹窗内由连续视线控制滑块，不重复步进`, from: DECK_PAGES[flow.state.page], to: DECK_PAGES[flow.state.page] }, source); return;
    }
    const undo=flow.history.at(-1);
    const seeking=gesture==='下看'&&p?.kind==='seek'?p.targets:gesture==='双眨'&&!p&&undo?.type==='seek'?undo.targets:[];
    if(seeking.some(id=>flow.tracks[flow.state.decks[id].track]?.url&&media[id].readyState<1)){
      record(gesture,{executed:false,message:'所选本地音频尚未就绪，未移动任何播放头',from:DECK_PAGES[flow.state.page],to:DECK_PAGES[flow.state.page]},source);return;
    }
    const result = flow.dispatch(gesture);
    if (flow.state.popup === p && p && controller) {
      controller.value = flow.state.popup.value;
      controller.pause(performance.now());
    }
    if(result.executed&&result.playbackTransaction){demoTransport(gesture,result,source,recognitionNote);return;}
    record(gesture, recognitionNote ? { ...result, message: recognitionNote + result.message } : result, source);
    syncMedia({ seekDecks: result.seekDecks || (result.seekDeck ? [result.seekDeck] : []) }); render();
  }
  function commandNavigation(gesture,source,note){
    const {page,popup,observing}=flow.state;
    if(popup||observing)return false;
    const inHome=page==='home',inner=navigation.state.stage==='inner';
    const choose=inHome&&(DECK_GESTURES.slice(0,4).includes(gesture)||gesture==='双眨'&&inner);
    const up=gesture==='上看';
    const nextPage=up&&[...primaryPages,'playback'].includes(page)?'home'
      :up&&['eq','effects'].includes(page)?'sound':page==='sound'&&gesture==='左看'?'eq':page==='sound'&&gesture==='下看'?'effects':null;
    if(!choose&&!nextPage)return false;
    const from=inHome?(inner?'主界面 · 内圈':'主界面 · 外圈'):DECK_PAGES[page];
    const show=(executed,message,to=from)=>{record(gesture,{executed,message:note+message,from,to},source);};
    if(realModeSelected&&soundcraft.isBusy()){show(false,'正在等待 SoundCraft 回执，请稍候');return true;}
    if(choose){
      const cancel=inner&&['上看','双眨'].includes(gesture);
      if(realModeSelected&&!realReady()&&!cancel){show(false,'真实连接或绑定已失效，请先重新连接');return true;}
      const next=cancel?navigation.back():navigation.dispatch(gesture);
      if(next.route){setControlScope(next.route.scope);flow.navigate(next.route.page);}
      render({navigationOnly:!next.route});show(next.executed,next.message,next.route?DECK_PAGES[next.route.page]:navigation.state.stage==='inner'?'主界面 · 内圈':'主界面 · 外圈');
      if(realModeSelected&&next.route?.page==='speed')void refreshRates();
      return true;
    }
    if(nextPage==='home')returnHome();else flow.navigate(nextPage);
    render();show(true,nextPage==='home'?'返回主界面外圈；播放与参数保持':`进入${DECK_PAGES[nextPage]}`,DECK_PAGES[nextPage]);
    if(realModeSelected&&nextPage==='effects'&&realReady())void refreshEffects();
    return true;
  }
  // The real path never falls through to a demonstration parameter operation.
  function commandReal(gesture, source, note) {
    const result = message => record(gesture, { executed: false, message: note + message, from: DECK_PAGES[flow.state.page], to: DECK_PAGES[flow.state.page] }, source);
    if (soundcraft.isBusy()) { result('正在等待 SoundCraft 回执，请稍候再切换界面或控制状态'); return true; }
    if (gesture === '长眨') return false;
    if(flow.state.page==='presets'&&['下看','左看','右看'].includes(gesture)) {
      if(flow.state.observing){result('观察模式中，请先长眨恢复');return true;}
      void soundcraft.openFormalPreset({下看:'select',左看:'save',右看:'apply'}[gesture],presetScope,source,gesture,note);return true;
    }
    if (flow.state.observing) { result('观察模式中，仅长眨可恢复控制'); return true; }
    const page = flow.state.page;
    if (page==='effects' && gesture==='右看') {
      editedEffect=EFFECTS[(EFFECTS.indexOf(editedEffect)+1)%EFFECTS.length];render();void refreshEffects();
      record(gesture,{executed:true,message:note+`当前编辑 ${effectNames[editedEffect]}；其他效果器保持原状态`,from:DECK_PAGES.effects,to:DECK_PAGES.effects},source);return true;
    }
    if (page === 'tracks' && gesture === '下看') {
      if (!realReady()) result('真实连接或绑定已失效，请重新连接。');
      else void soundcraft.openFormalSong(controlScope, source, gesture, note);
      return true;
    }
    const action = gesture === '双眨' ? 'undo' : page === 'sound' && gesture === '右看' ? 'volume'
      : page === 'eq' && ['下看','左看','右看'].includes(gesture) ? 'eq'
      : page === 'speed' && gesture === '右看' ? 'rate' : page === 'speed' && gesture === '左看' ? 'rateReset'
      : page === 'speed' && gesture === '下看' ? 'rateMatch'
      : page === 'effects' && gesture === '下看' ? 'effectToggle' : page === 'effects' && gesture === '左看' ? 'effectAmount'
      : ['tracks','playback'].includes(page) && gesture === '右看' ? 'seek' : ['tracks','playback'].includes(page) && gesture === '左看' ? 'togglePlayback' : null;
    if (action) {
      if (!realReady()) { result('真实控制连接或绑定已失效，请到 SoundCraft 连接测试重新连接并启用；未切换为演示'); return true; }
      if (action === 'volume') void soundcraft.openFormalVolume(controlScope, source, gesture, note);
      else if (action === 'eq') void soundcraft.openFormalEq(controlScope, {下看:'low',左看:'mid',右看:'high'}[gesture], source, gesture, note);
      else if (action === 'seek') void soundcraft.openFormalSeek(source, gesture, note, controlScope);
      else if (['rate','rateReset','rateMatch'].includes(action)) void openRealRate(action === 'rateReset' ? 'reset' : action === 'rateMatch' ? 'match' : 'rate', source, gesture, note);
      else if (action==='effectToggle') void soundcraft.toggleFormalEffect(effectScope,editedEffect,source,gesture,note);
      else if (action==='effectAmount') void soundcraft.openFormalEffect(effectScope,editedEffect,source,gesture,note);
      else void soundcraft.runFormal(action, source, gesture, note, controlScope);
      return true;
    }
    result('此页面当前方向未分配真实控制');return true;
  }
  for (const id of ['A', 'B']) {
    const a = media[id];
    const currentTrack=()=>{
      const track=flow.tracks[flow.state.decks[id].track];
      return track?.url&&track.url===a.dataset.trackUrl&&(!a.currentSrc||a.currentSrc===track.url)?track:null;
    };
    a.onloadedmetadata = () => {
      const d = flow.state.decks[id];
      const track=currentTrack();if(!track)return;
      if (Number.isFinite(a.duration) && a.duration > 0) {
        Object.assign(track, { duration: a.duration, durationKnown: true });
        d.position = Math.min(d.position, a.duration);
      }
      if(d.position>0)a.currentTime=Math.min(d.position,a.duration||0);
      if(active&&!realModeSelected)render();
    };
    a.onended = () => { if(!currentTrack()||a.ended===false)return;flow.state.decks[id].playing=false;if(active&&!realModeSelected)render(); };
    a.onerror = () => { if(!currentTrack()||a.error===null||demoTransportPending)return;flow.state.decks[id].playing=false;record('音频',{executed:false,message:`Deck ${id} 音频无法读取，请换用有效文件`,from:DECK_PAGES[flow.state.page],to:DECK_PAGES[flow.state.page]},'音频状态');if(active&&!realModeSelected)render(); };
  }
  function completeSetup(demo,fromBoot=false){
    const from=DECK_PAGES[flow.state.page];
    if(fromBoot&&flow.state.page==='boot'&&!flow.navigate('setup'))return;
    const enteringDemo = demo && !realModeSelected;
    if(!flow.completeSetup(enteringDemo))return;
    navigation.reset();setControlScope('A');
    record('进入进阶控制',{executed:true,message:realModeSelected?'已返回真实控制主界面，SoundCraft 连接和播放保持不变':enteringDemo?'已进入新版主界面，可先练习外圈功能与内圈音轨选择':'校准就绪，已进入新版主界面',from,to:DECK_PAGES.home},'助手操作');render();
  }
  root.onclick = e => {
    const button = e.target.closest('button, [data-mix-command]'); if (!button || button.disabled || button.getAttribute?.('aria-disabled')==='true') return;
    if (button.hasAttribute('data-deck-intro-camera')) { onIntroCamera?.(); return; }
    if (button.hasAttribute('data-deck-intro-recognition')) { onIntroRecognition?.(); return; }
    if (button.hasAttribute('data-deck-exit')) {
      if (audioResetPending) {
        record('返回训练', { executed: false, message: '请等待音频恢复完成后再返回训练', from: DECK_PAGES[flow.state.page], to: DECK_PAGES[flow.state.page] }, realModeSelected ? '手动控制' : '手动模拟');
        return;
      }
      onExit?.(); return;
    }
    if (button.hasAttribute('data-deck-back-boot')) {
      const from = DECK_PAGES[flow.state.page];
      if (demoTransportPending || flow.state.popup || soundcraft.isBusy() || soundcraft.isAdjusting()) {
        record('返回启动界面', { executed: false, message: '请先完成当前播放指令或关闭参数弹窗，再返回启动界面', from, to: from }, realModeSelected ? '手动控制' : '手动模拟');
        return;
      }
      flow.state.observing = false;
      navigation.reset();
      flow.navigate('boot');
      q('deckConfigPanel').classList.add('hidden');
      q('deckHistoryPanel').classList.add('hidden');
      render();
      record('返回启动界面', { executed: true, message: realModeSelected ? '已返回启动界面，SoundCraft 连接与播放保持不变' : '已返回启动界面，网页音频播放保持不变', from, to: DECK_PAGES.boot }, realModeSelected ? '手动控制' : '手动模拟');
      return;
    }
    if (button.hasAttribute('data-deck-audio-reset')) { void resetAudioFromToolbar(); return; }
    if(button.hasAttribute('data-deck-start-demo')){completeSetup(true,true);return;}
    if(button.hasAttribute('data-deck-open-presets')) {
      if(flow.state.observing||flow.state.popup||demoTransportPending||soundcraft.isBusy()||soundcraft.isAdjusting()){record('音色预设',{executed:false,message:'请先完成当前操作或退出观察模式',from:DECK_PAGES[flow.state.page],to:DECK_PAGES[flow.state.page]},'手动控制');return;}
      returnHome();command('下看');return;
    }
    if(button.hasAttribute('data-deck-refresh-overview')) {void refreshOverview();return;}
    if(button.hasAttribute('data-deck-refresh-waveforms')) {void refreshWaveforms(true);return;}
    if(button.hasAttribute('data-deck-real-playback')) {command('左看','手动控制');return;}
    if(button.hasAttribute('data-deck-real-song')) {command('下看','手动控制');return;}
    if(button.hasAttribute('data-deck-preset')) {command({select:'下看',save:'左看',apply:'右看'}[button.dataset.deckPreset],'手动控制');return;}
    if (button.hasAttribute('data-deck-soundcraft')) {
      if (demoTransportPending||flow.state.popup||Object.values(media).some(audio => audio.dataset.trackUrl && !audio.paused)) {
        record('SoundCraft 连接测试', { executed: false, message: '请先完成弹窗并暂停网页本地音频，再打开真实连接测试', from: DECK_PAGES[flow.state.page], to: DECK_PAGES[flow.state.page] }, '助手操作'); return;
      }
      if (!soundcraft.isOpen() && soundcraft.open() === false) record('SoundCraft 连接测试', { executed: false, message: '请等待当前 SoundCraft 设置操作完成后再打开连接测试', from: '曲库与设置', to: '曲库与设置' }, '助手操作'); return;
    }
    if (button.hasAttribute('data-deck-real-volume')) { command('右看', '手动控制'); return; }
    if (button.hasAttribute('data-deck-real-seek')) { command('右看', '手动控制'); return; }
    if (button.hasAttribute('data-deck-real-eq')) { const gesture = {low:'下看',mid:'左看',high:'右看'}[button.dataset.deckRealEq]; if (gesture) command(gesture, '手动控制'); return; }
    if (button.hasAttribute('data-deck-real-tempo') || button.hasAttribute('data-deck-reset-tempo')) {
      if (flow.state.observing) { record('工程节拍', {executed:false,message:'观察模式中，请先恢复控制',from:DECK_PAGES[flow.state.page],to:DECK_PAGES[flow.state.page]}, '手动控制'); return; }
      void soundcraft.openFormalTempo('手动控制', '工程节拍', '', button.hasAttribute('data-deck-reset-tempo')); return;
    }
    if (button.hasAttribute('data-deck-read-rates')) { void refreshRates(); return; }
    if (button.hasAttribute('data-deck-real-rate')) { command('右看', '手动控制'); return; }
    if (button.hasAttribute('data-deck-reset-rate')) { command('左看', '手动控制'); return; }
    if (button.hasAttribute('data-deck-match-rate')) { command('下看', '手动控制'); return; }
    if (button.hasAttribute('data-deck-read-effects')) {void refreshEffects();return;}
    if (button.hasAttribute('data-deck-toggle-effect')) {command('下看','手动控制');return;}
    if (button.hasAttribute('data-deck-effect-amount')) {command('左看','手动控制');return;}
    if (button.hasAttribute('data-deck-next-effect')) {command('右看','手动控制');return;}
    if (button.hasAttribute('data-deck-full-loop') || button.hasAttribute('data-deck-cancel-loop')) {
      const enabled = button.hasAttribute('data-deck-full-loop');
      const action = enabled ? '设置全部音轨循环' : '取消全音轨循环';
      button.disabled = true; q('deckFullLoop').disabled = true; q('deckCancelLoop').disabled = true;
      q('deckLoopStatus').textContent = enabled ? '正在读取 SoundCraft 工程并设置固定循环…' : '正在关闭 SoundCraft 循环并解除固定范围…';
      void soundcraft[enabled ? 'enableFullLoop' : 'disableFullLoop']().then(loop => {
        const message = enabled ? `已选中全部 ${loop.trackIds.length} 条音轨；固定循环 0:00–${(loop.end / loop.sampleRate).toFixed(2)} 秒，未自动播放。请到「SoundCraft 连接测试」中播放。`
          : '已取消全音轨循环，并解除网页保存的固定范围；之后网页播放不会再自动恢复循环。独立变速循环同时解除并恢复 1×。未自动播放。';
        q('deckLoopStatus').textContent = message;
        record(action, { executed: true, message, from: '曲库与设置', to: '曲库与设置' }, '助手操作');
      }).catch(error => {
        const message = `${error.message}${error.mayHaveExecuted ? '；部分设置可能已生效，请核对后重新连接，未自动重发' : ''}`;
        q('deckLoopStatus').textContent = message;
        record(action, { executed: false, message, from: '曲库与设置', to: '曲库与设置' }, '助手操作');
      }).finally(() => { button.disabled = false; q('deckFullLoop').disabled = false; q('deckCancelLoop').disabled = false; });
      return;
    }
    for (const [attribute, id] of [['data-deck-settings', 'deckConfigPanel'], ['data-deck-history', 'deckHistoryPanel']]) {
      if (button.hasAttribute(attribute)) {
        const panel = q(id);
        const opening = panel.classList.contains('hidden');
        panel.classList.toggle('hidden', !opening);
        if (opening && id === 'deckConfigPanel') void songCatalog.read();
        return;
      }
    }
    if (button.dataset.deckCommand) command(button.dataset.deckCommand);
    if (button.hasAttribute('data-deck-complete')) {
      const demo = button.dataset.deckComplete === 'demo';
      if (!demo) { renderEnvironment(); if (button.disabled) return; }
      completeSetup(demo);return;
    }
    if (button.hasAttribute('data-deck-reset')) {
      if(realModeSelected)return;
      mediaGeneration++;demoTransportPending=false;flow.cancelPopup();
      for (const a of Object.values(media)) a.pause();
      const library=flow.tracks;flow=new GazeDeckAdvancedDemo();flow.setTracks(library);navigation.reset();setControlScope('A');decision.lastFireT=-Infinity;
      record('重置流程', { executed: true, message: '已回到启动界面，眼动档案未改变', from: '原界面', to: DECK_PAGES.boot }, '助手操作'); render(); syncMedia({ seekDecks: ['A', 'B'] });
    }
  };
  root.oninput = e => {
    const p=flow.state.popup;if(!p)return;
    if(e.target.id==='deckPopupName'){flow.setPopupName(e.target.value);renderPopup();return;}
    if(e.target.id!=='deckRange'||p.mode==='confirm')return;
    flow.setPopupValue(Number(e.target.value));if(controller){controller.value=p.value;controller.pause(performance.now());}
    if(['volume','bpm'].includes(p.kind))syncMedia();
    renderPopup();
  };
  root.onchange = async e => {
    if(e.target.hasAttribute?.('data-deck-preset-scope')) {
      if(!soundcraft.isAdjusting()&&!soundcraft.isBusy()&&!flow.state.observing&&['A','B','AB'].includes(e.target.value)){setControlScope(e.target.value);render();}
      else e.target.value=presetScope;
      return;
    }
    if (e.target.hasAttribute?.('data-deck-effects-scope')) {
      if (!soundcraft.isAdjusting() && !soundcraft.isBusy() && !flow.state.observing && ['A','B','AB'].includes(e.target.value)) {
        setControlScope(e.target.value);render();void refreshEffects();
      } else e.target.value=effectScope;
      return;
    }
    if (e.target.hasAttribute?.('data-deck-rate-scope')) {
      if (!soundcraft.isAdjusting() && !soundcraft.isBusy() && !flow.state.observing && ['A','B','AB'].includes(e.target.value)) { setControlScope(e.target.value); render(); }
      else e.target.value=rateScope;
      return;
    }
    if (e.target.hasAttribute?.('data-deck-source-bpm') || e.target.hasAttribute?.('data-deck-match-bpm')) {
      if (soundcraft.isAdjusting() || soundcraft.isBusy() || flow.state.observing) return;
      const value = Number(e.target.value), valid = Number.isFinite(value) && value > 0 && value <= 999;
      if (e.target.dataset.deckSourceBpm === 'A' || e.target.dataset.deckSourceBpm === 'B') sourceBpm[e.target.dataset.deckSourceBpm] = valid ? value : null;
      else matchBpm = valid ? value : null;
      renderRealReadouts(); return;
    }
    const binding = e.target.dataset.deckBinding;
    if (binding) {
      const value = e.target.value;
      for (const key of DECK_GESTURES) if (key !== binding && value && mapping[key] === value) mapping[key] = '';
      mapping[binding] = value; renderBindings(); renderEnvironment(); return;
    }
    if (e.target.hasAttribute('data-deck-bpm') && !flow.state.observing) {
      if (realModeSelected||demoTransportPending) return;
      const index = Number(e.target.dataset.deckBpm), value = Number(e.target.value);
      if(flow.setTrackBpm(index,value))syncMedia();
      render(); return;
    }
    if (e.target.id !== 'deckFiles') return;
    if (realModeSelected) return;
    const files = [...e.target.files]; e.target.value = ''; if (!files.length) return;
    if (flow.state.popup||flow.state.observing||demoTransportPending) { record('导入音频', { executed: false, message: '请先完成当前操作或退出观察模式，再替换曲目', from: DECK_PAGES[flow.state.page], to: DECK_PAGES[flow.state.page] }, '助手操作'); return; }
    mediaGeneration++;const ticket=++libraryGeneration;
    libraryAnalysis?.abort();libraryAnalysis=new AbortController();
    const signal=libraryAnalysis.signal;
    const old = flow.tracks;
    for (const a of Object.values(media)) { a.pause(); a.removeAttribute('src'); a.dataset.trackUrl = ''; a.load(); }
    const imported=files.slice(0,5);
    flow.setTracks(imported.map(file=>({name:file.name,url:URL.createObjectURL(file),duration:240,durationKnown:false,bpm:120,bpmKnown:false,key:'—',demo:false,waveformPending:true})));
    for (const t of old) if (t.url) URL.revokeObjectURL(t.url);
    record('导入音频', { executed: true, message: `已载入 ${flow.tracks.length} 首${files.length > 5 ? '（超出 5 首的未添加）' : ''}，请填写原始 BPM；未分析调性`, from: DECK_PAGES[flow.state.page], to: DECK_PAGES[flow.state.page] }, '助手操作'); syncMedia(); render();
    imported.forEach((file,index)=>{
      const track=flow.tracks[index];
      void readLocalWaveform(file,{signal}).then(waveform=>{
        if(ticket!==libraryGeneration||signal.aborted)return;
        track.waveform=waveform;
        if(waveform&&track.durationKnown===false){track.duration=waveform.durationSeconds;track.durationKnown=true;}
      }).catch(()=>{}).finally(()=>{
        if(ticket!==libraryGeneration||signal.aborted)return;
        track.waveformPending=false;
        if(active&&!realModeSelected&&!flow.state.popup&&['home','tracks'].includes(flow.state.page))render();
      });
    });
  };
  root.addEventListener('keydown', e => {
    const zone=e.target.closest?.('[data-mix-command]');
    if(zone&&['Enter',' '].includes(e.key)&&zone.getAttribute('aria-disabled')!=='true'){
      e.preventDefault();command(zone.dataset.deckCommand);return;
    }
    // The console remains usable while the non-modal slider is open.
    if(!flow.state.popup)return;
    if (e.key === 'Escape') { e.preventDefault(); command('双眨'); }
    if (e.key === 'Enter' && ['deckRange','deckPopupName'].includes(e.target.id)) { e.preventDefault(); command('下看'); }
  });
  // Only transport UI updates on the timer; navigation never depends on this timer.
  setInterval(() => {
    if (!active) return;
    if (soundcraft.hasSession()) soundcraft.tick();
    if (soundcraft.isOpen()) return;
    if (realModeSelected) {
      if(['home','tracks'].includes(flow.state.page)&&performance.now()-lastWaveformRead>=10000)void refreshWaveforms();
      renderEnvironment();return;
    }
    for (const id of ['A', 'B']) {
      const d = flow.state.decks[id], track = flow.tracks[d.track], a = media[id];
      if (d.playing) d.position = track?.demo ? Math.min(track.duration, d.position + .25 * d.bpm / track.bpm) : a.currentTime || 0;
      if (d.position >= (track?.duration || 240) && d.playing) { d.playing = false; render(); }
      root.querySelectorAll(`[data-deck-time="${id}"]`).forEach(el => { el.textContent = `${clock(d.position)} / ${trackDuration(track)}`; });
      const bar = root.querySelector(`[data-deck-progress="${id}"]`); if (bar) bar.style.width = `${100 * d.position / (track?.duration || 240)}%`;
    }
    updateSvgReadouts();updateDemoWaveformMarkers(root,flow.state.decks);renderEnvironment();
    if (flow.state.popup && !flow.state.observing && performance.now() - popupOpenedAt > 60000) {
      // Never silently commit an abandoned popup.
      flow.cancelPopup();syncMedia();record('弹窗超时', { executed: false, message: '已放弃未保存的调节', from: DECK_PAGES[flow.state.page], to: DECK_PAGES[flow.state.page] }, '系统'); render();
    }
    if (controller && performance.now() - lastFrame > 700) { controller.pause(performance.now()); renderPopup('lost'); }
  }, 250);
  renderBindings(); render();
  return {
    isAdjusting: () => !!flow.state.popup || soundcraft.isAdjusting(),
    setQuickBindings(enabled) {
      if (enabled && !personalMappingBeforeQuick) {
        personalMappingBeforeQuick = { ...mapping };
        mapping = Object.fromEntries(DECK_GESTURES.map(g => [g, g]));
      } else if (!enabled && personalMappingBeforeQuick) {
        mapping = personalMappingBeforeQuick;
        personalMappingBeforeQuick = null;
      }
    },
    setActive(value) {
      if (active === value) return;
      const wasReal=realModeSelected;
      let resumed = false;
      if (value) {
        resumed = connectionHoldDeadline > performance.now()
          && soundcraft.getSession().formalEnabled && soundcraft.getSession().connected;
        clearConnectionHold();
        if (!resumed) soundcraft.close(true);
      } else {
        songCatalog.stop();
        const retain = realModeSelected && soundcraft.getSession().formalEnabled && soundcraft.getSession().connected;
        soundcraft.close(true, retain);
        if (retain) holdConnection();
        else { clearConnectionHold(); realModeSelected = false; }
      }
      flow.cancelPopup();flow.state.observing=false;
      if(wasReal)flow.navigate('home');
      navigation.reset();setControlScope('A');
      capturePlaybackPositions();if(!demoTransportPending)syncMedia();
      onActive?.(value);
      active = value; flow.state.popup = null; controller = null; popupOwner = null; decision.lastFireT = -Infinity;
      q('deckConfigPanel').classList.toggle('hidden', true); q('deckHistoryPanel').classList.toggle('hidden', true);
      q('deckSuccessGlow').classList.toggle('is-pulsing', false); feedbackZone = 'center'; lastGlowAt = -Infinity;
      // Leaving/re-entering a page is navigation, not a transport command.
      renderBindings(); render();
      if (resumed) soundcraft.resumeFormal();
    },
    resetForUser() {
      mediaGeneration++;demoTransportPending=false;flow.cancelPopup();
      songCatalog.stop();
      clearConnectionHold();
      soundcraft.close(true);
      realModeSelected = false;
      for (const a of Object.values(media)) { a.pause(); a.removeAttribute('src'); a.dataset.trackUrl = ''; a.load(); }
      const library=flow.tracks;flow=new GazeDeckAdvancedDemo();flow.setTracks(library);navigation.reset();setControlScope('A');events.length=0;
      mapping = Object.fromEntries(DECK_GESTURES.map(g => [g, g])); decision.lastFireT = -Infinity;
      personalMappingBeforeQuick = null;
      q('deckEvents').replaceChildren(); q('deckLastAction').textContent = '用户已切换，控制流程已重置，曲目保留。'; renderBindings(); render();
    },
    prediction(p, t) {
      if (!active) return;
      const e = environment();
      Object.assign(decision.settings, e.engineSettings);
      const inverse = Object.fromEntries(Object.entries(mapping).filter(([, label]) => label).map(([command, label]) => [label, command]));
      const useGuess = e.useClosestGuess === true && p.label === UNKNOWN_LABEL
        && typeof p.guess === 'string' && p.guess.length > 0 && p.guess !== UNKNOWN_LABEL;
      // Opt in only at the DJ boundary; preserve the classifier's original result for evaluation.
      const candidate = useGuess ? { ...p, label: p.guess } : p;
      const description = p.label === UNKNOWN_LABEL && p.guess ? `未知（最像「${p.guess}」）` : p.label;
      const d = decision.decide(candidate, inverse, t);
      if (d.fired) command(d.action, '眼动识别', useGuess ? `${description}，按最像动作处理；` : '');
      else record(description, { executed: false, message: d.reason, from: DECK_PAGES[flow.state.page], to: DECK_PAGES[flow.state.page] }, '眼动识别');
    },
    frame(raw, t) {
      if (active && soundcraft.hasSession()) soundcraft.frame(raw, t);
      if (soundcraft.isOpen() || soundcraft.isAdjusting() || realModeSelected) return;
      if (!active || !controller || !flow.state.popup) return;
      if (!raw || flow.state.observing) { controller.pause(t); renderPopup(raw ? '' : 'lost'); return; }
      lastFrame = performance.now();
      const popup=flow.state.popup,prior=popup.value,snapshot=controller.updateFrame(raw,t);flow.setPopupValue(snapshot.value);
      if(popup.value!==prior&&['volume','bpm'].includes(popup.kind))syncMedia();
      const moving = Math.abs(snapshot.delta) > 0 && ['left', 'right'].includes(snapshot.zone);
      if (moving && feedbackZone !== snapshot.zone) pulseSuccess(snapshot.zone === 'left' ? '左看' : '右看');
      feedbackZone = snapshot.zone;
      if (t - lastRender > 80) { lastRender = t; renderPopup(snapshot.zone); }
    },
  };
}

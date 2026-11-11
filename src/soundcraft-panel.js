import { SoundCraftClient, eqTarget } from './soundcraft-client.js';
import { mountSoundCraftVolume } from './soundcraft-volume.js';
import { mountSoundCraftSeek } from './soundcraft-seek.js';
import { mountSoundCraftTempo } from './soundcraft-tempo.js';
import { mountSoundCraftEq } from './soundcraft-eq.js';
import { SoundCraftRateClient, appliedTrackRate } from './soundcraft-rate-client.js';
import { mountSoundCraftRate } from './soundcraft-rate.js';
import { SoundCraftEffectsClient, effectTarget, EFFECTS } from './soundcraft-effects-client.js';
import { mountSoundCraftEffects } from './soundcraft-effects.js';
import { SoundCraftPresetsClient } from './soundcraft-presets-client.js';
import { mountSoundCraftPresets } from './soundcraft-presets.js';
import { SoundCraftLevelsClient } from './soundcraft-levels-client.js';
import { mountSoundCraftLinkedVolume } from './soundcraft-linked-volume.js';
import { mountSoundCraftLinkedEq } from './soundcraft-linked-eq.js';
import { SoundCraftWaveformsClient } from './soundcraft-waveforms-client.js';
import { SoundCraftDeckPlaybackClient } from './soundcraft-deck-playback-client.js';
import { mountSoundCraftSongPicker, SoundCraftSongLibrary, mergeSongCandidates, songNameKey } from './soundcraft-songs.js';

const escape = text => String(text ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const page = 'SoundCraft 连接测试';
const clock = seconds => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

// A small real-engine test surface, independent of the still-evolving DJ page flow.
export function mountSoundCraftPanel(root, { environment, onResult, onVisibility, popupRoot, seekPopupRoot, tempoPopupRoot, eqPopupRoot, ratePopupRoot, rateClient, effectsPopupRoot, effectsClient, presetsPopupRoot, presetsClient, presetStore, linkedVolumePopupRoot, linkedEqPopupRoot, levelsClient, waveformsClient, deckPlaybackClient, songPopupRoot, songLibrary, onSongLoaded, onSessionChange, onFormalMode, onVolumeClose, client = new SoundCraftClient() }) {
  let opened = false, eyes = false, observing = false, selected = '', pending = false;
  let generation = 0, lastPoll = -Infinity, lastFace = -Infinity;
  let status = '请先连接并读取 SoundCraft 工程。', history = [], drafting = false, trackOptions = '';
  let formalEnabled = false, boundProjectKey = null, bindings = { A: '', B: '' }, bindingOptions = '';
  let initialized = false, publishedSession = '';
  let tempoReference = null;
  let refreshWork = null, waveformWork = null;
  let checkingConnection = false, recoveryRevision = 0, connectionIssue = '';
  const rates = rateClient || new SoundCraftRateClient(client);
  const fx = effectsClient || new SoundCraftEffectsClient(client);
  const tones = presetsClient || new SoundCraftPresetsClient(client);
  const levels = levelsClient || new SoundCraftLevelsClient(client);
  const waveforms = waveformsClient || new SoundCraftWaveformsClient(client);
  const deckPlayback = deckPlaybackClient || new SoundCraftDeckPlaybackClient(client);
  const songs = songLibrary || new SoundCraftSongLibrary(client.fetchImpl);
  const effectNames = {reverb:'混响',delay:'延迟',chorus:'合唱'};
  const q = id => root.querySelector(`#${id}`);
  root.innerHTML = `
    <div class="sc-title"><div><span class="eyebrow">独立连接测试</span><h2>SoundCraft 真实控制</h2></div><button id="scClose">返回进阶界面</button></div>
    <p class="hint">支持工程播放／暂停、指定轨道音量与三段 EQ，以及眼动音量与相对快进／快退弹窗。播放／暂停与定位作用于整个 SoundCraft 工程，A/B 共用播放头。本区真实控制与网页演示分开。</p>
    <div class="row"><button id="scConnect" class="primary">连接／重新连接</button><button id="scRefresh">刷新状态</button><strong id="scConnection" role="status"></strong></div>
    <div id="scProject" class="sc-project"></div>
    <div class="sc-formal"><h3>进阶页真实控制</h3><p class="hint">将 Deck A、Deck B 绑定到两条不同的真实音轨。进阶页选择 A 或 B 可独立播放／暂停和实时快进／快退。选择 AB 可控制工程播放与定位。</p>
    <div class="row"><label>Deck A <select id="scBindA" aria-label="Deck A 对应的真实轨道"></select></label><label>Deck B <select id="scBindB" aria-label="Deck B 对应的真实轨道"></select></label></div>
    <div class="row"><button id="scEnableFormal" class="primary">启用进阶页真实控制</button><button id="scDemoMode">返回网页演示模式</button><strong id="scFormalState" role="status"></strong></div></div>
    <div class="row"><label>音量目标轨道 <select id="scTrack" aria-label="SoundCraft 音量目标轨道"></select></label><span id="scActualVolume"></span></div>
    <div class="row sc-actions"><button id="scPlay">播放整个工程</button><button id="scPause">暂停整个工程</button><button id="scVolumeDown">所选轨道 −1 dB</button><button id="scVolumeUp">所选轨道 +1 dB</button><button id="scUndo">撤回上一次参数修改</button></div>
    <button id="scOpenLiveVolume" class="primary">打开连续眼动音量滑块</button>
    <button id="scOpenSeek">打开快进／快退弹窗</button>
    <button id="scOpenTempo">打开工程 BPM 弹窗</button><p id="scTempoReadout" role="status"></p><p class="muted">工程 BPM 由 A/B 共用；当前只调整工程节拍，不自动拉伸 WAV 或改变音频片段的播放速度。</p>
    <div class="row"><button id="scOpenEqLow">调节 Low</button><button id="scOpenEqMid">调节 Mid</button><button id="scOpenEqHigh">调节 High</button></div><p id="scEqReadout" role="status"></p>
    <div class="row"><button id="scOpenRate">调节所选轨道实际速度</button><button id="scReadRate">刷新变速状态</button></div><p id="scRateReadout" role="status"></p>
    <div class="row"><label>效果器 <select id="scFxType" aria-label="连接测试效果器"><option value="reverb">混响</option><option value="delay">延迟</option><option value="chorus">合唱</option></select></label><button id="scReadFx">刷新效果器状态</button><button id="scToggleFx">开启／关闭所选效果器</button><button id="scOpenFx">调节效果强度</button></div><p id="scFxReadout" role="status"></p>
    <label for="scVolume">所选轨道音量（松开滑块应用）</label><div class="row sc-volume"><input id="scVolume" type="range" min="-144" max="12" step="1"><output id="scVolumeDraft"></output></div>
    <div class="sc-eye"><label><input id="scEyes" type="checkbox"> 开启本区眼动真实控制（每次进入需重新开启）</label><button id="scObserve">进入观察模式</button><strong id="scEyeState"></strong>
    <p>本区指令：上看＝播放整个工程；下看＝暂停整个工程；左／右看＝唤出所选轨道的连续音量滑块。弹窗内左右连续调节、回中停止，上看恢复原值，下看保留并关闭。长眨观察／恢复，双眨放弃本次调节。保留原有动作绑定、拒识与冷却规则。</p></div>
    <p id="scStatus" class="sc-result" role="status" aria-live="polite"></p>
    <p class="muted">以下为 SoundCraft 实际回读数据。返回界面只停止本区眼动控制，不暂停工程；切换工程或连接失败后需重新连接。不会自动播放，不修改眼动样本。</p>
    ${popupRoot ? '' : '<div id="scVolumePopup" class="sc-volume-popup hidden" role="dialog" aria-modal="true" aria-label="SoundCraft 连续音量弹窗"></div>'}
    ${seekPopupRoot ? '' : '<div id="scSeekPopup" class="sc-volume-popup hidden" role="dialog" aria-modal="true" aria-label="SoundCraft 快进快退弹窗"></div>'}
    ${tempoPopupRoot ? '' : '<div id="scTempoPopup" class="sc-volume-popup hidden" role="dialog" aria-modal="true" aria-label="SoundCraft 工程 BPM 弹窗"></div>'}
    ${eqPopupRoot ? '' : '<div id="scEqPopup" class="sc-volume-popup hidden" role="dialog" aria-modal="true" aria-label="SoundCraft 三段 EQ 弹窗"></div>'}
    ${ratePopupRoot ? '' : '<div id="scRatePopup" class="sc-volume-popup hidden" role="dialog" aria-modal="true" aria-label="SoundCraft 真实变速弹窗"></div>'}
    ${effectsPopupRoot ? '' : '<div id="scEffectsPopup" class="sc-volume-popup hidden" role="dialog" aria-modal="true" aria-label="SoundCraft 效果强度弹窗"></div>'}
    ${presetsPopupRoot ? '' : '<div id="scPresetsPopup" class="sc-volume-popup hidden" role="dialog" aria-modal="true" aria-label="SoundCraft 音色预设弹窗"></div>'}
    ${linkedVolumePopupRoot ? '' : '<div id="scLinkedVolumePopup" class="sc-volume-popup hidden" role="dialog" aria-modal="true" aria-label="SoundCraft AB 联动音量"></div>'}
    ${linkedEqPopupRoot ? '' : '<div id="scLinkedEqPopup" class="sc-volume-popup hidden" role="dialog" aria-modal="true" aria-label="SoundCraft AB 联动 EQ"></div>'}
    ${songPopupRoot ? '' : '<div id="scSongPopup" class="sc-volume-popup hidden" role="dialog" aria-modal="true" aria-label="SoundCraft 选曲"></div>'}`;

  const volume = mountSoundCraftVolume(popupRoot || q('scVolumePopup'), {client, environment, eyesEnabled: () => eyes || formalEnabled,
    onEnableEyes: () => {
      // This is an explicit user action inside the modal, not an automatic opt-in.
      if (!client.connected) return;
      eyes = true; status = '本区眼动真实控制已开启；音量弹窗沿用当前摄像头与左右标尺校准。'; render();
    },
    onResult: (gesture, result, source) => { status = result.message; onResult?.(gesture, result, source); render(); },
    onError: () => { eyes = false; disarm(); render(); },
    onState: (visible, s) => {
      if (!visible && s?.committed && s.ownsFinal && Math.abs(s.confirmed - s.original) > .02) {
        history.push({type:'volume',projectKey:s.projectKey,trackId:s.trackId,before:s.original,after:s.confirmed});
        if (history.length > 20) history.shift();
      }
      lastPoll = performance.now(); render();
      if (!visible) { if (opened) q('scOpenLiveVolume').focus?.(); else onVolumeClose?.(); }
    },
  });

  const seek = mountSoundCraftSeek(seekPopupRoot || q('scSeekPopup'), {client, environment, eyesEnabled: () => eyes || formalEnabled,
    onEnableEyes: () => { if (client.connected) { eyes = true; render(); } },
    onResult: (gesture, result, source) => { status = result.message; onResult?.(gesture, result, source); render(); },
    onError: () => { eyes = false; disarm(); render(); },
    onUpdate: () => notifySession(),
    onState: (visible, s) => {
      if (!visible && s?.committed && s.live && Math.abs(s.applied) >= .0001) {
        history.push({type:'deck-seek', projectKey:s.projectKey, live:s.live.target, deltaSeconds:s.applied,
          sampleRate:client.snapshot.sampleRate, durationSeconds:client.snapshot.durationSeconds});
        if (history.length > 20) history.shift();
      } else if (!visible && s?.committed && s.result && Math.abs(s.result.deltaSeconds) > .0001) {
        history.push({type:'seek',projectKey:s.projectKey,deltaSeconds:s.result.deltaSeconds,
          sampleRate:s.result.snapshot.sampleRate,durationSeconds:s.result.snapshot.durationSeconds});
        if (history.length > 20) history.shift();
      }
      lastPoll = performance.now(); render();
      if (!visible) { if (opened) q('scOpenSeek').focus?.(); else onVolumeClose?.(); }
    },
  });
  const tempo = mountSoundCraftTempo(tempoPopupRoot || q('scTempoPopup'), {client, environment, eyesEnabled: () => eyes || formalEnabled,
    onEnableEyes: () => { if (client.connected) { eyes = true; render(); } },
    onResult: (gesture, result, source) => { status = result.message; onResult?.(gesture, result, source); render(); },
    onError: () => { eyes = false; disarm(); render(); },
    onState: (visible, s) => {
      if (!visible && s?.committed && s.result?.changed) {
        history.push({type:'tempo',projectKey:s.projectKey,before:s.result.beforeBpm,after:s.result.afterBpm,
          afterMapKey:s.result.snapshot.tempoMapKey});
        if (history.length > 20) history.shift();
      }
      lastPoll = performance.now(); render();
      if (!visible) { if (opened) q('scOpenTempo').focus?.(); else onVolumeClose?.(s?.reset ? 'tempo-reset' : 'tempo'); }
    },
  });
  const eq = mountSoundCraftEq(eqPopupRoot || q('scEqPopup'), {client, environment, eyesEnabled: () => eyes || formalEnabled,
    onEnableEyes: () => { if (client.connected) { eyes = true; render(); } },
    onResult: (gesture, result, source) => { status = result.message; onResult?.(gesture, result, source); render(); },
    onError: () => { eyes = false; disarm(); render(); },
    onState: (visible, s) => {
      if (!visible && s?.committed && s.result?.changed) {
        history.push({type:'eq',projectKey:s.projectKey,trackId:s.trackId,band:s.band,slot:s.slot,
          before:s.result.beforeDb,created:s.result.created,afterInsert:s.result.insert});
        if (history.length > 20) history.shift();
      }
      lastPoll = performance.now(); render();
      if (!visible) { if (opened) q({low:'scOpenEqLow',mid:'scOpenEqMid',high:'scOpenEqHigh'}[s?.band] || 'scOpenEqLow').focus?.(); else onVolumeClose?.(`eq-${s?.band || 'high'}`); }
    },
  });
  const rate = mountSoundCraftRate(ratePopupRoot || q('scRatePopup'), {client,rates,environment,eyesEnabled:()=>eyes || formalEnabled,
    onEnableEyes:()=>{if(client.connected){eyes=true;render();}},
    onResult:(gesture,result,source)=>{status=result.message;onResult?.(gesture,result,source);render();},
    onError:()=>{eyes=false;disarm();render();},
    onState:(visible,s)=>{
      if(!visible && s?.committed && s.ownsFinal && s.confirmedTargets?.some(target=>Math.abs(target.rate-s.originalTargets.find(item=>item.track===target.track).rate)>.000001)) {
        history.push({type:'rate',projectKey:s.projectKey,epoch:s.epoch,loop:s.loop,before:s.originalTargets,expected:s.resultSnapshot});
        if(history.length>20)history.shift();
      }
      lastPoll=performance.now();render();
      if(!visible){if(opened)q('scOpenRate').focus?.();else onVolumeClose?.('rate');}
    },
  });
  function rememberEffect(result) {
    if (!result?.changed) return;
    history.push({type:'effects',projectKey:result.projectKey,effect:result.effect,before:result.previous,expected:result});
    if (history.length > 20) history.shift();
  }
  const fxPopup = mountSoundCraftEffects(effectsPopupRoot || q('scEffectsPopup'), {client,effects:fx,environment,eyesEnabled:()=>eyes || formalEnabled,
    onEnableEyes:()=>{if(client.connected){eyes=true;render();}},
    onResult:(gesture,result,source)=>{status=result.message;onResult?.(gesture,result,source);render();},
    onError:()=>{eyes=false;disarm();render();},
    onState:(visible,s)=>{
      if (!visible && s?.committed) rememberEffect(s.result);
      lastPoll=performance.now(); render();
      if(!visible){if(opened)q('scOpenFx').focus?.();else onVolumeClose?.('effects');}
    },
  });
  const presetsPopup = mountSoundCraftPresets(presetsPopupRoot || q('scPresetsPopup'), {client,tones,environment,store:presetStore,eyesEnabled:()=>formalEnabled,
    onResult:(gesture,result,source)=>{status=result.message;onResult?.(gesture,result,source);render();},
    onError:()=>{disarm();render();},
    onState:(visible,s)=>{
      if(!visible&&s?.committed&&s.result?.receipt) {
        history.push({type:'tone',projectKey:s.result.projectKey,receipt:s.result.receipt,expected:s.result});
        if(history.length>20)history.shift();
        fx.snapshot=null;
      }
      lastPoll=performance.now();render();
      if(!visible)onVolumeClose?.('presets');
    },
  });
  const linkedVolume=mountSoundCraftLinkedVolume(linkedVolumePopupRoot||q('scLinkedVolumePopup'),{client,levels,environment,eyesEnabled:()=>formalEnabled,
    onResult:(gesture,result,source)=>{status=result.message;onResult?.(gesture,result,source);render();},
    onError:()=>{eyes=false;disarm();render();},
    onState:(visible,s)=>{if(!visible&&s?.committed&&s.receipt){history.push({type:'levels',projectKey:s.projectKey,receipt:s.receipt,expected:s.resultSnapshot});if(history.length>20)history.shift();}
      lastPoll=performance.now();render();if(!visible)onVolumeClose?.('linked-volume');},
  });
  const linkedEq=mountSoundCraftLinkedEq(linkedEqPopupRoot||q('scLinkedEqPopup'),{client,tones,environment,eyesEnabled:()=>formalEnabled,
    onResult:(gesture,result,source)=>{status=result.message;onResult?.(gesture,result,source);render();},
    onError:()=>{eyes=false;disarm();render();},
    onState:(visible,s)=>{if(!visible&&s?.committed&&s.result?.receipt){history.push({type:'tone',kind:'linked-eq',band:s.band,projectKey:s.result.projectKey,receipt:s.result.receipt,expected:s.result});if(history.length>20)history.shift();fx.snapshot=null;}
      lastPoll=performance.now();render();if(!visible)onVolumeClose?.(`eq-${s?.band||'high'}`);},
  });
  const songPopup = mountSoundCraftSongPicker(songPopupRoot || q('scSongPopup'), {
    load: loadFormalSong,
    readiness: songIssue,
    environment,
    eyeReady: () => formalEnabled && eyeReady(true),
    onResult: report,
    onClose: () => { lastPoll = -Infinity; render(); onVolumeClose?.('song'); },
  });
  function adjusting() { return volume.isOpen() || seek.isOpen() || tempo.isOpen() || eq.isOpen() || rate.isOpen() || fxPopup.isOpen() || presetsPopup.isOpen() || linkedVolume.isOpen() || linkedEq.isOpen() || songPopup.isOpen(); }

  function target() { return client.snapshot?.tracks.find(track => String(track.id) === selected); }
  function rememberTempo() {
    const snapshot = client.snapshot;
    tempoReference = snapshot?.tempoSupported && Number.isFinite(snapshot.tempoBpm)
      ? {projectKey:snapshot.projectKey,bpm:snapshot.tempoBpm} : null;
  }
  function disarm() {
    formalEnabled = false; boundProjectKey = null; checkingConnection = false;
    deckPlayback.reset();
  }
  function getSession() {
    return {snapshot:client.snapshot, connected:!!client.connected, formalEnabled, checkingConnection, connectionIssue,
      busy:pending || !!client.busy || adjusting(),
      rateSnapshot:rates.snapshot,
      effectsSnapshot:fx.snapshot,
      toneSnapshot:tones.snapshot, presetSummary:presetsPopup.summary(),
      levelsSnapshot:levels.snapshot,
      waveformsSnapshot:waveforms.snapshot,
      deckPlaybackSnapshot:deckPlayback.snapshot,
      deckPlaybackUnsupported:deckPlayback.unsupported(),
      deckPlaybackMessage:deckPlayback.message,
      tempoReferenceBpm:tempoReference && tempoReference.projectKey === client.snapshot?.projectKey ? tempoReference.bpm : null,
      bindings:{A:bindings.A === '' ? null : Number(bindings.A), B:bindings.B === '' ? null : Number(bindings.B)}};
  }
  function notifySession() {
    if (!initialized) return;
    const session = getSession(), signature = JSON.stringify(session);
    if (signature !== publishedSession) { publishedSession = signature; onSessionChange?.(session); }
  }
  function validBindings(snapshot = client.snapshot) {
    const tracks = snapshot?.tracks || [];
    return bindings.A !== '' && bindings.B !== '' && bindings.A !== bindings.B
      && ['A', 'B'].every(deck => tracks.some(track => String(track.id) === bindings[deck]));
  }
  function formalReady() {
    return formalEnabled && client.connected && client.snapshot?.projectKey === boundProjectKey && validBindings();
  }
  function hasSession() { return formalEnabled || opened || adjusting(); }
  function eyeReady(needsSlider = false) {
    const e = environment();
    return !!e.camera && !!e.baseline && performance.now() - lastFace <= 750
      && (!needsSlider || (!!e.calibration && e.sliderSettings?.enabled !== false));
  }
  function render() {
    const snapshot = client.snapshot, connected = client.connected, busy = pending || client.busy || adjusting();
    if (!connected) eyes = false;
    if (formalEnabled && (!connected || snapshot?.projectKey !== boundProjectKey || !validBindings(snapshot))) disarm();
    const tracks = snapshot?.tracks ?? [];
    if (!tracks.some(track => String(track.id) === selected)) selected = tracks.length ? String(tracks[0].id) : '';
    const options = tracks.map(track => `<option value="${track.id}">${escape(track.name)} · ID ${track.id}</option>`).join('');
    if (options !== trackOptions) { q('scTrack').innerHTML = options; trackOptions = options; }
    q('scTrack').value = selected;
    const formalOptions = '<option value="">请选择真实轨道 ID</option>' + options;
    if (formalOptions !== bindingOptions) {
      q('scBindA').innerHTML = formalOptions; q('scBindB').innerHTML = formalOptions; bindingOptions = formalOptions;
    }
    q('scBindA').value = bindings.A; q('scBindB').value = bindings.B;
    q('scBindA').disabled = !connected || busy || formalEnabled;
    q('scBindB').disabled = !connected || busy || formalEnabled;
    q('scEnableFormal').disabled = !connected || busy || !validBindings();
    q('scDemoMode').disabled = busy;
    q('scFormalState').textContent = formalEnabled ? '进阶页已启用真实控制' : '进阶页真实控制未启用';
    q('scConnection').textContent = checkingConnection ? '正在重新确认连接…'
      : connected ? (busy ? '已连接 · 正在处理…' : '已连接') : '未连接';
    q('scProject').innerHTML = snapshot
      ? `<strong>工程：${escape(snapshot.projectName)}</strong><span>${snapshot.playing ? '▶ 播放中' : 'Ⅱ 已暂停'} · ${clock(snapshot.positionSeconds)} · ${escape(snapshot.audioDevice || '音频设备待读取')}</span>${!connected ? '<span class="muted">连接已失效，以上是上次读数；请重新连接。</span>' : ''}`
      : '<span class="muted">尚未读取真实工程。</span>';
    const track = target(), volumeDb = track?.volumeDb;
    q('scActualVolume').textContent = track ? `实际音量：${Number.isFinite(volumeDb) ? volumeDb.toFixed(1) : '—'} dB` : '';
    q('scTempoReadout').textContent = snapshot?.tempoSupported && Number.isFinite(snapshot.tempoBpm)
      ? `实际工程 BPM：${snapshot.tempoBpm.toFixed(1)}${tempoReference?.projectKey === snapshot.projectKey ? ` · 连接时参考 ${tempoReference.bpm.toFixed(1)}` : ''}`
      : snapshot?.tempoReason || '工程 BPM 尚未读取';
    const eqState = eqTarget(snapshot, track?.id);
    q('scEqReadout').textContent = eqState.supported ? `真实 EQ：Low ${eqState.values.low.toFixed(1)} / Mid ${eqState.values.mid.toFixed(1)} / High ${eqState.values.high.toFixed(1)} dB${eqState.insert ? '' : '（首次提交时在空槽添加 EQ）'}` : eqState.reason;
    const rateSnapshot = rates.snapshot;
    const currentRateSession = connected && snapshot?.projectKey && rateSnapshot?.projectKey === snapshot.projectKey
      && typeof snapshot.playbackRateEpoch === 'string' && snapshot.playbackRateEpoch === rateSnapshot.epoch;
    const realRate = currentRateSession ? appliedTrackRate(rateSnapshot,track?.id) : null;
    q('scRateReadout').textContent = !connected
      ? '实际变速状态不可用：连接已失效，请重新连接并刷新变速状态。'
      : !currentRateSession
        ? '实际变速状态不可用：工程或变速会话尚未核验，请刷新变速状态；旧版仍可使用播放、音量与 EQ。'
        : !rateSnapshot.engineAudioReady
          ? '实际变速状态不可用：SoundCraft 尚无可用的真实音频输出。'
          : !realRate
            ? '实际播放倍率待音频回调确认；尚无可用的实际读数。'
            : realRate.revision === 0 && realRate.loop === null
              ? '原生播放倍率 1.000×（尚未配置独立音源循环；无运行时音频回调读数）'
              : `实际播放倍率 ${realRate.rate.toFixed(3)}× · ${((realRate.rate-1)*100).toFixed(1)}%（音调随速度变化）`;
    const fxCurrent = connected && !!fx.snapshot && typeof snapshot?.projectKey==='string'
      && fx.snapshot.projectKey === snapshot.projectKey && typeof snapshot.playbackRateEpoch==='string' && fx.snapshot.epoch === snapshot.playbackRateEpoch;
    const fxType = EFFECTS.includes(q('scFxType').value) ? q('scFxType').value : 'reverb';
    const fxState = fxCurrent ? effectTarget(fx.snapshot,track?.id,fxType) : null;
    q('scFxReadout').textContent = !fxCurrent ? '效果器状态尚未核验；请使用新版 SoundCraft 并刷新效果器状态。'
      : !fx.snapshot.engineAudioReady ? 'SoundCraft 真实音频输出尚未就绪。'
      : !fxState?.available ? fxState?.reason || '所选效果器不可用'
      : `${effectNames[fxType]}：${fxState.enabled?'开启':'关闭'} · 干湿混合 ${(fxState.amount*100).toFixed(1)}%${fxState.insert?'':'（尚未添加）'}；切换编辑类型不会关闭其他效果器`;
    if (!drafting) {
      q('scVolume').value = Number.isFinite(volumeDb) ? volumeDb : 0;
      q('scVolumeDraft').textContent = `${Number.isFinite(volumeDb) ? volumeDb.toFixed(1) : '—'} dB`;
    }
    q('scEyes').checked = eyes;
    q('scEyes').disabled = !connected || busy || !environment().camera || !environment().baseline;
    q('scEyeState').textContent = observing ? '观察模式：眼动操作冻结，音乐继续' : eyes ? '眼动真实控制已开启' : '眼动真实控制关闭';
    q('scObserve').textContent = observing ? '退出观察模式' : '进入观察模式';
    q('scStatus').textContent = status;
    q('scConnect').disabled = busy;
    q('scRefresh').disabled = !connected || busy;
    q('scTrack').disabled = !connected || busy || observing;
    for (const id of ['scPlay', 'scPause', 'scVolumeDown', 'scVolumeUp', 'scVolume', 'scUndo', 'scOpenLiveVolume', 'scOpenSeek', 'scOpenTempo', 'scOpenEqLow', 'scOpenEqMid', 'scOpenEqHigh', 'scOpenRate', 'scReadRate', 'scReadFx','scToggleFx','scOpenFx','scFxType']) {
      q(id).disabled = !connected || busy || observing || (!track && id !== 'scPlay' && id !== 'scPause') || (id === 'scUndo' && !history.length);
    }
    notifySession();
  }
  function report(gesture, message, executed, source, note = '') {
    status = note + message;
    onResult?.(gesture, { executed, message: status, from: page, to: page }, source);
    render();
  }
  async function undoLast(ticket, refresh = true) {
    const last = history.at(-1);
    if (!last) throw new Error('没有可撤回的参数修改');
    if (refresh) await client.refresh();
    if (ticket !== generation) return '';
    if (client.snapshot.projectKey !== last.projectKey) throw new Error('工程已变化，不撤回其他工程的参数');
    let message;
    if(last.type==='levels') {
      await levels.restore(last.receipt,last.expected);
      message='已恢复 AB 各自原来的音量；倍率、循环、EQ、效果器及正常播放进度保持';
    } else if(last.type==='tone') {
      await tones.restore(last.receipt,last.expected);fx.snapshot=null;
      message=last.kind==='linked-eq'?`已恢复 AB ${last.band?.toUpperCase()||''} 各自原有增益；保留其他参数与正常播放进度`:'已撤回本次音色预设；保留其他参数与正常流逝的播放时间';
    } else if (last.type === 'effects') {
      await fx.restore(last.effect,last.before,last.expected);
      message='已撤回对应效果器修改；其他效果器、EQ、倍率、循环及正常流逝的播放时间保持';
    } else if (last.type === 'rate') {
      await rates.set(last.before,last.loop,last.expected);
      message='已仅恢复所选音轨的播放倍率；循环范围、其他参数及正常流逝的播放时间不回退';
    } else if (last.type === 'eq') {
      await client.setEq(last.trackId, last.band, last.before, {slot:last.slot,expectedInsert:last.afterInsert});
      message = `已恢复 ${last.band.toUpperCase()} 至 ${last.before.toFixed(1)} dB${last.created ? '；首次添加的 EQ 插件保留在插槽中' : ''}；不恢复历史播放时刻`;
    } else if (last.type === 'tempo') {
      if (!client.snapshot.tempoSupported || client.snapshot.tempoMapKey !== last.afterMapKey) {
        throw new Error('工程 BPM 已在其他位置变化，不覆盖外部修改');
      }
      const restored = await client.setTempo(last.before, {expectedTempoMapKey:last.afterMapKey});
      message = `已恢复工程 BPM 至 ${restored.afterBpm.toFixed(1)}；不恢复历史播放时刻`;
    } else if (last.type === 'deck-seek') {
      if (client.snapshot.sampleRate !== last.sampleRate || client.snapshot.durationSeconds !== last.durationSeconds
        || Number(bindings[last.live.deck]) !== last.live.track || !formalReady()) {
        throw new Error('工程或 Deck 绑定已变化，无法撤回这次单轨定位');
      }
      await deckPlayback.read();
      if (ticket !== generation) return '';
      const reverse = Math.max(-30, Math.min(30, -last.deltaSeconds));
      const result = await deckPlayback.seekRelative(last.live.track, reverse, last.live,
        () => ticket === generation && formalReady() && Number(bindings[last.live.deck]) === last.live.track);
      message = `Deck ${last.live.deck} 已按当前位置反向移动 ${result.deltaSeconds.toFixed(2)} 秒`;
    } else if (last.type === 'seek') {
      if (client.snapshot.sampleRate !== last.sampleRate || client.snapshot.durationSeconds !== last.durationSeconds) {
        throw new Error('工程长度或采样率已变化，不撤回旧时间范围的定位');
      }
      const result = await client.seekRelative(-last.deltaSeconds);
      message = `已按当前位置反向撤回定位偏移 ${result.deltaSeconds.toFixed(2)} 秒；不恢复历史播放时刻，边界处按实际可移动范围执行`;
    } else {
      const track = client.snapshot.tracks.find(item => item.id === last.trackId);
      if (!track || Math.abs(track.volumeDb - last.after) > .02) throw new Error('音量已在其他位置变化，不覆盖外部修改');
      await client.setVolume(last.trackId, last.before);
      message = `已恢复「${track.name}」音量至 ${last.before.toFixed(1)} dB；播放时间保持不变`;
    }
    if (ticket !== generation) return '';
    history.pop(); return message;
  }
  async function run(action, { gesture = action, source = '手动操作', note = '', value } = {}) {
    if (!opened) return;
    const isEye = source === '眼动识别';
    if (isEye && (!eyes || !environment().camera || !environment().baseline || performance.now() - lastFace > 750)) {
      report(gesture, '本区眼动控制未开启，或摄像头／人脸／静息校准未就绪', false, source, note); return;
    }
    if (action === 'observe') {
      if (pending) { report(gesture, '正在等待上一操作的回执，完成后才能切换观察模式', false, source, note); return; }
      observing = !observing;
      report(gesture, observing ? '进入观察模式：冻结操作，音乐继续' : '退出观察模式：恢复操作', true, source, note); return;
    }
    if (pending || client.busy) { report(gesture, '正在等待上一个请求，请稍候', false, source, note); return; }
    if (observing) { report(gesture, '观察模式中，请先恢复操作', false, source, note); return; }
    if (!client.connected) { report(gesture, '请先连接并读取 SoundCraft 工程', false, source, note); return; }
    const current = target();
    if (!['play', 'pause'].includes(action) && !current) { report(gesture, '请先选择有效的音量目标轨道', false, source, note); return; }
    const ticket = generation;
    pending = true; status = '正在发送并等待 SoundCraft 实际回读…'; render();
    try {
      let message;
      if (action === 'play' || action === 'pause') {
        await client[action]();
        message = action === 'play' ? 'SoundCraft 工程已播放（全部轨道共用播放头）' : 'SoundCraft 工程已暂停';
      } else if (action === 'undo') {
        message = await undoLast(ticket);
      } else {
        await client.refresh();
        if (ticket !== generation || !opened) return;
        const refreshed = client.snapshot.tracks.find(track => track.id === current.id);
        if (!refreshed) throw new Error('所选轨道已不可用，请重新连接');
        const before = refreshed.volumeDb;
        const requested = action === 'down' ? before - 1 : action === 'up' ? before + 1 : value;
        const db = Math.max(-144, Math.min(12, requested));
        if (!Number.isFinite(db)) throw new Error('请输入有效音量');
        if (db === before) { status = '音量未变化或已到边界'; return; }
        await client.setVolume(current.id, db);
        if (ticket !== generation || !opened) return;
        history.push({ projectKey: client.snapshot.projectKey, trackId: current.id, before, after: db });
        if (history.length > 20) history.shift();
        message = `「${current.name}」实际音量已变为 ${db.toFixed(1)} dB`;
      }
      if (ticket === generation && opened) report(gesture, message, true, source, note);
    } catch (error) {
      if (ticket === generation && opened) {
        if (!client.connected) eyes = false;
        report(gesture, `${error.message}${error.mayHaveExecuted ? '；可能已执行，请重新连接核对，未自动重发' : ''}`, false, source, note);
      }
    } finally {
      if (ticket === generation) { pending = false; lastPoll = performance.now(); render(); }
    }
  }
  async function openLiveVolume(source = '手动操作', gesture = '打开音量滑块', note = '') {
    if (!opened || adjusting()) return;
    if (pending || client.busy || observing || !client.connected || !target()) {
      report(gesture, '请先连接、选择轨道并退出观察模式，再打开音量滑块', false, source, note); return;
    }
    const e = environment();
    if (source === '眼动识别' && (!eyes || !e.camera || !e.baseline || !e.calibration || e.sliderSettings?.enabled === false || performance.now() - lastFace > 750)) {
      report(gesture, '请先开启眼动控制，并在①校准与录制中完成当前环境的左右标尺校准', false, source, note); return;
    }
    const ticket = generation, trackId = target().id;
    pending = true; render();
    try {
      await client.refresh();
      if (ticket !== generation || !opened) return;
      volume.open(trackId);
      report(gesture, '已打开所选轨道的真实音量滑块；上看恢复原值，下看保留并关闭', true, source, note);
    } catch (error) {
      if (ticket === generation && opened) { if (!client.connected) eyes = false; report(gesture, error.message, false, source, note); }
    } finally { if (ticket === generation) { pending = false; lastPoll = performance.now(); render(); } }
  }
  async function openSeek(source = '手动操作', gesture = '打开快进／快退', note = '', formal = false, scope = 'AB') {
    if (adjusting()) return;
    if (formal ? !formalReady() : !opened || !client.connected) { report(gesture, '请先连接 SoundCraft，并启用相应的真实控制', false, source, note); return; }
    if (pending || client.busy || observing) { report(gesture, '请等待当前操作并退出观察模式，再打开定位弹窗', false, source, note); return; }
    if (source === '眼动识别' && (!(eyes || formalEnabled) || !eyeReady(true))) {
      report(gesture, '眼动真实控制、人脸、静息或左右标尺校准未就绪', false, source, note); return;
    }
    const ticket = generation; pending = true; render();
    try {
      await client.refresh();
      if (ticket !== generation) return;
      if (formal ? !formalReady() : !opened) return;
      if (source === '眼动识别' && !eyeReady(true)) throw new Error('当前人脸或眼动校准未就绪，未打开定位弹窗');
      if (formal && (scope === 'A' || scope === 'B')) {
        const track = Number(bindings[scope]);
        const seekEndSeconds = client.snapshot.tracks.find(item => item.id === track)?.seekEndSeconds;
        if (!Number.isFinite(seekEndSeconds) || seekEndSeconds <= 0) {
          throw new Error('该 Deck 的素材时长尚未就绪，请先装载有效音频后再定位');
        }
        const playback = await deckPlayback.read();
        if (ticket !== generation || !formalReady()) return;
        if (playback?.seekSupported !== true) {
          throw new Error(deckPlayback.message || '单轨实时快进／快退需要新版 SoundCraft 控制模式与桌面网页服务');
        }
        const row = playback.tracks.find(item => item.track === track);
        if (!Number.isFinite(row?.position) || !(client.snapshot.sampleRate > 0)) {
          throw new Error('该 Deck 的素材位置尚未就绪，请稍后重新打开定位弹窗');
        }
        if (source === '眼动识别' && !eyeReady(true)) throw new Error('当前人脸或眼动校准未就绪，未打开定位弹窗');
        const target = {deck:scope, track, projectKey:playback.projectKey, epoch:playback.epoch};
        seek.open({deck:scope, target, position:row.position / client.snapshot.sampleRate,
          duration:seekEndSeconds,
          send:offset => deckPlayback.seekRelative(track, offset, target,
            () => ticket === generation && formalReady() && Number(bindings[scope]) === track)});
        report(gesture, `已打开 Deck ${scope} 实时快进／快退，先回中央，再左右调节`, true, source, note);
      } else {
        seek.open();
        report(gesture, '已打开工程相对快进／快退；先选择偏移秒数，下看时从当时实际播放位置执行一次', true, source, note);
      }
    } catch (error) {
      if (ticket === generation) { if (!client.connected) disarm(); report(gesture, error.message, false, source, note); }
    } finally { if (ticket === generation) { pending = false; lastPoll = performance.now(); render(); } }
  }
  async function openTempo(source = '手动操作', gesture = '打开工程 BPM', note = '', formal = false, reset = false) {
    if (adjusting()) return;
    if (formal ? !formalReady() : !opened || !client.connected) { report(gesture, '请先连接 SoundCraft 并启用相应的真实控制', false, source, note); return; }
    if (pending || client.busy || observing) { report(gesture, '请等待当前操作并退出观察模式，再打开工程 BPM', false, source, note); return; }
    if (source === '眼动识别' && (!(eyes || formalEnabled) || !eyeReady(true))) {
      report(gesture, '眼动真实控制、人脸、静息或左右标尺校准未就绪', false, source, note); return;
    }
    const ticket = generation; pending = true; render();
    try {
      await client.refresh();
      if (ticket !== generation || (formal ? !formalReady() : !opened)) return;
      if (source === '眼动识别' && !eyeReady(true)) throw new Error('当前人脸或眼动校准未就绪');
      if (!client.snapshot.tempoSupported) throw new Error(client.snapshot.tempoReason || '当前工程 BPM 尚未就绪，请重新连接读取');
      if (reset && tempoReference?.projectKey !== client.snapshot.projectKey) throw new Error('连接时的工程 BPM 未记录，请重新连接建立参考值');
      tempo.open(reset ? {initialBpm:tempoReference.bpm,reset:true} : {});
      report(gesture, reset ? '已打开恢复连接时工程 BPM 的确认弹窗；下看确认，双眨放弃'
        : '已打开工程 BPM 草稿；下看提交工程节拍，当前不自动变速 WAV 音频', true, source, note);
    } catch (error) {
      if (ticket === generation) { if (!client.connected) disarm(); report(gesture, error.message, false, source, note); }
    } finally { if (ticket === generation) { pending = false; lastPoll = performance.now(); render(); } }
  }
  async function openEq(band, source = '手动操作', gesture = '调节真实 EQ', note = '', formal = false, deck = null) {
    if (adjusting()) return;
    if (formal ? !formalReady() : !opened || !client.connected) { report(gesture, '请先连接 SoundCraft 并启用相应的真实控制', false, source, note); return; }
    if (pending || client.busy || observing) { report(gesture, '请等待当前操作并退出观察模式，再调节 EQ', false, source, note); return; }
    if (!['low','mid','high'].includes(band) || formal && !['A','B','AB'].includes(deck)) { report(gesture, '请选择 A、B 或 AB 及有效 EQ 频段', false, source, note); return; }
    if (source === '眼动识别' && (!(eyes || formalEnabled) || !eyeReady(true))) {
      report(gesture, '眼动真实控制、人脸、静息或左右标尺校准未就绪', false, source, note); return;
    }
    const trackId = formal ? Number(bindings[deck]) : target()?.id;
    const ticket = generation; pending = true; render();
    try {
      await client.refresh();
      if (ticket !== generation || (formal ? !formalReady() : !opened)) return;
      if (source === '眼动识别' && !eyeReady(true)) throw new Error('当前人脸或眼动校准未就绪');
      if(formal&&deck==='AB') {
        await tones.read();if(ticket!==generation||!formalReady())return;
        if(source==='眼动识别'&&!eyeReady(true))throw new Error('当前人脸或眼动校准未就绪');
        linkedEq.open([Number(bindings.A),Number(bindings.B)],band);
        report(gesture,`已打开 AB ${band.toUpperCase()} 共同增益偏移；下看一次性应用，保留两轨原有增益差`,true,source,note);return;
      }
      const choice = eqTarget(client.snapshot, trackId);
      if (!choice.supported) throw new Error(choice.reason);
      eq.open(trackId, band);
      report(gesture, `已打开${formal ? ` Deck ${deck}` : ''} 的 ${band.toUpperCase()} EQ 草稿；下看提交后作用于真实音频`, true, source, note);
    } catch (error) {
      if (ticket === generation) { if (!client.connected) disarm(); report(gesture, error.message, false, source, note); }
    } finally { if (ticket === generation) { pending = false; lastPoll = performance.now(); render(); } }
  }
  async function openRate(deck,source='手动操作',gesture='实际变速',note='',formal=false,options={}) {
    if(adjusting())return;
    if(formal ? !formalReady() : !opened || !client.connected){report(gesture,'请先连接并启用真实控制',false,source,note);return;}
    if(pending || client.busy || observing){report(gesture,'请先完成当前操作并退出观察模式',false,source,note);return;}
    if(source==='眼动识别' && (!(eyes || formalEnabled) || !eyeReady(true))){report(gesture,'人脸、静息或左右标尺未就绪',false,source,note);return;}
    const ids=formal ? (deck==='AB' ? [Number(bindings.A),Number(bindings.B)] : ['A','B'].includes(deck) ? [Number(bindings[deck])] : []) : [target()?.id];
    if(ids.some(id=>!Number.isInteger(id)||id<=0)||!ids.length){report(gesture,'请选择有效的 A、B 或 AB 目标',false,source,note);return;}
    const ticket=generation;pending=true;render();
    try {
      await rates.read();if(ticket!==generation || (formal ? !formalReady() : !opened))return;
      rate.open(ids,options);report(gesture,'已打开所选音轨实际变速；倍率由音频回调确认，工程 BPM 和片段长度不变',true,source,note);
    } catch(error){if(ticket===generation)report(gesture,error.message,false,source,note);}
    finally{if(ticket===generation){pending=false;lastPoll=performance.now();render();}}
  }
  async function readRate(){
    if(!client.connected || pending || client.busy || adjusting())return;
    const ticket=generation;pending=true;render();
    try{await rates.read();if(ticket===generation)status='已读取 SoundCraft 实际变速状态';}
    catch(error){if(ticket===generation)status=error.message;}
    finally{if(ticket===generation){pending=false;lastPoll=performance.now();render();}}
  }
  function effectIds(deck, formal) {
    return formal ? (deck==='AB' ? [Number(bindings.A),Number(bindings.B)] : ['A','B'].includes(deck) ? [Number(bindings[deck])] : []) : [target()?.id];
  }
  async function editEffect(deck, effect, toggle, source='手动操作', gesture='效果器', note='', formal=false) {
    if (adjusting()) return;
    if (!EFFECTS.includes(effect) || (formal ? !formalReady() : !opened || !client.connected)) {
      report(gesture,'请先连接新版 SoundCraft、启用真实控制并选择有效效果器',false,source,note); return;
    }
    if (pending || client.busy || observing) {report(gesture,'请先完成当前操作并退出观察模式',false,source,note);return;}
    if (source==='眼动识别' && (!(eyes || formalEnabled) || !eyeReady(!toggle))) {
      report(gesture,'人脸、静息或左右标尺尚未就绪，未修改效果器',false,source,note);return;
    }
    const ids=effectIds(deck,formal);
    if (!ids.length || ids.some(id=>!Number.isInteger(id)||id<=0)) {report(gesture,'请选择有效的 A、B 或 AB 目标',false,source,note);return;}
    const ticket=generation;pending=true;render();
    try {
      await fx.read();
      if (ticket!==generation || (formal ? !formalReady() : !opened)) return;
      if (source==='眼动识别' && !eyeReady(!toggle)) throw new Error('当前人脸或校准条件已变化');
      const targets=ids.map(id=>effectTarget(fx.snapshot,id,effect));
      if (targets.some(item=>!item.available)) throw new Error(targets.find(item=>!item.available)?.reason || '所选轨道效果器不可用');
      if (toggle) {
        const enabled=!targets.every(item=>item.enabled);
        const result=await fx.set(effect,ids.map((track,i)=>({track,enabled,amount:targets[i].amount})),fx.snapshot);
        if (ticket!==generation) return;
        rememberEffect(result);
        report(gesture,`${effectNames[effect]}已${enabled?'开启':'关闭'}${ids.length===2?'（AB 同时应用）':''}；其他效果器、EQ、倍率、循环与播放时间保持`,true,source,note);
      } else {
        if (targets.some(item=>item.insert===null)) throw new Error('请先开启所选轨道的效果器，再调节强度；尚未添加的效果器不会保存强度草稿');
        fxPopup.open(ids,effect);
        report(gesture,`已打开${effectNames[effect]}强度草稿；下看应用，关闭的效果器不会自动开启`,true,source,note);
      }
    } catch(error) {
      if(ticket===generation) {if(!client.connected)disarm();report(gesture,`${error.message}${error.mayHaveExecuted?'；可能已执行，请重新连接核对，未自动重发':''}`,false,source,note);}
    } finally {if(ticket===generation){pending=false;lastPoll=performance.now();render();}}
  }
  async function readEffects() {
    if (pending || client.busy || adjusting()) throw new Error('请等待当前 SoundCraft 操作完成');
    const ticket=generation;pending=true;render();
    try {const result=await fx.read();if(ticket!==generation)throw new Error('控制页面已切换');return result;}
    finally {if(ticket===generation){pending=false;lastPoll=performance.now();render();}}
  }
  async function connect() {
    if (!opened || pending || client.busy) return;
    const ticket = generation;
    disarm(); connectionIssue = ''; eyes = false; history = []; tempoReference = null; rates.snapshot = null; fx.snapshot = null; pending = true; status = '正在连接并读取 SoundCraft…'; render();
    try {
      await client.connect();
      connectionIssue = '';
      if (ticket === generation) rememberTempo();
      if (ticket === generation && opened) status = '已读取真实工程；请先用手动按钮验证，准备好后再开启本区眼动控制。';
    } catch (error) {
      if (ticket === generation && opened) { connectionIssue = error.message; status = error.message; }
    } finally {
      if (ticket === generation) { pending = false; lastPoll = performance.now(); render(); }
    }
  }
  function refresh() {
    if (!hasSession() || !client.connected || pending || client.busy || refreshWork || waveformWork || adjusting() || client.volumeStreaming) return;
    const ticket = generation; lastPoll = performance.now();
    const work = client.refresh({
      retryTransient: true,
      onRetry(attempt, total) {
        if (ticket !== generation || !hasSession()) return;
        if (!checkingConnection) recoveryRevision++;
        checkingConnection = true;
        status = `SoundCraft 状态暂未读到，正在核对原工程（${attempt}/${total}）；请等状态恢复后操作。`;
        render();
      },
    }).then(async () => {
      if (ticket !== generation || !hasSession()) return;
      if (formalReady()) await deckPlayback.read();
      connectionIssue = '';
      if (ticket === generation && hasSession() && checkingConnection) {
        status = '已重新确认原工程连接，可以继续控制。';
      }
    }).catch(error => {
      if (ticket === generation && hasSession()) {
        recoveryRevision++;
        if(error.code==='busy'&&error.mayHaveExecuted!==true&&client.connected){status='状态读取暂忙，将稍后刷新；未改变音频参数';render();return;}
        connectionIssue = error.message; eyes = false; disarm(); status = error.message; render();
      }
    }).finally(()=>{
      if(refreshWork===work)refreshWork=null;
      if(ticket===generation){checkingConnection=false;lastPoll=performance.now();render();}
    });
    refreshWork=work;
  }
  async function afterRefresh(action) {
    if (checkingConnection) return false;
    // Waveforms are optional. A user control takes priority over their read.
    if (waveformWork) { waveforms.cancel({keepSnapshot:true}); waveformWork = null; }
    const read=refreshWork;
    if (!read) return action();
    if (pending) return false;
    const ticket=generation, revision=recoveryRevision;
    pending=true;status='正在完成状态读取，随后执行本次指令…';render();
    await read.catch(()=>{});
    if(ticket!==generation)return false;
    pending=false;render();
    if(!hasSession() || revision !== recoveryRevision)return false;
    return action();
  }
  function readWaveforms(){
    if(waveformWork)return waveformWork;
    return afterRefresh(()=>{
      if(!formalReady()||pending||client.busy||adjusting())throw new Error('请先启用真实控制并结束当前参数弹窗，再刷新波形');
      const ticket=generation;
      const work=waveforms.read([Number(bindings.A),Number(bindings.B)]).finally(()=>{
        if(waveformWork===work)waveformWork=null;
        if(ticket===generation){lastPoll=performance.now();render();}
      });
      waveformWork=work;return work;
    });
  }
  function close(force = false, retainFormal = false) {
    if (!force && adjusting()) { status = '请先完成或放弃当前参数弹窗'; render(); return; }
    if (!force && (pending || client.busy)) { status = '请等待当前操作的回执后再返回'; render(); return; }
    if (force) {
      volume.detach(); seek.detach(); tempo.detach(); eq.detach(); rate.detach(); fxPopup.detach(); presetsPopup.detach(); linkedVolume.detach(); linkedEq.detach(); songPopup.detach(); waveforms.cancel();
      if (!retainFormal) { disarm(); bindings = {A:'', B:''}; tempoReference = null; }
    }
    generation++; opened = false; eyes = false; observing = false; pending = false; drafting = false;
    if (!formalEnabled) { client.disconnect(); history = []; }
    root.classList.toggle('hidden', true); onVisibility?.(false); render();
  }
  async function enableFormal() {
    if (!opened || pending || client.busy || adjusting() || !client.connected) return;
    const ticket = generation; pending = true; render();
    try {
      await client.refresh();
      const playback = await deckPlayback.read();
      if (!playback) throw new Error(deckPlayback.message || '未取得单轨播放状态，请核对 SoundCraft 控制模式');
      if (ticket !== generation || !opened) return;
      if (!validBindings() || !client.snapshot?.projectKey) throw new Error('请为 A、B 选择两个不同且有效的真实轨道 ID');
      await client.captureAudioBaseline({A:Number(bindings.A), B:Number(bindings.B)});
      if (ticket !== generation || !opened) return;
      if (tempoReference?.projectKey !== client.snapshot.projectKey) rememberTempo();
      boundProjectKey = client.snapshot.projectKey; formalEnabled = true; connectionIssue = ''; eyes = false; observing = false;
      status = '进阶页已接入真实工程。选择 A 或 B 可独立播放／暂停，选择 AB 可控制工程播放。';
      pending = false; render(); // Publish availability before the parent changes its route.
      onFormalMode?.(true); close();
      lastPoll = -Infinity;
    } catch (error) {
      if (ticket === generation) { connectionIssue = error.message; disarm(); status = error.message; }
    } finally { if (ticket === generation) { pending = false; lastPoll = performance.now(); render(); } }
  }
  function demoMode() {
    if (pending || client.busy || adjusting()) return;
    disarm(); eyes = false; history = []; status = '已返回网页演示模式；未暂停 SoundCraft 工程。';
    close(); onFormalMode?.(false);
  }
  async function resetAudio() {
    if (!formalReady() || pending || client.busy || adjusting()) {
      throw new Error('请先连接并启用真实控制，结束当前弹窗后再恢复音频');
    }
    const ticket = generation;
    pending = true;
    status = '正在停止播放并恢复 SoundCraft A/B 原始音频…';
    render();
    let applied = false;
    try {
      const result = await client.resetAudio({A:Number(bindings.A), B:Number(bindings.B)});
      applied = true;
      if (ticket !== generation) throw new Error('控制页面已切换；请核对 SoundCraft 实际状态');
      await deckPlayback.read();
      rates.snapshot = null; fx.snapshot = null; tones.snapshot = null;
      levels.snapshot = null; waveforms.cancel();
      history = [];
      status = 'SoundCraft A/B 音频已恢复保存的初始值并停在开头';
      render();
      return {executed:true, message:status, snapshot:result.snapshot};
    } catch (error) {
      if (applied) error.mayHaveExecuted = true;
      if (ticket === generation) { connectionIssue = error.message; status = error.message; render(); }
      throw error;
    } finally {
      if (ticket === generation) { pending = false; lastPoll = performance.now(); render(); }
    }
  }
  async function openFormalVolume(deck, source = '手动控制', gesture = '打开真实音量', note = '') {
    if (adjusting()) return;
    if (!formalReady()) { render(); report(gesture, '真实控制未就绪，请重新连接并启用进阶页真实控制', false, source, note); return; }
    if (!['A','B','AB'].includes(deck)) { report(gesture, '请选择 A、B 或 AB', false, source, note); return; }
    if (pending || client.busy) { report(gesture, '正在等待上一个请求，请稍候', false, source, note); return; }
    if (source === '眼动识别' && !eyeReady(true)) {
      report(gesture, '摄像头／人脸／静息或左右标尺校准未就绪，未打开真实音量', false, source, note); return;
    }
    const ticket = generation, trackId = bindings[deck]; pending = true; render();
    try {
      await client.refresh();
      if (ticket !== generation) return;
      if (!formalReady()) throw new Error('工程或轨道绑定已变化，请重新连接并启用真实控制');
      if (source === '眼动识别' && !eyeReady(true)) throw new Error('当前人脸或眼动校准未就绪，未打开真实音量');
      if(deck==='AB') {
        await levels.read();if(ticket!==generation||!formalReady())return;
        if(source==='眼动识别'&&!eyeReady(true))throw new Error('当前人脸或眼动校准未就绪');
        linkedVolume.open([Number(bindings.A),Number(bindings.B)]);
        report(gesture,'已打开 AB 实时音量共同偏移，保留两轨原有音量差',true,source,note);return;
      }
      const track = client.snapshot.tracks.find(item => String(item.id) === trackId);
      volume.open(track.id);
      report(gesture, `已打开 Deck ${deck}「${track.name}」的真实音量滑块`, true, source, note);
    } catch (error) {
      if (ticket === generation) {
        if (!client.connected || error.mayHaveExecuted) { connectionIssue = error.message; disarm(); }
        report(gesture, error.message, false, source, note);
      }
    } finally { if (ticket === generation) { pending = false; lastPoll = performance.now(); render(); } }
  }
  async function runFormal(action = 'togglePlayback', source = '手动控制', gesture = action, note = '', scope = 'AB') {
    if (!formalReady()) { render(); report(gesture, '真实控制未就绪，请重新连接并启用进阶页真实控制', false, source, note); return; }
    if (pending || client.busy || adjusting()) { report(gesture, '正在等待上一个请求或参数弹窗，请稍候', false, source, note); return; }
    if (source === '眼动识别' && !eyeReady()) { report(gesture, '摄像头／人脸／静息校准未就绪，未发送真实控制', false, source, note); return; }
    if (action !== 'togglePlayback' && action !== 'undo') { report(gesture, '此操作尚未接入 SoundCraft', false, source, note); return; }
    if (action === 'undo' && !history.length) { report(gesture, '没有可撤回的真实参数修改；播放时间保持不变', false, source, note); return; }
    const solo = action === 'togglePlayback' && ['A', 'B'].includes(scope);
    const ticket = generation; pending = true; render();
    try {
      await client.refresh();
      if (ticket !== generation) return;
      if (!formalReady()) throw new Error('工程或轨道绑定已变化，请重新连接并启用真实控制');
      if (source === '眼动识别' && !eyeReady()) throw new Error('当前人脸或静息校准未就绪，未发送真实控制');
      let message;
      if (solo) {
        const track = Number(bindings[scope]), peer = Number(bindings[scope === 'A' ? 'B' : 'A']);
        const result = await deckPlayback.toggle(track, peer,
          () => ticket === generation && formalReady() && (source !== '眼动识别' || eyeReady()));
        const paused = result.tracks.find(row => row.track === track).paused;
        message = `Deck ${scope} 已${paused ? '暂停' : '播放'}`;
      } else if (action === 'togglePlayback') {
        const playing = client.snapshot.playing;
        await client[playing ? 'pause' : 'play']();
        message = playing ? 'SoundCraft 整个工程已暂停' : 'SoundCraft 整个工程已播放（A/B 共用播放头）';
      } else {
        message = await undoLast(ticket, false);
      }
      if (ticket === generation) report(gesture, message, true, source, note);
    } catch (error) {
      if (ticket === generation) {
        if (!client.connected || error.mayHaveExecuted) { connectionIssue = error.message; disarm(); }
        report(gesture, `${error.message}${error.mayHaveExecuted ? '；可能已执行，请重新连接核对，未自动重发' : ''}`, false, source, note);
      }
    } finally { if (ticket === generation) { pending = false; lastPoll = performance.now(); render(); } }
  }
  async function configureFullLoop(enabled) {
    if (pending || client.busy || adjusting()) throw new Error('请先结束当前 SoundCraft 调节，再修改循环');
    const ticket = generation;
    eyes = false; history = []; pending = true; render();
    try {
      if (!client.connected) { await client.connect(); if (ticket === generation) rememberTempo(); }
      if (ticket !== generation) throw new Error('操作已取消，请重新设置循环');
      const loop = await client[enabled ? 'enableFullLoop' : 'disableFullLoop']();
      if (ticket !== generation) throw new Error('界面已切换，请重新连接并核对循环设置');
      status = enabled ? `已固定全部 ${loop.trackIds.length} 条音轨的循环范围：0:00–${(loop.end / loop.sampleRate).toFixed(2)} 秒；未自动播放。`
        : '已取消全音轨循环；之后网页播放不会再恢复固定范围。未自动播放。';
      return loop;
    } finally {
      if (ticket === generation) { pending = false; lastPoll = performance.now(); render(); }
    }
  }
  async function openFormalPreset(kind,scope,source='手动控制',gesture='音色预设',note='') {
    if(!formalReady()||pending||client.busy||adjusting()) {report(gesture,'请先连接并启用真实控制，等待当前操作完成',false,source,note);return;}
    if(source==='眼动识别'&&!eyeReady()) {report(gesture,'当前人脸或静息校准未就绪，未打开预设弹窗',false,source,note);return;}
    if(!['A','B','AB'].includes(scope)) {report(gesture,'请选择 A、B 或 AB',false,source,note);return;}
    const ticket=generation;pending=true;render();
    try {
      const snapshot=await tones.read();
      if(ticket!==generation)return;
      if(!formalReady()||source==='眼动识别'&&!eyeReady())throw new Error('控制状态已变化，未打开预设弹窗');
      const ids=(scope==='AB'?['A','B']:[scope]).map(deck=>({deck,track:Number(bindings[deck])}));
      presetsPopup.open(kind,{scope,ids,snapshot});
      report(gesture,kind==='save'?'已读取当前音色，请确认保存为新预设':kind==='select'?'选择预设，不立即应用音频':'请核对每条轨道的音色变化，下看确认应用',true,source,note);
    }catch(error){if(ticket===generation)report(gesture,error.message,false,source,note);}
    finally{if(ticket===generation){pending=false;lastPoll=performance.now();render();}}
  }
  function songIssue(target) {
    const snapshot = client.snapshot;
    if (!formalReady() || target.projectKey !== snapshot.projectKey || target.epoch !== snapshot.playbackRateEpoch
      || Number(bindings[target.deck]) !== target.track || target.generation !== generation) {
      return '工程或音轨绑定已变化，请重新连接并选曲。';
    }
    return '';
  }
  async function openFormalSong(deck, source, gesture, note) {
    if (!['A', 'B'].includes(deck)) { report(gesture, '请选定单轨 Deck A 或 B 后换曲。', false, source, note); return; }
    if (!formalReady() || pending || client.busy || adjusting()) {
      report(gesture, '请先连接 SoundCraft 并启用真实控制。', false, source, note); return;
    }
    if (source === '眼动识别' && !eyeReady(true)) {
      report(gesture, '请先完成摄像头、静息及视线滑块左右标尺校准。', false, source, note); return;
    }
    const ticket = generation;
    pending = true;
    render();
    try {
      await client.refresh();
      if (ticket !== generation) return;
      const snapshot = client.snapshot;
      if (deckPlayback.snapshot?.loadSupported === false) {
        throw new Error('请通过桌面快捷方式重开支持换曲的 SoundCraft 控制模式。');
      }
      const track = snapshot.tracks.find(item => item.id === Number(bindings[deck]));
      if (!snapshot.projectPath || !snapshot.playbackRateEpoch || track?.kind !== 'audio' || track.inactive) {
        throw new Error('换曲需要保存过的 SoundCraft 工程、已绑定的有效音频轨道及新版控制模式。');
      }
      const target = { deck, track:track.id, trackName:track.name, projectKey:snapshot.projectKey,
        epoch:snapshot.playbackRateEpoch, generation:ticket };
      const issue = songIssue(target);
      if (issue) throw new Error(issue);
      if (snapshot.playing) {
        const playback = await deckPlayback.read();
        if (ticket !== generation) return;
        if (playback?.epoch !== target.epoch || playback.playing !== snapshot.playing) {
          throw new Error('SoundCraft 播放状态正在变化，请刷新后重试选曲。');
        }
      }
      const projectSources = snapshot.sources || [];
      const imported = await songs.list().catch(error => {
        if (!projectSources.length) throw error;
        return [];
      });
      const catalog = mergeSongCandidates(projectSources, imported);
      if (ticket !== generation) return;
      if (!catalog.length) throw new Error('当前工程没有可用素材，且网页曲库为空；请先在 SoundCraft 导入素材或在「曲库与设置」导入曲目。');
      if (songIssue(target) || source === '眼动识别' && !eyeReady(true)) throw new Error('控制状态已变化，请重新选曲。');
      const currentSource = projectSources.find(item => item.sourceId === track.activeSourceId);
      target.initialIndex = Math.max(0, catalog.findIndex(item => songNameKey(item.name) === songNameKey(currentSource?.name)));
      songPopup.open(target, catalog);
      report(gesture, `已打开 Deck ${deck} 的连续选曲。`, true, source, note);
    } catch (error) {
      if (ticket === generation) report(gesture, error.message, false, source, note);
    } finally {
      if (ticket === generation) { pending = false; lastPoll = performance.now(); render(); }
    }
  }
  async function loadFormalSong(target, song, source) {
    const result = await client.loadDeckSong({ ...target, song,
      canLoad: () => !songIssue(target) && (source !== '眼动识别' || eyeReady(true)) });
    if (target.generation === generation) {
      // A fresh playlist has its own playback origin, so old seek receipts cannot be reused.
      history = [];
      waveforms.cancel();
      deckPlayback.reset();
      onSongLoaded?.(target.deck, result);
      render();
    }
    return result;
  }
  root.onclick = event => {
    const button = event.target.closest('button');
    if (!button || button.disabled) return;
    const actions = { scPlay: 'play', scPause: 'pause', scVolumeDown: 'down', scVolumeUp: 'up', scUndo: 'undo', scObserve: 'observe' };
    if (actions[button.id]) { event.stopPropagation?.(); void run(actions[button.id], { gesture: button.textContent, source: '手动操作' }); }
    else if (button.id === 'scOpenLiveVolume') { event.stopPropagation?.(); void openLiveVolume(); }
    else if (button.id === 'scOpenSeek') { event.stopPropagation?.(); void openSeek(); }
    else if ({scOpenEqLow:'low',scOpenEqMid:'mid',scOpenEqHigh:'high'}[button.id]) { event.stopPropagation?.(); void openEq({scOpenEqLow:'low',scOpenEqMid:'mid',scOpenEqHigh:'high'}[button.id]); }
    else if (button.id === 'scOpenRate') {event.stopPropagation?.();void openRate(null);}
    else if (button.id === 'scReadRate') {event.stopPropagation?.();void readRate();}
    else if (button.id === 'scReadFx') {event.stopPropagation?.();void readEffects().then(()=>{status='已读取真实效果器状态';render();}).catch(error=>{status=error.message;render();});}
    else if (button.id === 'scToggleFx' || button.id === 'scOpenFx') {
      event.stopPropagation?.();void editEffect(null,EFFECTS.includes(q('scFxType').value)?q('scFxType').value:'reverb',button.id==='scToggleFx');
    }
    else if (button.id === 'scOpenTempo') { event.stopPropagation?.(); void openTempo(); }
    else if (button.id === 'scConnect') { event.stopPropagation?.(); void connect(); }
    else if (button.id === 'scEnableFormal') { event.stopPropagation?.(); void enableFormal(); }
    else if (button.id === 'scDemoMode') { event.stopPropagation?.(); demoMode(); }
    else if (button.id === 'scRefresh') { event.stopPropagation?.(); refresh(); }
    else if (button.id === 'scClose') { event.stopPropagation?.(); close(); }
  };
  root.oninput = event => {
    if (event.target.id === 'scVolume') { drafting = true; q('scVolumeDraft').textContent = `${Number(event.target.value).toFixed(1)} dB（待应用）`; }
  };
  root.onchange = event => {
    if (event.target.id === 'scFxType') {render();return;}
    if (event.target.id === 'scBindA' || event.target.id === 'scBindB') {
      if (pending || client.busy || adjusting() || formalEnabled) return;
      bindings[event.target.id === 'scBindA' ? 'A' : 'B'] = String(event.target.value); render();
    }
    if (event.target.id === 'scTrack') { selected = event.target.value; drafting = false; render(); }
    if (event.target.id === 'scVolume') { drafting = false; void run('volume', { gesture: '手动音量滑块', value: Number(event.target.value) }); }
    if (event.target.id === 'scEyes') {
      eyes = !!event.target.checked && client.connected && !!environment().camera && !!environment().baseline;
      status = eyes ? '本区眼动真实控制已开启，请按上方临时指令操作。' : '本区眼动真实控制已关闭。'; render();
    }
  };
  render();
  initialized = true;
  function openPanel(){
    if (pending || client.busy || adjusting() || client.volumeStreaming) return false;
    generation++; opened = true; eyes = false; observing = false;
    if (!formalEnabled) lastFace = -Infinity;
    status = client.connected ? '已连接 SoundCraft；本区眼动默认关闭。' : '请先连接并读取真实工程；本区眼动默认关闭。'; root.classList.toggle('hidden', false); onVisibility?.(true); render();
    return true;
  }
  return {
    isOpen: () => opened,
    isBusy: () => checkingConnection || pending || !!client.busy && !refreshWork,
    isAdjusting: adjusting,
    eyesEnabled: () => eyes,
    getSession,
    hasSession,
    resetAudio: async () => {
      const result = await afterRefresh(resetAudio);
      if (result?.executed !== true) throw new Error('SoundCraft 状态仍在核对或会话已变化，音频未确认恢复');
      return result;
    },
    openFormalVolume:(...args)=>afterRefresh(()=>openFormalVolume(...args)),
    openFormalRate:(deck,source,gesture,note,options={})=>afterRefresh(()=>openRate(deck,source,gesture,note,true,options)),
    readRates:()=>afterRefresh(async()=>{const result=await rates.read();render();return result;}),
    readEffects:()=>afterRefresh(readEffects),
    readWaveforms,
    clearWaveforms:()=>waveforms.cancel(),
    openFormalPreset:(...args)=>afterRefresh(()=>openFormalPreset(...args)),
    openFormalSong:(...args)=>afterRefresh(()=>openFormalSong(...args)),
    openFormalEffect:(deck,effect,source,gesture,note)=>afterRefresh(()=>editEffect(deck,effect,false,source,gesture,note,true)),
    toggleFormalEffect:(deck,effect,source,gesture,note)=>afterRefresh(()=>editEffect(deck,effect,true,source,gesture,note,true)),
    openFormalEq: (deck, band, source, gesture, note) => afterRefresh(()=>openEq(band, source, gesture, note, true, deck)),
    openFormalSeek: (source, gesture, note, scope) => afterRefresh(()=>openSeek(source, gesture, note, true, scope)),
    openFormalTempo: (source, gesture, note, reset = false) => afterRefresh(()=>openTempo(source, gesture, note, true, reset)),
    runFormal:(...args)=>afterRefresh(()=>runFormal(...args)),
    enableFullLoop: () => afterRefresh(()=>configureFullLoop(true)),
    disableFullLoop: () => afterRefresh(()=>configureFullLoop(false)),
    open: () => pending || (!waveformWork && !refreshWork) ? openPanel() : afterRefresh(openPanel),
    close,
    resumeFormal() { if (formalEnabled) { lastPoll = -Infinity; refresh(); } },
    frame(raw, t) { if (hasSession()) { lastFace = raw ? performance.now() : -Infinity; volume.frame(raw, t); seek.frame(raw, t); tempo.frame(raw, t); eq.frame(raw, t); rate.frame(raw,t); fxPopup.frame(raw,t); presetsPopup.frame(raw,t); linkedVolume.frame(raw,t); linkedEq.frame(raw,t); songPopup.frame(raw,t); } },
    tick() {
      if (hasSession()) {
        volume.tick(); seek.tick(); tempo.tick(); eq.tick(); rate.tick(); fxPopup.tick(); presetsPopup.tick(); linkedVolume.tick(); linkedEq.tick(); songPopup.tick();
        if (formalEnabled && !formalReady()) render(); else notifySession();
        if (performance.now() - lastPoll >= 1500) refresh();
      }
    },
    gesture(gesture, source, note = '') {
      if (volume.isOpen()) return volume.gesture(gesture, source, note);
      if (seek.isOpen()) return seek.gesture(gesture, source, note);
      if (tempo.isOpen()) return tempo.gesture(gesture, source, note);
      if (eq.isOpen()) return eq.gesture(gesture, source, note);
      if (rate.isOpen()) return rate.gesture(gesture, source, note);
      if (fxPopup.isOpen()) return fxPopup.gesture(gesture, source, note);
      if (presetsPopup.isOpen()) return presetsPopup.gesture(gesture,source,note);
      if (linkedVolume.isOpen()) return linkedVolume.gesture(gesture,source,note);
      if (linkedEq.isOpen()) return linkedEq.gesture(gesture,source,note);
      if (songPopup.isOpen()) return songPopup.gesture(gesture,source,note);
      if (gesture === '左看' || gesture === '右看') return openLiveVolume(source, gesture, note);
      const action = { 上看: 'play', 下看: 'pause', 左看: 'down', 右看: 'up', 长眨: 'observe', 双眨: 'undo' }[gesture];
      if (action) return run(action, { gesture, source, note });
    },
  };
}

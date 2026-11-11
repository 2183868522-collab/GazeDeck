// Main browser app: camera → MediaPipe → features → per-person normalisation → segmenter → classifier
// → decision engine → actions (communication board / beat accompaniment).
import { FilesetResolver, FaceLandmarker } from '../vendor/mediapipe/vision_bundle.mjs';
import { extractFeatures, FEATURE_NAMES, BLENDSHAPE_CHANNELS, OVERLAY_POINTS } from './features.js';
import { computeBaseline, normalise, adaptBaseline } from './baseline.js';
import { Segmenter, activityOf } from './segmenter.js';
import { GestureClassifier, REST_LABEL, UNKNOWN_LABEL } from './classifier.js';
import { GestureEngine, PAUSE_ACTION, DEFAULT_ENGINE_SETTINGS } from './engine.js';
import { initProfileStore, loadProfile, saveProfile, exportProfile, importProfile, defaultProfile, listProfiles, listProfileSnapshots, switchProfile, createProfile, deleteProfile, activeBaseline, addBaseline, startSession, createRawSample, materialiseSample, calibrationDurationFactor } from './profile.js';
import { splitBySession } from './dataset.js';
import { buildTrials, isSuccessfulPrediction, summariseTrials, shouldPromoteCandidate } from './test-mode.js';
import { BeatBox } from './music.js';
import { captureLayoutForMode } from './capture-workspace.js';
import { gazeSignal, buildGazeCalibration, beginGazeCalibrationRun, cancelGazeCalibrationRun, GazeSliderController, GAZE_SLIDER_ACTIONS, SLIDER_GESTURES } from './gaze-slider.js';
import { MAX_TRACKS, TRACK_VALUE_STEP, trackIndexForValue, trackValueForIndex } from './track-picker.js';
import { buildPersonalEyeCalibration } from './personal-calibration.js';
import { buildCameraOptionModel, openCameraStream } from './camera-selection.js';
import { SustainedBlackFrameDetector } from './black-frame-detector.js';
import { renameGesture, deleteLatestGestureSamples } from './profile.js';
import { saveParameterDefaults, restoreParameterDefaults, parameterDefaultsInfo } from './profile.js';
import { baselineSampleSummary, activateBaseline, restoreRecordedBaseline, repairLegacyBaselineSelection } from './profile.js';
import { mountGazeDeck } from './gazedeck-ui.js';
import { QuickExperience } from './quick-experience.js';
import { installLanguageSwitch } from './i18n.js';

const $ = id => document.getElementById(id);
installLanguageSwitch();
const video = $('video'), overlay = $('overlay'), octx = overlay.getContext('2d');
const lightingCanvas = document.createElement('canvas');
lightingCanvas.width = 64; lightingCanvas.height = 48;
const lightingContext = lightingCanvas.getContext('2d', { willReadFrequently: true });

// ---------------------------------------------------------------- state
const profileStoreReady = await initProfileStore();
let profile = loadProfile();
let landmarker = null;
let segmenter = new Segmenter(profile.settings.segmenter);
let classifier = new GestureClassifier(profile.settings.classifier);
let engine = new GestureEngine(profile.settings.engine);
let liveBaseline = activeBaseline(profile) ? structuredClone(activeBaseline(profile)) : null; // adapts slowly; stored copy stays fixed
let activeTab = 'train';
let mode = 'idle';          // idle | calibrating | recording | testing-* | gaze-calibrating | gaze-slider
let calibFrames = [];
let recorder = null;        // active recording session, see startRecording()
let lastVideoTime = -1;
let guidedTest = null;
let gazeCalibrationRun = null;
let gazeSliderSession = null;
// Test hook (only with ?test=1): lets tests/browser_flow.mjs feed synthetic feature frames into the real UI.
const testFeed = new URLSearchParams(location.search).has('test');
const beatBox = new BeatBox();
const trackAudio = $('trackAudio');
const tracks = [];
let selectedTrackIndex = -1;
let previewTrackIndex = -1;
const DELEGATE_KEY = 'eye-gesture-control/delegate';
const CAMERA_KEY = 'eye-gesture-control/camera';
const CAMERA_LABEL_KEY = 'eye-gesture-control/camera-label';
const safeGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
const safeSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } };
let preferredCameraId = safeGet(CAMERA_KEY);
let preferredCameraLabel = safeGet(CAMERA_LABEL_KEY) || '';
let cameraRequestId = 0;
let cameraListRequestId = 0;
let cameraListTimer = null;
let gazeDeckProfileId = profile.id;
let quickExperience = null;
let quickControlSelected = false;
let quickControlRequested = false;
const gazeDeck = mountGazeDeck($('tab-gazedeck'), {
  environment: () => ({
    user: quickControlSelected ? `${profile.name} · ${quickExperience?.modelName() || '快捷模型'}` : profile.name,
    gestures: quickControlSelected ? quickExperience?.labels() || [] : [...profile.gestures],
    labels: quickControlSelected ? quickExperience?.labels() || [] : classifier.labels(),
    camera: testFeed || !!video.srcObject?.getVideoTracks().some(track => track.readyState === 'live' && !track.muted) || (!!video.src && !video.paused),
    cameraStream: !!video.srcObject?.getVideoTracks().some(track => track.readyState === 'live' && !track.muted),
    cameraLabel: $('cameraSelect').selectedOptions[0]?.textContent || '',
    baseline: quickControlSelected ? !!quickExperience?.baseline : !!liveBaseline,
    calibration: quickControlSelected ? null : validGazeCalibration() ? profile.gazeSlider.calibration : null,
    eyeCalibration: quickControlSelected ? null : profile.eyeCalibration?.baselineId === profile.activeBaselineId ? profile.eyeCalibration.axes : null,
    sliderSettings: profile.gazeSlider.settings,
    engineSettings: quickControlSelected ? DEFAULT_ENGINE_SETTINGS : profile.settings.engine,
    useClosestGuess: !quickControlSelected && profile.settings.gazeDeckUseClosestGuess === true,
  }),
  onLog: (message, executed) => log(message, executed ? 'fired' : 'rejected'),
  onActive: value => document.body.classList.toggle('gazedeck-workspace', value),
  onExit: () => document.querySelector('[data-tab="train"]').click(),
  onIntroCamera: () => $('startCamera').click(),
  onIntroRecognition: () => {
    document.querySelector('[data-tab="train"]').click();
    requestAnimationFrame(() => $('calibrate').scrollIntoView({ block: 'start', behavior: 'smooth' }));
  },
  previewSource: video,
});
quickExperience = new QuickExperience($('tab-quick'), {
  profiles: listProfileSnapshots,
  onStatus: setStatus,
  onEnterAdvanced: () => {
    quickControlRequested = true;
    document.querySelector('[data-tab="gazedeck"]').click();
  },
  stage: document.querySelector('.stage'),
  cameraRow: document.querySelector('.camera-row'),
});

function setCaptureWorkspace(workflowMode, { title = '采集中', progress = '', ratio = 0, canStop = false, stopLabel = '停止测试' } = {}) {
  const layout = captureLayoutForMode(workflowMode);
  document.body.classList.toggle('capture-workspace', layout.active);
  document.body.classList.toggle('capture-review', layout.active && layout.review);
  document.body.classList.toggle('capture-gaze-calibrating', workflowMode === 'gaze-calibrating');
  $('captureHud').classList.toggle('hidden', !layout.active);
  if (!layout.active) return;
  $('captureTitle').textContent = title;
  $('captureProgressText').textContent = progress;
  $('captureProgressBar').style.width = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
  $('captureStop').textContent = stopLabel;
  $('captureStop').classList.toggle('hidden', !canStop);
}

// ---------------------------------------------------------------- model
async function initModel() {
  const delegate = safeGet(DELEGATE_KEY) || 'GPU';
  $('delegate').value = delegate;
  const files = await FilesetResolver.forVisionTasks('vendor/mediapipe/wasm');
  const make = d => FaceLandmarker.createFromOptions(files, {
    baseOptions: { modelAssetPath: 'models/face_landmarker.task', delegate: d },
    runningMode: 'VIDEO', numFaces: 1, outputFaceBlendshapes: true,
  });
  try { landmarker = await make(delegate); }
  catch (e) {
    console.warn('[model] delegate', delegate, 'failed, falling back to CPU', e);
    landmarker = await make('CPU');
  }
  setStatus(profileStoreReady ? '模型已就绪，请启动摄像头' : '模型已就绪；扩展档案存储不可用，请备份档案并检查浏览器网站数据权限', profileStoreReady ? '' : 'warn');
}

// ---------------------------------------------------------------- camera selection
async function listCameras() {
  const requestId = ++cameraListRequestId;
  const info = $('cameraListInfo');
  info.textContent = '正在读取摄像头列表…';
  let devices;
  try {
    if (!navigator.mediaDevices?.enumerateDevices) throw new Error('当前浏览器无法读取设备，请通过 localhost 打开网页');
    devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
  } catch (e) {
    if (requestId === cameraListRequestId) info.textContent = `无法读取设备列表：${e.message}；可点击刷新重试`;
    return [];
  }
  if (requestId !== cameraListRequestId) return devices;

  const sel = $('cameraSelect');
  // A device may disappear briefly during driver / virtual-camera changes. Keep its
  // option selected instead of letting <select> fall back to NVIDIA or another device.
  const preferred = preferredCameraId !== null ? preferredCameraId : sel.value || null;
  const model = buildCameraOptionModel(devices, preferred, preferredCameraLabel);
  sel.replaceChildren();
  model.options.forEach(option => {
    const o = document.createElement('option');
    o.value = option.value; o.textContent = option.label; o.disabled = option.disabled;
    sel.appendChild(o);
  });
  if (!model.options.length) {
    const empty = document.createElement('option');
    empty.value = ''; empty.textContent = '未找到摄像头（可刷新列表）'; empty.disabled = true;
    sel.appendChild(empty);
  } else {
    sel.value = model.selectedId;
  }
  const selectedOption = model.options.find(option => option.value === model.selectedId);
  if (preferred && model.selectedId !== preferred && selectedOption && !selectedOption.disabled) {
    preferredCameraId = model.selectedId;
    safeSet(CAMERA_KEY, preferredCameraId);
  }
  info.textContent = selectedOption?.disabled
    ? `浏览器当前未检测到「${preferredCameraLabel || '所选摄像头'}」；实际可用：${devices.map(device => device.label || '未命名摄像头').join('、') || '无'}`
    : !devices.length
    ? '未读取到摄像头，请检查设备及网站权限后刷新列表'
    : devices.some(device => !device.label)
      ? '设备名称可能在允许摄像头权限后显示，可随时刷新列表'
      : `已列出 ${devices.length} 个摄像头`;
  return devices;
}

async function startCamera(deviceId) {
  stopSource();
  const requestId = cameraRequestId;
  let requestedId = deviceId || '';
  if (requestedId) preferredCameraId = requestedId;
  let stream = null;
  try {
    setStatus('正在启动所选摄像头…');
    const opened = await openCameraStream(navigator.mediaDevices, {
      deviceId: requestedId, deviceLabel: preferredCameraLabel,
      isCurrent: () => requestId === cameraRequestId,
      onRetry: () => setStatus('正在以兼容参数重试所选摄像头…', 'warn'),
    });
    if (!opened) return;
    stream = opened.stream;
    requestedId = opened.deviceId || requestedId;
    if (requestId !== cameraRequestId) {
      stream.getTracks().forEach(track => track.stop());
      return;
    }
    const track = stream.getVideoTracks()[0];
    if (!track) throw new Error('没有可用的视频轨道');
    const actualId = track.getSettings().deviceId || '';
    if (requestedId && actualId && actualId !== requestedId) {
      stream.getTracks().forEach(item => item.stop());
      throw new Error('浏览器返回了不同的摄像头，已阻止自动切换');
    }

    video.srcObject = stream;
    await video.play();
    if (requestId !== cameraRequestId) {
      stream.getTracks().forEach(item => item.stop());
      if (video.srcObject === stream) video.srcObject = null;
      return;
    }

    const id = actualId || requestedId;
    if (id) {
      preferredCameraId = id;
      safeSet(CAMERA_KEY, id);
      preferredCameraLabel = track.label || preferredCameraLabel;
      if (preferredCameraLabel) safeSet(CAMERA_LABEL_KEY, preferredCameraLabel);
    }
    await listCameras(); // labels become visible only after permission is granted
    if (requestId !== cameraRequestId) return;

    const settings = track.getSettings();
    setStatus(`摄像头：${track.label}${opened.compatibilityMode ? '（兼容采集）' : ''}`);
    resetStream('camera-change', { deviceLabel: track.label, width: settings.width, height: settings.height, frameRate: settings.frameRate });
    const reportInterruption = () => {
      if (requestId !== cameraRequestId || video.srcObject !== stream) return;
      setStatus(`摄像头“${track.label || '所选设备'}”信号中断；未自动切换。请检查摄像头后重新启动。`, 'warn');
    };
    track.addEventListener('ended', reportInterruption, { once: true });
    let muteTimer = null;
    track.addEventListener('mute', () => {
      clearTimeout(muteTimer);
      muteTimer = setTimeout(() => { if (track.muted) reportInterruption(); }, 1200);
    });
    track.addEventListener('unmute', () => {
      clearTimeout(muteTimer);
      if (requestId === cameraRequestId && video.srcObject === stream) setStatus(`摄像头：${track.label}`);
    });
  } catch (e) {
    if (stream && requestId === cameraRequestId) {
      stream.getTracks().forEach(track => track.stop());
      if (video.srcObject === stream) video.srcObject = null;
    }
    if (requestId === cameraRequestId) {
      const constraintLabels = { deviceId: '设备编号不匹配', width: '画面宽度', height: '画面高度', frameRate: '帧率' };
      const constraint = e.constraint ? `；不满足条件：${constraintLabels[e.constraint] || e.constraint}（${e.constraint}）` : '';
      const detail = e.message || (e.name === 'OverconstrainedError' ? '所选设备或采集条件无法满足，请查看设备列表下方提示' : '浏览器未能取得摄像头画面');
      setStatus(`无法打开摄像头：${e.name || 'Error'}${constraint}；${detail}`, 'err');
      await listCameras(); // Device selection must also remain available after a failed start.
    }
  }
}

function stopSource() {
  cameraRequestId += 1; // invalidate any getUserMedia request still in flight
  quickExperience?.resetBaseline();
  video.srcObject?.getTracks().forEach(t => t.stop());
  video.srcObject = null;
  if (video.src) { URL.revokeObjectURL(video.src); video.removeAttribute('src'); }
  resetCameraFrameMonitor();
}

function openVideoFile(file) {
  stopSource();
  video.src = URL.createObjectURL(file);
  video.loop = true;
  video.play();
  setStatus(`视频文件：${file.name}`);
  resetStream('video-file', { fileName: file.name });
}

function resetStream(reason = null, camera = null) {
  segmenter.reset(); lastVideoTime = -1;
  quickExperience?.resetBaseline();
  if (reason) { startSession(profile, { reason, camera }); persist(); }
}

// ---------------------------------------------------------------- main loop
let fpsCount = 0, fpsT0 = performance.now();
function loop() {
  const now = performance.now();
  if (landmarker && video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    const res = landmarker.detectForVideo(video, now);
    onResult(res, now);
    fpsCount++;
  }
  // Run outside the MediaPipe frame gate so a frozen-but-still-live camera stream
  // is also checked, even if video.currentTime has stopped advancing.
  updateLightingWarning(now);
  if (now - fpsT0 > 1000) { $('fpsPill').textContent = `${Math.round(fpsCount * 1000 / (now - fpsT0))} fps`; fpsCount = 0; fpsT0 = now; }
  requestAnimationFrame(loop);
}

function onResult(res, t) {
  if (testFeed) return; // in test mode only synthetic frames drive the pipeline
  const lm = res.faceLandmarks?.[0];
  const raw = lm ? extractFeatures(lm, res.faceBlendshapes?.[0]?.categories) : null;
  drawOverlay(lm);
  updateFacePositionGuide(lm);
  onFeatures(raw, t);
}

function updateFacePositionGuide(landmarks) {
  const guide = $('faceGuide'), config = profile.settings.cameraAssist;
  if (!config.faceGuideEnabled || !landmarks?.length) { guide.classList.add('hidden'); guide.classList.remove('face-guide-too-close'); return; }
  const xs = landmarks.map(p => p.x).filter(Number.isFinite), ys = landmarks.map(p => p.y).filter(Number.isFinite);
  if (!xs.length || !ys.length) { guide.classList.add('hidden'); guide.classList.remove('face-guide-too-close'); return; }
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const displayCenterX = 1 - (minX + maxX) / 2; // the camera preview is mirrored for the user
  const eyeCornerYs = [33, 133, 263, 362].map(i => landmarks[i]?.y).filter(Number.isFinite);
  const displayEyeY = eyeCornerYs.length === 4
    ? eyeCornerYs.reduce((sum, y) => sum + y, 0) / 4
    : (minY + maxY) / 2;
  const faceWidth = maxX - minX;
  const faceHeight = maxY - minY;
  const tooClose = faceWidth > config.faceMaxWidth || faceHeight > config.faceMaxHeight;
  const targetEyeY = 0.5; // place the eyes near the centre of the displayed camera image
  const corrections = [];
  if (displayCenterX < 0.5 - config.faceCenterToleranceX) corrections.push('脸部偏左，请向右移');
  else if (displayCenterX > 0.5 + config.faceCenterToleranceX) corrections.push('脸部偏右，请向左移');
  if (displayEyeY < targetEyeY - config.faceCenterToleranceY) corrections.push('眼睛偏高，请稍向下');
  else if (displayEyeY > targetEyeY + config.faceCenterToleranceY) corrections.push('眼睛偏低，请稍向上');
  if (faceWidth < config.faceMinWidth) corrections.push('脸部偏小，请靠近摄像头');
  if (tooClose) corrections.push('距离过近，请稍微远离摄像头');
  if (!corrections.length) { guide.classList.add('hidden'); guide.classList.remove('face-guide-too-close'); return; }
  $('faceGuideText').textContent = corrections.join('　·　');
  guide.classList.toggle('face-guide-too-close', tooClose);
  guide.classList.remove('hidden');
}

let lastLightingSampleAt = -Infinity, smoothedLighting = null;
const blackFrameDetector = new SustainedBlackFrameDetector();
let blackFrameWarningActive = false;

function resetCameraFrameMonitor() {
  blackFrameDetector.reset();
  blackFrameWarningActive = false;
  lastLightingSampleAt = -Infinity;
  smoothedLighting = null;
  $('lightingWarning').classList.add('hidden');
}

function updateLightingWarning(timestampMs) {
  const warning = $('lightingWarning'), config = profile.settings.cameraAssist;
  if (video.readyState < 2 || timestampMs - lastLightingSampleAt < 500) return;
  lastLightingSampleAt = timestampMs;
  try {
    lightingContext.drawImage(video, 0, 0, lightingCanvas.width, lightingCanvas.height);
    const pixels = lightingContext.getImageData(0, 0, lightingCanvas.width, lightingCanvas.height).data;
    let total = 0;
    for (let i = 0; i < pixels.length; i += 4) total += 0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2];
    const current = total / (pixels.length / 4);
    const track = video.srcObject?.getVideoTracks?.()[0];
    const cameraActive = track?.readyState === 'live';
    const blackState = blackFrameDetector.update(current, timestampMs, { cameraActive });
    if (blackState.detected) {
      const cameraName = track.label || $('cameraSelect').selectedOptions[0]?.textContent || '当前摄像头';
      const message = `摄像头画面持续黑屏（${Math.round(current)}/255）。请检查遮挡、设备权限或重启“${cameraName}”；不会自动切换。`;
      warning.textContent = message;
      warning.classList.remove('hidden');
      if (blackState.changed) setStatus(message, 'warn');
      blackFrameWarningActive = true;
      return;
    }
    if (blackState.changed && blackFrameWarningActive) {
      blackFrameWarningActive = false;
      if (cameraActive) setStatus(`摄像头画面已恢复：${track.label || '当前摄像头'}`);
    }

    if (!config.lightingWarningEnabled) {
      warning.classList.add('hidden');
      return;
    }
    smoothedLighting = smoothedLighting === null ? current : smoothedLighting * 0.65 + current * 0.35;
    const value = Math.round(smoothedLighting);
    if (value <= config.darkThreshold) {
      warning.textContent = `光线过暗（${value}/255），请增加照明`;
      warning.classList.remove('hidden');
    } else if (value >= config.brightThreshold) {
      warning.textContent = `光线过亮（${value}/255），请避开强光或逆光`;
      warning.classList.remove('hidden');
    } else warning.classList.add('hidden');
  } catch {
    // A frame may briefly be unavailable while a stream is changing; skip this measurement.
  }
}

function onFeatures(raw, t) {
  if (activeTab === 'gazedeck' && mode === 'idle') gazeDeck.frame(raw, t);
  $('noFace').classList.toggle('hidden', !!raw);
  if (!raw) {
    if (activeTab === 'quick' || quickControlSelected) quickExperience?.processFrame(null, t, { showResult: activeTab === 'quick' });
    if (mode === 'testing-window' && guidedTest?.current) guidedTest.current.trackingLost = true;
    if (mode === 'gaze-slider' && gazeSliderSession) {
      gazeSliderSession.controller.pause(t);
      $('gazeSliderState').textContent = '未检测到人脸，调节已暂停';
    }
    segmenter.reset(); return;
  } // a face lost mid-action must not produce a half segment

  if (mode === 'calibrating') { calibFrames.push(raw); return; }
  if (mode === 'gaze-calibrating') {
    if (gazeCalibrationRun?.collecting) {
      const signal = gazeSignal(raw, profile.gazeSlider.settings.headCompensation);
      if (signal !== null) gazeCalibrationRun.samples[gazeCalibrationRun.target].push(signal);
      gazeCalibrationRun.frames[gazeCalibrationRun.target].push(Array.from(raw));
    }
    return;
  }
  if (mode === 'idle' && (activeTab === 'quick' || activeTab === 'gazedeck' && quickControlSelected)) {
    const prediction = quickExperience?.processFrame(raw, t, { showResult: activeTab === 'quick' });
    if (prediction && activeTab === 'gazedeck') gazeDeck.prediction(prediction, t);
    return;
  }
  if (!liveBaseline) { renderMeters(null); return; }

  const z = normalise(raw, liveBaseline, profile.eyeCalibration);
  renderMeters(z);
  if (mode === 'gaze-slider') {
    updateGazeSliderFrame(raw, t);
    const seg = segmenter.push({ raw, normalized: z, timestampMs: t });
    $('segState').textContent = segmenter.isActive ? '● 等待确认动作' : '';
    if (seg) handleGazeSliderSegment(seg, t);
    return;
  }
  if (mode === 'testing-window') {
    const offsetMs = t - guidedTest.current.windowStartedAt;
    guidedTest.current.windowFrames.push({
      offsetMs: Math.round(offsetMs * 1000) / 1000,
      values: Array.from(raw, value => Math.round(value * 100000) / 100000),
    });
  }
  if (mode === 'testing-countdown' || mode === 'testing-review') return;
  if (!segmenter.isActive && mode === 'idle' && !(activeTab === 'gazedeck' && gazeDeck.isAdjusting())) adaptBaseline(liveBaseline, raw, profile.settings.adaptAlpha);

  const seg = segmenter.push({ raw, normalized: z, timestampMs: t });
  $('segState').textContent = segmenter.isActive ? '● 动作进行中' : '';
  if (!seg) return;
  if (mode === 'recording') { recorder.onSegment(seg); return; }
  if (mode === 'testing-window') { recordTestSegment(seg); return; }
  handleSegment(seg, t);
}

function handleSegment(seg, t) {
  if (classifier.labels().length < 2) { log(`检测到动作（${Math.round(seg.durationMs)} ms），但还没有足够的样本来识别`, 'rejected'); return; }
  const p = classifier.predict(seg.frames, seg.durationMs);
  const usingTab = activeTab === 'board' || activeTab === 'music';
  const desc = p.label === UNKNOWN_LABEL ? `未知（最像「${p.guess}」）` : p.label;
  const info = `${desc} · ${Math.round(seg.durationMs)} ms · 距离 ${p.distance.toFixed(2)}`;
  if (activeTab === 'gazedeck') { gazeDeck.prediction(p, t); return; }
  if (!usingTab) { log(info, p.label === REST_LABEL || p.label === UNKNOWN_LABEL ? 'rejected' : ''); flash(desc); return; }

  const d = engine.decide(p, profile.mappings[activeTab] || {}, t);
  if (!d.fired) { log(`${info} → 不执行：${d.reason}`, 'rejected'); return; }
  log(`${info} → ${ACTION_LABELS[d.action] || d.action}`, 'fired');
  flash(`${p.label} → ${ACTION_LABELS[d.action] || d.action}`);
  runAction(d.action);
  renderPause();
}

// ---------------------------------------------------------------- calibration & recording
function countdownThen(seconds, label, fn, isCancelled = () => false) {
  let n = seconds;
  const tick = () => {
    if (isCancelled()) return;
    if (n === 0) { fn(); return; }
    showPrompt(`${n}<br><small>${label}</small>`); beep(660, 0.08); n--; setTimeout(tick, 1000);
  };
  tick();
}

function calibrate() {
  if (mode !== 'idle' || recorder || guidedTest) return;
  if (!video.srcObject && !video.src && !testFeed) { setStatus('请先启动摄像头', 'warn'); return; }
  const ownerId = profile.id;
  mode = 'calibrating';
  calibFrames = [];
  setTabsLocked(true);
  setCaptureWorkspace('calibrating', { title: '静息校准', progress: '请注视画面中央', ratio: 0 });
  countdownThen(3, '准备：放松，看屏幕中央', () => {
    mode = 'calibrating'; calibFrames = [];
    showPrompt('放松，看屏幕中央…'); beep(880, 0.15);
    setTimeout(() => {
      mode = 'idle'; hidePrompt(); setTabsLocked(false); setCaptureWorkspace('idle');
      if (profile.id !== ownerId) { setStatus('用户已变化，本次静息校准未应用', 'warn'); return; }
      if (calibFrames.length < 30) { setStatus(`校准帧太少（${calibFrames.length}），请确认人脸在画面中`, 'err'); return; }
      const preserveRecordedEnvironment = profile.samples.length > 0;
      const stored = addBaseline(profile, computeBaseline(calibFrames, BLENDSHAPE_CHANNELS.length),
        { mediapipeVersion: '0.10.35' }, { activate: !preserveRecordedEnvironment });
      profile.pendingBaselineId = preserveRecordedEnvironment ? stored.id : null;
      liveBaseline = activeBaseline(profile) ? structuredClone(activeBaseline(profile)) : null;
      segmenter.reset();
      rebuildClassifier();
      persist(); renderTrain();
      setStatus(preserveRecordedEnvironment
        ? `新静息校准已保存；仍使用原环境，已保存的 ${profile.samples.length} 个样本保持可用。可在第 1 步明确选择是否启用新环境。`
        : `静息校准完成（${calibFrames.length} 帧）`);
    }, 5000);
  });
}

// One recording session = `repeats` trials of one gesture (or one long free period for the rest class).
let recordingSpaceCheckPending = false;
async function startRecording(label) {
  if (!liveBaseline) { setStatus('请先做静息校准', 'warn'); return; }
  if (recordingSpaceCheckPending) return;
  recordingSpaceCheckPending = true;
  try {
    if (!await hasRecordingSpace(label)) return;
  } finally { recordingSpaceCheckPending = false; }
  startSession(profile, { reason: `record:${label}` }); persist();
  const isRest = label === REST_LABEL;
  const windowMs = isRest ? 20000 : profile.settings.recordWindowMs;
  const target = isRest ? 1 : profile.settings.repeats;
  let done = 0, attempts = 0, inWindow = false, candidates = [], added = 0;
  const pendingSamples = [];
  setTabsLocked(true);
  setCaptureWorkspace('recording', {
    title: `样本录入 · ${label}`,
    progress: isRest ? '自然状态，连续采集 20 秒' : `第 1 / ${target} 次`,
    ratio: 0, canStop: true, stopLabel: '取消本次录入',
  });

  const run = recorder = {
    cancelled: false,
    onSegment(seg) {
      if (!inWindow) return;
      if (isRest) { if (added < 30) { pendingSamples.push(createRawSample(profile, REST_LABEL, seg)); added++; showPrompt(`自然状态录制中…<br><small>已捕获 ${added} 个自然动作</small>`); } }
      else candidates.push(seg);
    },
  };

  const trial = () => {
    if (recorder !== run || run.cancelled) return;
    if (done >= target || attempts >= target * 2) { finish(); return; }
    attempts++;
    setCaptureWorkspace('recording', {
      title: `样本录入 · ${label}`,
      progress: isRest ? '自然状态，连续采集 20 秒' : `第 ${done + 1} / ${target} 次`,
      ratio: target ? done / target : 0, canStop: true, stopLabel: '取消本次录入',
    });
    countdownThen(3, isRest ? '准备：接下来 20 秒请自然地看屏幕、随意眨眼' : `第 ${done + 1}/${target} 次：准备做「${label}」`, () => {
      if (recorder !== run || run.cancelled) return;
      mode = 'recording'; inWindow = true; candidates = []; segmenter.reset();
      showPrompt(isRest ? '自然状态录制中…' : `现在：${label}`); beep(990, 0.15);
      setTimeout(closeWindow, windowMs);
    }, () => recorder !== run || run.cancelled);
  };

  // Let an action that is still going at the end of the window finish (up to 1.5 s more).
  const closeWindow = () => {
    const waitStart = performance.now();
    const check = () => {
      if (recorder !== run || run.cancelled) return;
      if (segmenter.isActive && performance.now() - waitStart < 1500) { setTimeout(check, 50); return; }
      inWindow = false; mode = 'idle';
      if (!isRest) {
        if (candidates.length) {
          // The strongest motion in the window is taken to be the requested action.
          pendingSamples.push(createRawSample(profile, label, candidates.reduce((a, b) => (b.peakActivity > a.peakActivity ? b : a))));
          done++; beep(1320, 0.06);
        } else { showPrompt('没检测到动作，再来一次'); beep(220, 0.2); }
      } else done = 1;
      setTimeout(trial, 900);
    };
    check();
  };

  const finish = () => {
    if (recorder !== run || run.cancelled) return;
    profile.samples.push(...pendingSamples);
    recorder = null; mode = 'idle'; hidePrompt(); setTabsLocked(false);
    setCaptureWorkspace('idle');
    rebuildClassifier(); persist(); renderTrain();
    setStatus(isRest ? `「自然」录到 ${added} 个样本` : `「${label}」录到 ${done} 个样本`);
  };
  trial();
}

function cancelRecording() {
  const run = recorder;
  if (!run) return;
  run.cancelled = true;
  recorder = null; mode = 'idle'; segmenter.reset(); hidePrompt(); setTabsLocked(false);
  setCaptureWorkspace('idle');
  renderTrain();
  setStatus('已取消本次样本录入；此前已保存的样本未改变');
}

// ---------------------------------------------------------------- personalized eye-range calibration and continuous slider control
const GAZE_TARGETS = [
  { key: 'center', label: '中央', cls: 'gaze-center' },
  { key: 'left', label: '左侧', cls: 'gaze-left' },
  { key: 'right', label: '右侧', cls: 'gaze-right' },
  { key: 'up', label: '上方', cls: 'gaze-up' },
  { key: 'down', label: '下方', cls: 'gaze-down' },
];

function showGazeTarget(target, text) {
  const prompt = $('prompt');
  prompt.classList.remove('gaze-left', 'gaze-center', 'gaze-right', 'gaze-up', 'gaze-down');
  prompt.classList.add('gaze-target-prompt', target.cls);
  const guidance = gazeCalibrationRun?.kind === 'slider'
    ? '请保持头部自然稳定，注视蓝色目标点。'
    : target.key === 'center'
    ? '请自然看向屏幕中央。'
    : '请保持头部自然稳定，视线朝目标方向移动到可舒适保持的最远位置。';
  showPrompt(`<span class="gaze-dot">●<small>${text}</small></span><span class="gaze-calibration-guide">${guidance}</span>`);
}

function clearGazeTargetPrompt() {
  $('prompt').classList.remove('gaze-target-prompt', 'gaze-left', 'gaze-center', 'gaze-right', 'gaze-up', 'gaze-down');
  hidePrompt();
}

function startGazeCalibration(kind = 'personal') {
  if (mode !== 'idle') return;
  if (!liveBaseline) { setStatus('请先完成静息校准', 'warn'); return; }
  if (!video.srcObject && !video.src && !testFeed) { setStatus('请先启动摄像头', 'warn'); return; }
  mode = 'gaze-calibrating';
  segmenter.reset(); setTabsLocked(true);
  gazeCalibrationRun = beginGazeCalibrationRun(profile);
  gazeCalibrationRun.kind = kind;
  // Freeze the selected pace for this run; changing a setting later cannot
  // shorten a countdown or sampling window that is already in progress.
  gazeCalibrationRun.durationFactor = calibrationDurationFactor(profile.settings.calibrationPace?.[kind]);
  gazeCalibrationRun.targets = kind === 'slider'
    ? ['left', 'center', 'right'].map(key => GAZE_TARGETS.find(target => target.key === key))
    : GAZE_TARGETS;
  runGazeCalibrationTarget(0);
}

function runGazeCalibrationTarget(index) {
  const run = gazeCalibrationRun;
  if (!run || run.cancelled) return;
  if (index >= run.targets.length) { finishGazeCalibration(); return; }
  const target = run.targets[index];
  const sliderOnly = run.kind === 'slider';
  run.target = target.key; run.collecting = false;
  setCaptureWorkspace('gaze-calibrating', {
    title: sliderOnly ? '视线滑块校准' : '个性化眼动校准', progress: `${index + 1} / ${run.targets.length} · 看${target.label}`, ratio: index / run.targets.length,
    canStop: true, stopLabel: '取消本次校准',
  });
  const factor = run.durationFactor;
  const baseCountdown = sliderOnly ? (target.key === 'center' ? 2 : 1) : (target.key === 'center' ? 3 : 2);
  let n = Math.round(baseCountdown * factor);
  let captures = 0;
  const captureCount = sliderOnly || target.key === 'center' ? 1 : 2;
  const captureMs = Math.round((sliderOnly ? 1100 : (target.key === 'center' ? 1600 : 1000)) * factor);
  const tick = () => {
    if (gazeCalibrationRun !== run || run.cancelled) return;
    if (n > 0) {
      showGazeTarget(target, sliderOnly ? `${n} 秒后看${target.label}目标点` : target.key === 'center' ? `${n} 秒后自然看中央` : `${n} 秒后看${target.label}舒适最远处`);
      beep(660, 0.08); n--; setTimeout(tick, 1000); return;
    }
    captures++;
    run.collecting = true;
    showGazeTarget(target, sliderOnly ? `请注视${target.label}蓝色目标点并保持` : target.key === 'center'
      ? '自然看中央并保持'
      : `第 ${captures} / ${captureCount} 次：保持在${target.label}可舒适保持的最远位置`);
    beep(990, 0.12);
    setTimeout(() => {
      if (gazeCalibrationRun !== run || run.cancelled) return;
      run.collecting = false;
      if (captures < captureCount) { setTimeout(tick, Math.round(250 * factor)); return; }
      setTimeout(() => {
        if (gazeCalibrationRun === run && !run.cancelled) runGazeCalibrationTarget(index + 1);
      }, Math.round(350 * factor));
    }, captureMs);
  };
  tick();
}

function finishGazeCalibration() {
  const run = gazeCalibrationRun;
  let personalResult = null, personalError = null;
  try {
    if (run.kind === 'slider') {
      profile.gazeSlider.calibration = buildGazeCalibration(run.samples, { baselineId: profile.activeBaselineId });
      persist();
      setStatus('滑块左右标尺校准完成；已有动作样本与个性化眼动校准未改变');
      return;
    }
    personalResult = buildPersonalEyeCalibration(run.frames, activeBaseline(profile), { baselineId: profile.activeBaselineId });
    const hasSamplesForBaseline = profile.samples.some(sample => sample.baselineId === profile.activeBaselineId);
    const previous = profile.eyeCalibration;
    if (hasSamplesForBaseline && previous?.baselineId === profile.activeBaselineId && previous.applied) {
      // Keep the exact feature scaling used by existing samples; recalibration must not silently
      // change their meaning. A new baseline with no samples can adopt a fresh personalized scale.
      personalResult = previous;
      personalError = '本次范围已测量；为保持已有样本的特征尺度，保留了原校准参数';
    } else {
      personalResult.applied = !hasSamplesForBaseline;
      profile.eyeCalibration = personalResult;
      if (hasSamplesForBaseline) personalError = '已保存眼动范围参考；为保护已有样本，本次未应用新的轴向增益';
    }

    persist();
    rebuildClassifier();
    const axisLabel = status => status === 'good' ? '良好' : status === 'partial' ? '一般' : '偏弱';
    const appliedText = personalError || (personalResult.applied ? '温和的个性化轴向增益已启用' : '轴向增益未应用');
    setStatus(`眼动校准完成：横向${axisLabel(personalResult.axes.horizontal.status)}、纵向${axisLabel(personalResult.axes.vertical.status)}；${appliedText}`,
      personalResult.axes.horizontal.status === 'weak' || personalResult.axes.vertical.status === 'weak' ? 'warn' : '');
  } catch (e) {
    setStatus(`${run.kind === 'slider' ? '视线滑块' : '个性化眼动'}校准失败：${e.message}`, 'err');
  } finally {
    gazeCalibrationRun = null; mode = 'idle'; clearGazeTargetPrompt(); setTabsLocked(false); setCaptureWorkspace('idle'); renderTrain();
  }
}

function cancelGazeCalibration({ silent = false } = {}) {
  const run = gazeCalibrationRun;
  if (!run) return;
  cancelGazeCalibrationRun(profile, run);
  gazeCalibrationRun = null;
  mode = 'idle';
  segmenter.reset();
  clearGazeTargetPrompt();
  setTabsLocked(false);
  setCaptureWorkspace('idle');
  rebuildClassifier();
  persist();
  renderTrain();
  if (!silent) setStatus(`已取消本次${run.kind === 'slider' ? '视线滑块' : '个性化眼动'}校准；原有动作样本未改变`);
}

const SLIDER_TARGETS = {
  [GAZE_SLIDER_ACTIONS.volume]: {
    id: 'volume', label: '音量', min: 0, max: 100, unit: '%',
    get: () => profile.music.volume,
    set: value => { profile.music.volume = Math.round(value); beatBox.setVolume(profile.music.volume); trackAudio.volume = profile.music.volume / 100; },
  },
  [GAZE_SLIDER_ACTIONS.bpm]: {
    id: 'bpm', label: '伴奏速度', min: 50, max: 140, unit: ' BPM',
    get: () => profile.music.bpm,
    set: value => { profile.music.bpm = Math.round(value); beatBox.bpm = profile.music.bpm; renderMusic(); },
  },
  [GAZE_SLIDER_ACTIONS.effect]: {
    id: 'effect', label: '加花强度', min: 0, max: 100, unit: '%',
    get: () => profile.music.effectIntensity,
    set: value => { profile.music.effectIntensity = Math.round(value); beatBox.setEffectIntensity(profile.music.effectIntensity); },
  },
  [GAZE_SLIDER_ACTIONS.track]: {
    id: 'track', label: '选择曲目', min: 0, get max() { return tracks.length * TRACK_VALUE_STEP; }, unit: '',
    get: () => trackValueForIndex(selectedTrackIndex < 0 ? 0 : selectedTrackIndex, tracks.length),
    set: value => previewTrack(value),
    commit: value => selectTrack(trackIndexForValue(value, tracks.length)),
    formatValue: value => `曲目 ${trackIndexForValue(value, tracks.length) + 1}/${tracks.length}`,
    persist: false,
  },
};

function previewTrack(value) {
  const index = trackIndexForValue(value, tracks.length);
  if (index === previewTrackIndex) return;
  previewTrackIndex = index;
  const list = $('gazeTrackList');
  for (const [i, row] of [...list.children].entries()) {
    row.classList.toggle('active', i === index);
    if (i === index) row.setAttribute('aria-current', 'true');
    else row.removeAttribute('aria-current');
  }
  const selected = list.children[index];
  if (selected) {
    const outer = list.getBoundingClientRect(), inner = selected.getBoundingClientRect();
    if (inner.top < outer.top) list.scrollTop += inner.top - outer.top;
    else if (inner.bottom > outer.bottom) list.scrollTop += inner.bottom - outer.bottom;
  }
}

function selectTrack(index) {
  if (index < 0 || index >= tracks.length) return;
  if (index === selectedTrackIndex) return;
  trackAudio.pause();
  selectedTrackIndex = index;
  trackAudio.src = tracks[index].url;
  trackAudio.volume = profile.music.volume / 100;
  trackAudio.load();
  renderMusic();
  trackAudio.play().catch(() => setStatus('曲目已载入；浏览器阻止自动播放，请点击播放器的播放键', 'warn'));
}

function validGazeCalibration() {
  const c = profile.gazeSlider.calibration;
  return c && c.baselineId === profile.activeBaselineId;
}

function openGazeSlider(action) {
  const target = SLIDER_TARGETS[action];
  if (!target || mode !== 'idle') return;
  if (target.id === 'track' && !tracks.length) { setStatus('请先在④节拍伴奏中添加本机音频曲目', 'warn'); return; }
  if (!profile.gazeSlider.settings.enabled) { setStatus('视线滑块已在⑤设置中关闭', 'warn'); return; }
  if (!validGazeCalibration()) { setStatus('请先在①校准与录制中完成当前环境的视线滑块校准', 'warn'); flash('需要视线滑块校准'); return; }
  if (!video.srcObject && !video.src && !testFeed) { setStatus('请先启动摄像头', 'warn'); return; }
  const initialValue = Number(target.get());
  const controller = new GazeSliderController(profile.gazeSlider.calibration, profile.gazeSlider.settings, {
    min: target.min, max: target.max, initialValue,
  });
  gazeSliderSession = { target, controller, initialValue, openedAt: performance.now(), timeoutId: null, lastCommandT: -Infinity };
  mode = 'gaze-slider'; segmenter.reset();
  document.body.classList.add('gaze-slider-mode');
  $('gazeSliderOverlay').classList.remove('hidden');
  const trackMode = target.id === 'track';
  $('gazeSliderOverlay').classList.toggle('track-picker-mode', trackMode);
  $('gazeTrackList').classList.toggle('hidden', !trackMode);
  if (trackMode) {
    const rows = tracks.map((track, index) => {
      const row = document.createElement('li');
      const low = index * TRACK_VALUE_STEP + 1;
      const high = (index + 1) * TRACK_VALUE_STEP;
      row.textContent = `${index + 1}. ${track.name}（滑块 ${low}–${high}）`;
      return row;
    });
    $('gazeTrackList').replaceChildren(...rows);
    previewTrackIndex = -1;
    previewTrack(initialValue);
  }
  $('gazeSliderTitle').textContent = target.label;
  $('gazeSliderHelp').textContent = `向左看${trackMode ? '选前一首' : '减少'}，向右看${trackMode ? '选后一首' : '增加'}，回到中央停止；上看恢复打开时原值（保持弹窗），下看保留当前值并关闭。${trackMode ? '关闭前仅预选，下看后载入并播放所选曲目。' : ''}`;
  $('cancelGazeSlider').textContent = '上看 · 恢复打开时原值';
  $('confirmGazeSlider').textContent = '下看 · 保留并关闭';
  setCaptureWorkspace('gaze-slider', { title: `连续控制 · ${target.label}`, progress: '先看中央，再向左右调节', ratio: (initialValue - target.min) / (target.max - target.min) });
  renderGazeSlider({ value: initialValue, zone: 'center', rate: 0, position: 0 });
  armGazeSliderTimeout(gazeSliderSession);
}

function armGazeSliderTimeout(session) {
  clearTimeout(session.timeoutId);
  session.timeoutId = setTimeout(() => {
    if (mode === 'gaze-slider' && gazeSliderSession === session) finishGazeSlider(false, '操作超时，已恢复原值');
  }, profile.gazeSlider.settings.timeoutMs);
}

function restoreGazeSlider() {
  const session = gazeSliderSession; if (!session) return;
  session.controller.value = session.initialValue;
  session.controller.pause(performance.now());
  session.target.set(session.initialValue); segmenter.reset();
  renderGazeSlider({ value: session.initialValue, zone: 'center', rate: 0 });
  $('gazeSliderState').textContent = '已恢复打开时的原始数值；弹窗仍打开，下看保留并关闭';
  armGazeSliderTimeout(session);
}

function updateGazeSliderFrame(raw, t) {
  const session = gazeSliderSession;
  if (!session) return;
  const snapshot = session.controller.updateFrame(raw, t);
  session.target.set(snapshot.value);
  renderGazeSlider(snapshot);
}

function renderGazeSlider(snapshot) {
  const session = gazeSliderSession; if (!session) return;
  const { target } = session;
  const value = Math.round(snapshot.value);
  const ratio = (snapshot.value - target.min) / (target.max - target.min);
  $('gazeSliderValue').textContent = target.formatValue ? target.formatValue(snapshot.value) : `${value}${target.unit}`;
  $('gazeSliderOverlay').style.setProperty('--slider-position', `${Math.max(0, Math.min(1, ratio)) * 100}%`);
  $('captureProgressBar').style.width = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
  const states = {
    center: '中央停止区 · 数值保持不变',
    'left-wait': '保持向左注视…', 'right-wait': '保持向右注视…',
    left: `正在减少 · ${Math.abs(snapshot.rate).toFixed(0)} / 秒`,
    right: `正在增加 · ${Math.abs(snapshot.rate).toFixed(0)} / 秒`,
    lost: '未检测到人脸，调节已暂停',
  };
  $('gazeSliderState').textContent = states[snapshot.zone] || '请看中央';
}

function handleGazeSliderSegment(seg, t) {
  if (!gazeSliderSession || classifier.labels().length < 2) return;
  const prediction = classifier.predict(seg.frames, seg.durationMs);
  if (prediction.margin < engine.settings.minMargin || t - gazeSliderSession.lastCommandT < engine.settings.refractoryMs) return;
  if (prediction.label === SLIDER_GESTURES.keep) {
    gazeSliderSession.lastCommandT = t;
    log('滑块「下看」保留当前数值并关闭', 'fired'); finishGazeSlider(true); return;
  }
  if (prediction.label === SLIDER_GESTURES.restore) {
    gazeSliderSession.lastCommandT = t;
    log('滑块「上看」恢复打开时原值，保持弹窗', 'fired'); restoreGazeSlider(); return;
  }
  if (prediction.label !== REST_LABEL && prediction.label !== UNKNOWN_LABEL) {
    $('gazeSliderState').textContent = `检测到「${prediction.label}」；上看恢复原值，下看保留并关闭`;
  }
}

function finishGazeSlider(save, message = '') {
  const session = gazeSliderSession; if (!session) return;
  clearTimeout(session.timeoutId);
  if (!save) session.target.set(session.initialValue);
  else {
    session.target.commit?.(session.controller.value);
    if (session.target.persist !== false) persist();
  }
  const finalValue = Math.round(save ? session.controller.value : session.initialValue);
  const label = session.target.label, unit = session.target.unit;
  const trackMode = session.target.id === 'track';
  gazeSliderSession = null; mode = 'idle'; segmenter.reset();
  document.body.classList.remove('gaze-slider-mode');
  $('gazeSliderOverlay').classList.add('hidden');
  $('gazeSliderOverlay').classList.remove('track-picker-mode');
  $('gazeTrackList').classList.add('hidden');
  setCaptureWorkspace('idle'); renderMusic();
  const statusText = trackMode
    ? (save ? `已选择曲目「${tracks[selectedTrackIndex]?.name || ''}」` : '曲目选择已取消，原曲目未改变')
    : (save ? `${label}已保存为 ${finalValue}${unit}` : `${label}已取消并恢复`);
  setStatus(message || statusText);
}

function activeSamples() { return profile.samples.filter(s => s.baselineId === profile.activeBaselineId); }

function rebuildClassifier() {
  classifier = new GestureClassifier(profile.settings.classifier);
  classifier.fit(activeSamples().map(s => materialiseSample(profile, s)).filter(Boolean));
}

function classifierFromSamples(samples) {
  const result = new GestureClassifier(profile.settings.classifier);
  result.fit(samples.map(s => materialiseSample(profile, s)).filter(Boolean));
  return result;
}

// ---------------------------------------------------------------- guided test and controlled improvement
function renderTestSetup() {
  $('testGestureChoices').innerHTML = profile.gestures.filter(g => g !== REST_LABEL).map(g =>
    `<label><input type="checkbox" value="${g}" checked> ${g}</label>`).join('');
  $('actualGesture').innerHTML = profile.gestures.map(g => `<option value="${g}">${g}</option>`).join('');
}

function selectedTestGestures() {
  return [...document.querySelectorAll('#testGestureChoices input:checked')].map(x => x.value);
}

function beginGuidedTest(phase) {
  if (!liveBaseline) { setStatus('请先做静息校准', 'warn'); return; }
  if (!video.srcObject && !video.src && !testFeed) { setStatus('请先启动摄像头', 'warn'); return; }
  if (classifier.labels().length < 2) { setStatus('至少先录制两类样本再进行测试', 'warn'); return; }
  const labels = guidedTest?.selectedLabels ?? selectedTestGestures();
  if (!labels.length) { setStatus('请至少选择一个动作', 'warn'); return; }
  const repeats = phase === 'confirmation' ? Math.max(3, +$('testRepeats').value) : +$('testRepeats').value;
  const includeRest = $('testIncludeRest').checked;
  const trials = buildTrials(labels, repeats, { includeRest, seed: Date.now() & 0xffffffff });
  if (phase === 'tuning') {
    startSession(profile, { reason: 'test:tuning' });
    guidedTest = {
      id: crypto.randomUUID(), phase, selectedLabels: labels, repeats, includeRest, trials, index: 0,
      countClosestGuess: profile.settings.testCountClosestGuess === true,
      baselineId: profile.activeBaselineId, sessionId: profile.activeSessionId, startedAt: Date.now(),
      baselineClassifier: classifierFromSamples(activeSamples()), candidateSamples: [], candidateClassifier: null,
      tuningTrials: null, confirmationTrials: null, cancelled: false, current: null,
    };
  } else {
    startSession(profile, { reason: 'test:confirmation' });
    guidedTest.phase = phase; guidedTest.trials = trials; guidedTest.index = 0;
    guidedTest.sessionId = profile.activeSessionId; guidedTest.cancelled = false; guidedTest.current = null;
  }
  persist();
  $('testSetup').classList.add('hidden'); $('testResults').innerHTML = ''; $('testActions').classList.add('hidden');
  $('testResultActions').classList.add('hidden');
  $('testRunning').classList.remove('hidden'); $('testPhaseTitle').textContent = phase === 'tuning' ? '调优测试' : '独立确认测试';
  setCaptureWorkspace('testing-countdown', {
    title: phase === 'tuning' ? '调优测试' : '独立确认测试', progress: `1 / ${trials.length}`, ratio: 0, canStop: true,
  });
  runNextTestTrial();
}

function runNextTestTrial() {
  if (!guidedTest || guidedTest.cancelled) return;
  if (guidedTest.index >= guidedTest.trials.length) { finishGuidedPhase(); return; }
  const trial = guidedTest.trials[guidedTest.index];
  guidedTest.current = Object.assign(trial, { events: [], windowFrames: [], bestSegment: null, trackingLost: false });
  updateTestProgress();
  mode = 'testing-countdown'; segmenter.reset();
  setCaptureWorkspace('testing-countdown', {
    title: guidedTest.phase === 'tuning' ? '调优测试' : '独立确认测试',
    progress: `${guidedTest.index + 1} / ${guidedTest.trials.length}`,
    ratio: guidedTest.index / guidedTest.trials.length,
    canStop: true,
  });
  let n = 3;
  const tick = () => {
    if (!guidedTest || guidedTest.cancelled) return;
    if (n === 0) { openTestWindow(); return; }
    showPrompt(`${n}<br><small>准备：${trial.targetLabel === REST_LABEL ? '保持自然，不做指定动作' : `即将做「${trial.targetLabel}」`}</small>`);
    beep(660, 0.08); n--; setTimeout(tick, 1000);
  };
  tick();
}

function openTestWindow() {
  if (!guidedTest || guidedTest.cancelled) return;
  segmenter.reset(); mode = 'testing-window';
  guidedTest.current.windowStartedAt = performance.now();
  showPrompt(guidedTest.current.targetLabel === REST_LABEL ? '保持自然…' : `现在：${guidedTest.current.targetLabel}`);
  beep(990, 0.15);
  setTimeout(closeTestWindow, profile.settings.recordWindowMs);
}

function recordTestSegment(seg) {
  const before = guidedTest.baselineClassifier.predict(seg.frames, seg.durationMs);
  const after = guidedTest.phase === 'confirmation' && guidedTest.candidateClassifier
    ? guidedTest.candidateClassifier.predict(seg.frames, seg.durationMs) : before;
  guidedTest.current.events.push({ segment: seg, before, after });
}

function closeTestWindow() {
  if (!guidedTest || guidedTest.cancelled || mode !== 'testing-window') return;
  const waitStarted = performance.now();
  const check = () => {
    if (!guidedTest || guidedTest.cancelled) return;
    if (segmenter.isActive && performance.now() - waitStarted < 1500) { setTimeout(check, 50); return; }
    const trial = guidedTest.current;
    const best = trial.events.reduce((a, b) => !a || b.segment.peakActivity > a.segment.peakActivity ? b : a, null);
    trial.bestSegment = best?.segment ?? null;
    trial.predictedBefore = best?.before.label ?? REST_LABEL;
    trial.predictedBeforeGuess = best?.before.guess ?? null;
    trial.predictedAfter = best?.after.label ?? REST_LABEL;
    trial.predictedAfterGuess = best?.after.guess ?? null;
    trial.predictedLabel = guidedTest.phase === 'confirmation' ? trial.predictedAfter : trial.predictedBefore;
    trial.predictedGuess = guidedTest.phase === 'confirmation' ? trial.predictedAfterGuess : trial.predictedBeforeGuess;
    trial.distance = guidedTest.phase === 'confirmation' ? best?.after.distance : best?.before.distance;
    mode = 'testing-review'; hidePrompt(); showTestReview(trial);
  };
  check();
}

function showTestReview(trial) {
  setCaptureWorkspace('testing-review', {
    title: guidedTest.phase === 'tuning' ? '调优测试 · 确认结果' : '独立确认测试 · 确认结果',
    progress: `${guidedTest.index + 1} / ${guidedTest.trials.length}`,
    ratio: (guidedTest.index + 1) / guidedTest.trials.length,
    canStop: true,
  });
  $('testReview').classList.remove('hidden');
  $('testTarget').textContent = trial.targetLabel === REST_LABEL ? '保持自然' : trial.targetLabel;
  $('testPrediction').textContent = trial.predictedLabel === UNKNOWN_LABEL && trial.predictedGuess
    ? `未知（最像「${trial.predictedGuess}」）` : trial.predictedLabel;
  $('testTrialDetail').textContent = `${trial.events.length} 个候选事件${Number.isFinite(trial.distance) ? `，距离 ${trial.distance.toFixed(2)}` : ''}${trial.trackingLost ? '；期间曾丢失人脸，建议作废' : ''}`;
  $('actualGesture').value = trial.targetLabel;
}

function reviewCurrentTrial(status, actualLabel = null) {
  if (!guidedTest?.current || mode !== 'testing-review') return;
  const trial = guidedTest.current;
  trial.reviewStatus = status; trial.actualLabel = status === 'invalid' ? null : actualLabel;
  trial.correct = status !== 'invalid' && isSuccessfulPrediction(actualLabel, trial.predictedLabel, {
    guess: trial.predictedGuess, countClosestGuess: guidedTest.countClosestGuess,
  });
  // Typed arrays are only needed until candidate samples are built; the audit keeps the full raw window.
  $('testReview').classList.add('hidden'); guidedTest.index++; mode = 'testing-countdown';
  runNextTestTrial();
}

function candidateSamplesFromTuning(trials) {
  const samples = [];
  for (const trial of trials) {
    if (trial.reviewStatus === 'invalid' || !trial.actualLabel || !trial.bestSegment) continue;
    if (isSuccessfulPrediction(trial.actualLabel, trial.predictedBefore, {
      guess: trial.predictedBeforeGuess, countClosestGuess: guidedTest.countClosestGuess,
    })) continue;
    samples.push(createRawSample(profile, trial.actualLabel, trial.bestSegment));
  }
  return samples;
}

function auditTrial(trial) {
  return {
    id: trial.id, targetLabel: trial.targetLabel, actualLabel: trial.actualLabel,
    predictedBefore: trial.predictedBefore, predictedAfter: trial.predictedAfter,
    predictedBeforeGuess: trial.predictedBeforeGuess, predictedAfterGuess: trial.predictedAfterGuess,
    predictedLabel: trial.predictedLabel, predictedGuess: trial.predictedGuess,
    reviewStatus: trial.reviewStatus,
    eventCount: trial.events.length, distance: trial.distance, trackingLost: trial.trackingLost,
    windowFrames: trial.windowFrames,
  };
}

function finishGuidedPhase() {
  mode = 'idle'; hidePrompt(); $('testRunning').classList.add('hidden'); $('testReview').classList.add('hidden');
  setCaptureWorkspace('idle');
  if (guidedTest.phase === 'tuning') {
    guidedTest.tuningTrials = guidedTest.trials;
    guidedTest.candidateSamples = candidateSamplesFromTuning(guidedTest.trials);
    guidedTest.candidateClassifier = classifierFromSamples([...activeSamples(), ...guidedTest.candidateSamples]);
    const summary = summariseTrials(guidedTest.trials, 'predictedBefore', guidedTest);
    profile.testRuns.push({ id: guidedTest.id, phase: 'tuning', createdAt: Date.now(), baselineId: guidedTest.baselineId,
      sessionId: guidedTest.sessionId, selectedLabels: guidedTest.selectedLabels,
      countClosestGuess: guidedTest.countClosestGuess, candidateCount: guidedTest.candidateSamples.length,
      summary, trials: guidedTest.trials.map(auditTrial) });
    profile.latestTestRunId = guidedTest.id;
    persist(); renderStoredTestResult();
    $('startConfirmationTest').classList.toggle('hidden', !guidedTest.candidateSamples.length);
    $('applyTestImprovement').classList.add('hidden'); $('testActions').classList.remove('hidden');
  } else {
    guidedTest.confirmationTrials = guidedTest.trials;
    const before = summariseTrials(guidedTest.trials, 'predictedBefore', guidedTest);
    const after = summariseTrials(guidedTest.trials, 'predictedAfter', guidedTest);
    const promotable = shouldPromoteCandidate(before, after);
    const confirmationId = crypto.randomUUID();
    profile.testRuns.push({ id: confirmationId, parentId: guidedTest.id, phase: 'confirmation', createdAt: Date.now(),
      baselineId: guidedTest.baselineId, sessionId: guidedTest.sessionId,
      countClosestGuess: guidedTest.countClosestGuess, before, after, promotable,
      trials: guidedTest.trials.map(auditTrial) });
    profile.latestTestRunId = confirmationId;
    persist(); renderStoredTestResult();
    $('startConfirmationTest').classList.add('hidden');
    $('applyTestImprovement').classList.toggle('hidden', !promotable); $('testActions').classList.remove('hidden');
  }
}

function pct(value) { return Number.isFinite(value) ? `${Math.round(value * 100)}%` : '—'; }
const escapeTestHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));
function metricCards(summary, title, countClosestGuess) {
  const rows = Object.entries(summary.byLabel).map(([label, value]) => {
    const row = value && typeof value === 'object' ? value : {};
    return `<tr><td>${escapeTestHtml(label)}</td><td>${escapeTestHtml(row.success)}/${escapeTestHtml(row.total)}</td><td>${pct(row.rate)}</td><td>${Object.entries(row.predictions || {}).map(([p, n]) => `${escapeTestHtml(p)}:${escapeTestHtml(n)}`).join('、')}</td></tr>`;
  }).join('');
  return `<h3>${title}</h3><div class="metric-cards">
    <div class="metric-card">正面成功率<strong>${pct(summary.positive.rate)}</strong>${escapeTestHtml(summary.positive.success)}/${escapeTestHtml(summary.positive.total)}</div>
    <div class="metric-card">负面成功率<strong>${pct(summary.negative.rate)}</strong>${escapeTestHtml(summary.negative.success)}/${escapeTestHtml(summary.negative.total)}</div>
    <div class="metric-card">平衡成功率<strong>${pct(summary.balancedAccuracy)}</strong></div>
    <div class="metric-card">作废 / 未知检测<strong>${escapeTestHtml(summary.invalid)} / ${escapeTestHtml(summary.unknown)}</strong></div>
  </div><table><thead><tr><th>实际动作</th><th>成功</th><th>成功率</th><th>检测分布</th></tr></thead><tbody>${rows}</tbody></table>
  <p class="muted">实际动作为自然时，检测为“自然”或“未知”均计为防误触成功。${countClosestGuess ? '实际动作为指定动作时，“未知”且最像实际动作也计为成功。' : '实际动作为指定动作时，“未知”不计为成功。'}未知检测次数仍单独显示。</p>`;
}
function renderTestSummary(before, after, { candidateCount, countClosestGuess } = {}) {
  let html = metricCards(before, after ? '原模型（同一确认集）' : '调优测试', countClosestGuess);
  if (!after) {
    if (Number.isSafeInteger(candidateCount) && candidateCount >= 0) html += `<p>已从人工确认的错误片段生成 <b>${candidateCount}</b> 个候选模板。${candidateCount ? '请用全新试次进行独立确认。' : '没有可用于修正的完整错误片段。'}</p>`;
  } else {
    const ok = shouldPromoteCandidate(before, after);
    html += metricCards(after, '候选模型（同一确认集）', countClosestGuess);
    html += `<p class="comparison ${ok ? 'good' : 'bad'}"><b>${ok ? '候选模型达到应用条件' : '候选模型未达到应用条件'}</b>：平衡成功率必须提高，且负面成功率不得降低。</p>`;
  }
  $('testResults').innerHTML = html;
}
function latestSavedTestRun() {
  return profile.testRuns.find(run => run?.id === profile.latestTestRunId) ?? null;
}
function renderStoredTestResult() {
  const run = latestSavedTestRun();
  const before = run?.phase === 'confirmation' ? run.before : run?.phase === 'tuning' ? run.summary : null;
  const after = run?.phase === 'confirmation' ? run.after : null;
  const validSummary = summary => summary?.byLabel && typeof summary.byLabel === 'object'
    && !Array.isArray(summary.byLabel) && summary.positive && summary.negative;
  const valid = validSummary(before) && (run.phase !== 'confirmation' || validSummary(after));
  if (valid) renderTestSummary(before, after, run);
  else $('testResults').innerHTML = '';
  $('testResultActions').classList.toggle('hidden', !valid);
}

function updateTestProgress() {
  const done = guidedTest.index, total = guidedTest.trials.length;
  $('testProgressBar').style.width = `${total ? done / total * 100 : 0}%`;
  $('testProgressText').textContent = `${done + 1} / ${total}：${guidedTest.current.targetLabel === REST_LABEL ? '保持自然' : guidedTest.current.targetLabel}`;
}

function stopGuidedTest() {
  if (!guidedTest) return;
  guidedTest.cancelled = true; guidedTest = null; mode = 'idle'; segmenter.reset(); hidePrompt();
  $('testRunning').classList.add('hidden'); $('testReview').classList.add('hidden'); $('testActions').classList.add('hidden');
  setCaptureWorkspace('idle');
  $('testSetup').classList.remove('hidden'); renderStoredTestResult(); setStatus('测试已停止');
}

// ---------------------------------------------------------------- actions
const ACTION_LABELS = {
  '': '（无）', [PAUSE_ACTION]: '暂停/恢复',
  prev: '上一个', next: '下一个', select: '选择/朗读',
  toggleLoop: '开始/停止伴奏', chordPrev: '上一个和弦', chordNext: '下一个和弦', accent: '加花音',
  [GAZE_SLIDER_ACTIONS.volume]: '打开滑块：音量',
  [GAZE_SLIDER_ACTIONS.bpm]: '打开滑块：伴奏速度',
  [GAZE_SLIDER_ACTIONS.effect]: '打开滑块：加花强度',
  [GAZE_SLIDER_ACTIONS.track]: '打开弹窗：选择曲目',
};
const MODE_ACTIONS = {
  board: ['', 'prev', 'next', 'select', GAZE_SLIDER_ACTIONS.volume, PAUSE_ACTION],
  music: ['', 'toggleLoop', 'chordPrev', 'chordNext', 'accent', GAZE_SLIDER_ACTIONS.volume,
    GAZE_SLIDER_ACTIONS.bpm, GAZE_SLIDER_ACTIONS.effect, GAZE_SLIDER_ACTIONS.track, PAUSE_ACTION],
};

let boardIndex = 0, scanTimer = null;
function runAction(action) {
  switch (action) {
    case 'prev': boardIndex = (boardIndex - 1 + profile.board.phrases.length) % profile.board.phrases.length; renderBoard(); break;
    case 'next': boardIndex = (boardIndex + 1) % profile.board.phrases.length; renderBoard(); break;
    case 'select': selectPhrase(); break;
    case 'toggleLoop': beatBox.toggle(); renderMusic(); break;
    case 'chordPrev': beatBox.changeChord(-1); renderMusic(); break;
    case 'chordNext': beatBox.changeChord(+1); renderMusic(); break;
    case 'accent': beatBox.accent(); break;
    case GAZE_SLIDER_ACTIONS.volume:
    case GAZE_SLIDER_ACTIONS.bpm:
    case GAZE_SLIDER_ACTIONS.effect:
    case GAZE_SLIDER_ACTIONS.track: openGazeSlider(action); break;
    case PAUSE_ACTION: break; // handled inside the engine
  }
}

function selectPhrase() {
  const text = profile.board.phrases[boardIndex];
  $('boardOutput').textContent = text;
  if ($('speakOut').checked && 'speechSynthesis' in window) {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text); u.lang = 'zh-CN';
    u.volume = Math.max(0, Math.min(1, profile.music.volume / 100));
    speechSynthesis.speak(u);
  }
}

function updateAutoScan() {
  clearInterval(scanTimer);
  if (profile.board.autoScan && activeTab === 'board') {
    scanTimer = setInterval(() => { if (!engine.paused) runAction('next'); }, profile.board.scanIntervalMs);
  }
}

// ---------------------------------------------------------------- rendering
function setStatus(text, kind = '') { const s = $('status'); s.textContent = text; s.className = `pill ${kind}`; }
window.addEventListener('eye-profile-storage-error', event => {
  setStatus(`档案扩展存储写入失败：${event.detail?.message || '请先导出档案备份'}`, 'warn');
  refreshStorageInfo();
});
function showPrompt(html) { const p = $('prompt'); p.innerHTML = html; p.classList.remove('hidden'); }
function hidePrompt() { $('prompt').classList.add('hidden'); }
function renderPause() { $('pausePill').classList.toggle('hidden', !engine.paused); }
let flashTimer;
function flash(text) { const f = $('flash'); f.textContent = text; f.classList.add('show'); clearTimeout(flashTimer); flashTimer = setTimeout(() => f.classList.remove('show'), 700); }

function log(text, cls = '') {
  const li = document.createElement('li'); li.textContent = `${new Date().toLocaleTimeString()}  ${text}`; li.className = cls;
  const ol = $('log'); ol.prepend(li); while (ol.children.length > 60) ol.lastChild.remove();
}

function setTabsLocked(locked) {
  document.querySelectorAll('button:not(.tabs button)').forEach(b => {
    if (b.id !== 'startCamera' && b.id !== 'captureStop') b.disabled = locked;
  });
  $('captureStop').disabled = false;
}

function drawOverlay(lm) {
  overlay.width = video.videoWidth || 640; overlay.height = video.videoHeight || 480;
  octx.clearRect(0, 0, overlay.width, overlay.height);
  if (!lm) return;
  octx.fillStyle = '#4ade80';
  for (const i of OVERLAY_POINTS) {
    const p = lm[i]; octx.beginPath(); octx.arc(p.x * overlay.width, p.y * overlay.height, i >= 468 ? 3 : 1.6, 0, 2 * Math.PI); octx.fill();
  }
}

const BAR_CHANNELS = ['eyeBlinkLeft', 'eyeBlinkRight', 'eyeLookOutLeft', 'eyeLookOutRight', 'eyeLookUpLeft', 'eyeLookDownLeft', 'irisXA', 'irisYA', 'headYaw'];
function buildFeatureBars() {
  $('featureBars').innerHTML = BAR_CHANNELS.map(n => `<span>${n}</span><div class="fbar"><span id="fb-${n}"></span></div>`).join('');
}
function renderMeters(z) {
  const s = profile.settings.segmenter, max = 8;
  const a = z ? activityOf(z) : 0;
  $('activityValue').textContent = z ? a.toFixed(1) : '（未校准）';
  $('activityBar').style.width = `${Math.min(a / max, 1) * 100}%`;
  $('onMark').style.left = `${(s.onThreshold / max) * 100}%`;
  $('offMark').style.left = `${(s.offThreshold / max) * 100}%`;
  if (!z) return;
  for (const n of BAR_CHANNELS) {
    const v = Math.max(-1, Math.min(1, z[FEATURE_NAMES.indexOf(n)] / 6)); // ±6 spreads fills the bar
    const el = $(`fb-${n}`);
    el.style.left = `${50 + Math.min(v, 0) * 50}%`; el.style.width = `${Math.abs(v) * 50}%`;
  }
}

function renderTrain() {
  const counts = {}, totalCounts = {};
  for (const s of activeSamples()) counts[s.label] = (counts[s.label] || 0) + 1;
  for (const s of profile.samples) totalCounts[s.label] = (totalCounts[s.label] || 0) + 1;
  $('gestureRows').innerHTML = profile.gestures.map(g => `
    <tr><td>${g === REST_LABEL ? '自然（防误触）' : g}</td><td>${totalCounts[g] || 0} <span class="muted">（当前 ${counts[g] || 0}）</span></td><td>
      <button data-rec="${g}">${g === REST_LABEL ? '录 20 秒' : `录 ${profile.settings.repeats} 次`}</button>
      <button data-undo="${g}" title="撤销当前环境最近一个样本">撤销</button>
      <button data-clear="${g}" title="只清空当前环境，不影响其他历史环境">清空当前</button>
      ${g === REST_LABEL ? '' : `<button data-rename="${g}" title="修改动作名称，保留已有样本及绑定">重命名</button><button data-del="${g}" class="danger">删除</button>`}
      <button data-del-latest="${g}" class="danger" title="仅删除当前环境中该动作最新的5个样本；不足5个时删除剩余样本，保留动作、绑定和其他历史环境" ${!counts[g] ? 'disabled' : ''}>删除最新录制的5次样本</button>
    </td></tr>`).join('');
  const b = activeBaseline(profile);
  $('baselineInfo').textContent = b ? `已校准（${b.numFrames} 帧）` : '尚未校准';
  const history = baselineSampleSummary(profile);
  const currentCount = activeSamples().length;
  $('sampleArchiveInfo').textContent = `档案共保存 ${profile.samples.length} 个样本；当前识别环境 ${currentCount} 个，其他历史环境 ${profile.samples.length - currentCount} 个。切换校准环境不会删除样本。`;
  const baselineSelect = $('baselineSelect');
  baselineSelect.replaceChildren();
  for (const [index, item] of history.entries()) {
    const option = document.createElement('option');
    option.value = item.id;
    option.textContent = `${index + 1}. ${item.createdAt ? new Date(item.createdAt).toLocaleString() : '历史校准'} · ${item.sampleCount} 个样本${item.id === profile.pendingBaselineId ? '（待启用）' : ''}`;
    baselineSelect.appendChild(option);
  }
  baselineSelect.value = profile.activeBaselineId || '';
  baselineSelect.disabled = !history.length || mode !== 'idle';
  $('restoreRecordedBaseline').classList.toggle('hidden', currentCount > 0 || !history.some(item => item.sampleCount > 0));
  const recovery = profile.baselineRecoveryNotice;
  $('baselineRecoveryInfo').classList.toggle('hidden', !recovery || recovery.baselineId !== profile.activeBaselineId);
  $('baselineRecoveryInfo').textContent = recovery ? `已从历史校准环境恢复 ${recovery.sampleCount} 个样本的显示与识别。原始样本及其录制记录保持不变。` : '';
  const pending = history.find(item => item.id === profile.pendingBaselineId);
  $('pendingBaselinePanel').classList.toggle('hidden', !pending);
  $('pendingBaselineInfo').textContent = pending
    ? `新校准已保存，尚未替换当前环境。当前档案共 ${profile.samples.length} 个样本；启用新环境后仅使用该环境的样本（现有 ${pending.sampleCount} 个）。历史样本仍保留，可随时切回。`
    : '';
  const eyeCalibration = profile.eyeCalibration;
  if (!eyeCalibration) {
    $('personalCalibrationInfo').textContent = '尚未校准 · 依次看中央、左、右、上、下；四个方向各重复两次短暂保持。';
  } else if (eyeCalibration.baselineId !== profile.activeBaselineId) {
    $('personalCalibrationInfo').textContent = '静息基线已变化，建议重新进行五方向校准。';
  } else {
    const axisLabel = status => status === 'good' ? '良好' : status === 'partial' ? '一般' : '偏弱';
    const applied = eyeCalibration.applied ? '个性化轴向灵敏度已启用' : '仅保存范围参考，未改变已有样本的识别尺度';
    $('personalCalibrationInfo').textContent = `横向${axisLabel(eyeCalibration.axes.horizontal.status)}、纵向${axisLabel(eyeCalibration.axes.vertical.status)} · ${applied}`;
  }
  $('gazeCalibrationInfo').textContent = validGazeCalibration()
    ? `视线滑块已校准（${new Date(profile.gazeSlider.calibration.createdAt).toLocaleDateString()}）`
    : profile.gazeSlider.calibration ? '视线滑块环境基线已变化，请重新校准' : '视线滑块尚未校准';
  $('tryGazeSlider').disabled = !validGazeCalibration();
  $('tryTrackPicker').disabled = !validGazeCalibration();
  renderUsers(); // sample counts shown in the user picker
}

function renderEval() {
  const split = splitBySession(activeSamples());
  if (split.status !== 'ok') { $('evalResult').innerHTML = `<p>数据不足：${split.reason}。不输出泛化准确率。</p>`; return; }
  const evaluator = new GestureClassifier(profile.settings.classifier);
  const trainLabels = new Set(split.train.map(s => s.label));
  const missing = [...new Set(split.test.map(s => s.label))].filter(label => !trainLabels.has(label));
  if (missing.length) { $('evalResult').innerHTML = `<p>数据不足：训练 session 缺少类别「${missing.join('、')}」。不输出泛化准确率。</p>`; return; }
  evaluator.fit(split.train.map(s => materialiseSample(profile, s)).filter(Boolean));
  const labels = [...new Set(split.test.map(s => s.label))];
  const confusion = Object.fromEntries(labels.map(l => [l, Object.fromEntries([...labels, UNKNOWN_LABEL].map(m => [m, 0]))]));
  let correct = 0;
  for (const sample of split.test) {
    const x = materialiseSample(profile, sample); if (!x) continue;
    const p = evaluator.predict(x.frames, x.durationMs);
    confusion[sample.label][p.label] = (confusion[sample.label][p.label] || 0) + 1;
    if (p.label === sample.label) correct++;
  }
  const r = { labels, confusion, n: split.test.length, accuracy: split.test.length ? correct / split.test.length : 0 };
  const cols = [...r.labels, UNKNOWN_LABEL];
  const head = `<tr><th>实际 ＼ 识别为</th>${cols.map(c => `<th>${c}</th>`).join('')}</tr>`;
  const rows = r.labels.map(l => `<tr><th>${l}</th>${cols.map(c => {
    const v = r.confusion[l][c] || 0; return `<td class="${c === l ? 'diag' : v ? 'off' : ''}">${v || ''}</td>`;
  }).join('')}</tr>`).join('');
  $('evalResult').innerHTML = `<p>session 级保留集准确率 <span class="big-num">${(r.accuracy * 100).toFixed(0)}%</span>（${r.n} 个样本）</p>
    <table class="confusion">${head}${rows}</table>
    <p class="muted">红色格子 = 混淆。常见补救：两类动作太像就换一个动作；或给混淆的类多录几次。</p>`;
}

function renderMapTable(tabId, modeKey) {
  const map = profile.mappings[modeKey];
  $(tabId).innerHTML = profile.gestures.filter(g => g !== REST_LABEL).map(g => `
    <tr><td>${g}</td><td><select data-map="${modeKey}" data-gesture="${g}">
      ${MODE_ACTIONS[modeKey].map(a => `<option value="${a}" ${(map[g] || '') === a ? 'selected' : ''}>${ACTION_LABELS[a]}</option>`).join('')}
    </select></td></tr>`).join('');
}

function renderBoard() {
  const ph = profile.board.phrases;
  if (boardIndex >= ph.length) boardIndex = 0;
  $('boardGrid').innerHTML = ph.map((p, i) => `<div class="${i === boardIndex ? 'hl' : ''}">${p}</div>`).join('');
}

function renderMusic() {
  $('chordNow').textContent = beatBox.chord.name;
  $('musicToggle').textContent = beatBox.playing ? '停止伴奏' : '开始伴奏';
  $('bpm').value = profile.music.bpm; $('bpmValue').textContent = profile.music.bpm;
  $('musicVolumeInfo').textContent = `音量 ${profile.music.volume}%`;
  $('musicEffectInfo').textContent = `加花强度 ${profile.music.effectIntensity}%`;
  trackAudio.volume = profile.music.volume / 100;
  $('trackCount').textContent = `已添加 ${tracks.length}/${MAX_TRACKS} 首曲目`;
  $('currentTrack').textContent = selectedTrackIndex >= 0 ? `当前曲目：${tracks[selectedTrackIndex].name}` : '尚未选择曲目';
  $('openTrackPicker').disabled = !tracks.length;
}
beatBox.onBeat = (n) => {
  document.querySelectorAll('#beatDots i').forEach((d, i) => d.classList.toggle('on', i === n % 4));
  $('chordNow').textContent = beatBox.chord.name;
};

const SLIDERS = [
  ['segmenter', 'onThreshold', '起始阈值', 1, 6, 0.1, '活跃度超过它才算动作开始。误触多就调高，做了动作没反应就调低。'],
  ['segmenter', 'offThreshold', '结束阈值', 0.5, 4, 0.1, '活跃度回落到它以下才算回到静息。'],
  ['segmenter', 'minOffMs', '静息确认（ms）', 100, 1000, 25, '眼睛回到静息后要保持多久才算动作结束，间隔比它短的两次眨眼会合并成一个动作。双眨被拆成两次 → 调大；觉得反应慢 → 调小。'],
  ['segmenter', 'maxDurationMs', '最长动作（ms）', 1000, 8000, 100, ''],
  ['classifier', 'rejectFactor', '拒识严格度', 1, 5, 0.1, '<strong>调大</strong>：更宽松，较不像的动作也能被判为成功识别。<br><strong>调小</strong>：更严格，更容易显示“未知，最像 XXX”。'],
  ['classifier', 'durationWeight', '时长权重', 0, 3, 0.1, '越大越看重动作时长（区分短眨与长眨）。'],
  ['classifier', 'k', '投票近邻数 k', 1, 7, 1, ''],
  ['engine', 'refractoryMs', '冷却时间（ms）', 0, 3000, 50, '一次操作后多久内不再响应，防连发。'],
  [null, 'recordWindowMs', '每次录制窗口（ms）', 1500, 6000, 100, '看到「现在」后有多长时间做动作。动作慢的病人调长。'],
  [null, 'repeats', '每次录几遍', 1, 15, 1, ''],
  [null, 'adaptAlpha', '静息自适应速度', 0, 0.01, 0.0005, '0 = 不自适应。光线或坐姿缓慢变化时，静息基线跟随的快慢。'],
];
function renderSettings() {
  $('profileName').value = profile.name;
  $('gazeDeckUseClosestGuess').checked = profile.settings.gazeDeckUseClosestGuess === true;
  $('testCountClosestGuess').checked = profile.settings.testCountClosestGuess === true;
  $('sliders').innerHTML = SLIDERS.map(([grp, key, label, min, max, step, help]) => {
    const v = grp ? profile.settings[grp][key] : profile.settings[key];
    return `<label for="s-${key}">${label}</label><input type="range" id="s-${key}" data-grp="${grp ?? ''}" data-key="${key}" min="${min}" max="${max}" step="${step}" value="${v}"><span id="sv-${key}">${v}</span>${help ? `<div class="help">${help}</div>` : ''}`;
  }).join('');
  renderGazeSettings();
  renderCameraAssistSettings();
  const defaults = parameterDefaultsInfo(profile);
  $('parameterDefaultsInfo').textContent = defaults.scope === 'shared'
    ? `共享默认：已保存（${new Date(defaults.savedAt).toLocaleString()}）`
    : defaults.scope === 'legacy'
      ? `共享默认：尚未保存；当前用户仍可恢复旧版个人默认（${new Date(defaults.savedAt).toLocaleString()}）`
      : '共享默认：尚未保存，恢复时使用系统初始参数';
  refreshStorageInfo();
}

function formatStorageBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '不可用';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[unit]}`;
}

function averageSampleBytes() {
  if (!profile.samples.length) return 32 * 1024;
  const count = Math.min(20, profile.samples.length);
  const stride = Math.max(1, Math.floor(profile.samples.length / count));
  let bytes = 0, measured = 0;
  for (let i = 0; i < profile.samples.length && measured < count; i += stride, measured++) {
    bytes += new Blob([JSON.stringify(profile.samples[i])]).size;
  }
  return Math.max(1024, bytes / Math.max(1, measured));
}

function localStorageUsageBytes() {
  let bytes = 0;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      const value = key == null ? null : localStorage.getItem(key);
      if (key != null && value != null) bytes += (key.length + value.length) * 2;
    }
  } catch { return null; }
  return bytes;
}

let storageRefreshSequence = 0;
async function refreshStorageInfo() {
  const sequence = ++storageRefreshSequence;
  const usageEl = $('storageUsage'), remainingEl = $('storageRemaining');
  if (!usageEl || !remainingEl) return;
  $('storageBackend').textContent = profileStoreReady
    ? '档案主存储：IndexedDB（已保留旧档案备份）'
    : '档案主存储：旧 localStorage；以下容量按约 5 MiB 上限估算，建议导出备份并更换支持 IndexedDB 的普通浏览器窗口。';
  try {
    let usage, quota;
    if (profileStoreReady && navigator.storage?.estimate) {
      const estimate = await navigator.storage.estimate();
      usage = estimate.usage; quota = estimate.quota;
    } else if (!profileStoreReady) {
      usage = localStorageUsageBytes(); quota = 5 * 1024 * 1024;
    }
    if (sequence !== storageRefreshSequence) return;
    if (!Number.isFinite(usage) || !Number.isFinite(quota)) throw new Error('浏览器未提供存储空间估算');
    const remaining = Math.max(0, quota - usage);
    $('storageUsage').textContent = formatStorageBytes(usage);
    $('storageQuota').textContent = formatStorageBytes(quota);
    $('storageRemaining').textContent = formatStorageBytes(remaining);
    const avg = averageSampleBytes();
    $('storageSamplesRemaining').textContent = profile.samples.length
      ? `${Math.floor(remaining / avg).toLocaleString()} 个左右`
      : '录入样本后可估算';
    $('storageRemaining').classList.toggle('storage-low', remaining < 32 * 1024 * 1024);
  } catch (error) {
    if (sequence !== storageRefreshSequence) return;
    $('storageUsage').textContent = '不可用';
    $('storageRemaining').textContent = '不可用';
    $('storageQuota').textContent = '不可用';
    $('storageSamplesRemaining').textContent = '不可用';
    $('storageBackend').textContent += `（${error.message}）`;
  }
}

async function hasRecordingSpace(label) {
  try {
    let usage, quota;
    if (profileStoreReady && navigator.storage?.estimate) {
      ({ usage, quota } = await navigator.storage.estimate());
    } else if (!profileStoreReady) {
      usage = localStorageUsageBytes(); quota = 5 * 1024 * 1024;
    }
    if (!Number.isFinite(usage) || !Number.isFinite(quota)) return true;
    const remaining = Math.max(0, quota - usage);
    const isRest = label === REST_LABEL;
    const sampleCount = isRest ? 30 : profile.settings.repeats;
    const reserve = Math.max(1024 * 1024, averageSampleBytes() * sampleCount * 2);
    if (remaining < reserve) {
      setStatus(`空间可能不足：剩余约 ${formatStorageBytes(remaining)}，本轮建议预留 ${formatStorageBytes(reserve)}；请先导出档案备份`, 'warn');
      refreshStorageInfo();
      return false;
    }
    return true;
  } catch {
    // If the browser cannot estimate its quota, don't prevent recording based on an unknown value.
    return true;
  }
}

function renderCameraAssistSettings() {
  const s = profile.settings.cameraAssist;
  $('faceGuideEnabled').checked = s.faceGuideEnabled;
  $('lightingWarningEnabled').checked = s.lightingWarningEnabled;
  for (const [id, value, valueId, suffix] of [
    ['faceToleranceX', s.faceCenterToleranceX * 100, 'faceToleranceXValue', '%'],
    ['faceToleranceY', s.faceCenterToleranceY * 100, 'faceToleranceYValue', '%'],
    ['faceMinWidth', s.faceMinWidth * 100, 'faceMinWidthValue', '%'],
    ['faceMaxWidth', s.faceMaxWidth * 100, 'faceMaxWidthValue', '%'],
    ['faceMaxHeight', s.faceMaxHeight * 100, 'faceMaxHeightValue', '%'],
    ['darkThreshold', s.darkThreshold, 'darkThresholdValue', ' / 255'],
    ['brightThreshold', s.brightThreshold, 'brightThresholdValue', ' / 255'],
  ]) {
    $(id).value = value;
    $(valueId).textContent = `${Math.round(value)}${suffix}`;
  }
}

function renderGazeSettings() {
  const settings = profile.gazeSlider.settings;
  $('personalCalibrationPace').value = String(calibrationDurationFactor(profile.settings.calibrationPace?.personal));
  $('sliderCalibrationPace').value = String(calibrationDurationFactor(profile.settings.calibrationPace?.slider));
  $('gazeSliderEnabled').checked = settings.enabled;
  $('gazeConfirmGesture').innerHTML = '<option>下看</option>';
  $('gazeCancelGesture').innerHTML = '<option>上看</option>';
  $('gazeConfirmGesture').disabled = true; $('gazeCancelGesture').disabled = true;
  for (const [id, value, valueId, suffix] of [
    ['gazeDwellMs', settings.dwellMs, 'gazeDwellValue', ' ms'],
    ['gazeMaxRate', settings.maxRatePerSec, 'gazeMaxRateValue', ' / 秒'],
    ['gazeDeadZone', settings.deadZone, 'gazeDeadZoneValue', ''],
    ['gazeSmoothingMs', settings.smoothingMs, 'gazeSmoothingValue', ' ms'],
  ]) {
    $(id).value = value;
    $(valueId).textContent = `${value}${suffix}`;
  }
}

function renderAll() {
  beatBox.bpm = profile.music.bpm; beatBox.setChords(profile.music.chords);
  beatBox.setVolume(profile.music.volume); beatBox.setEffectIntensity(profile.music.effectIntensity);
  renderTrain(); renderSettings(); renderBoard(); renderMusic(); renderTestSetup();
  if (!guidedTest) {
    $('testSetup').classList.remove('hidden');
    $('testRunning').classList.add('hidden'); $('testReview').classList.add('hidden');
    $('testActions').classList.add('hidden'); renderStoredTestResult();
  }
  renderMapTable('boardMap', 'board'); renderMapTable('musicMap', 'music');
  $('phrases').value = profile.board.phrases.join('\n');
  $('autoScan').checked = profile.board.autoScan;
  $('scanInterval').value = profile.board.scanIntervalMs;
  $('chords').value = profile.music.chords;
}

function persist() {
  const saved = saveProfile(profile);
  if (!saved) setStatus('浏览器存储空间不足或不可用：本次更改未能保存，请先导出档案备份并清理空间', 'warn');
  refreshStorageInfo();
  return saved;
}

// Rebuild every component that depends on the profile (after import / reset / settings change).
function applyProfile() {
  if (repairLegacyBaselineSelection(profile).changed) persist();
  segmenter = new Segmenter(profile.settings.segmenter);
  engine = new GestureEngine(profile.settings.engine);
  liveBaseline = activeBaseline(profile) ? structuredClone(activeBaseline(profile)) : null;
  rebuildClassifier(); renderAll(); renderPause(); renderUsers(); updateAutoScan();
  if (gazeDeckProfileId !== profile.id) {
    gazeDeckProfileId = profile.id; gazeDeck.resetForUser(); gazeDeck.setActive(activeTab === 'gazedeck');
  }
}

// ---------------------------------------------------------------- audio cue
let cueCtx = null;
function beep(freq, dur) {
  try {
    cueCtx ??= new AudioContext();
    const o = cueCtx.createOscillator(), g = cueCtx.createGain();
    o.frequency.value = freq; g.gain.value = 0.15;
    o.connect(g).connect(cueCtx.destination);
    o.start(); o.stop(cueCtx.currentTime + dur);
  } catch { /* audio not available */ }
}

// ---------------------------------------------------------------- events
$('refreshCameras').onclick = () => listCameras();
$('startCamera').onclick = () => startCamera($('cameraSelect').value);
$('cameraSelect').onchange = e => {
  preferredCameraId = e.target.value;
  preferredCameraLabel = e.target.selectedOptions[0]?.textContent.replace(/（暂不可用；不会自动切换）$/, '') || '';
  safeSet(CAMERA_KEY, preferredCameraId);
  if (preferredCameraLabel) safeSet(CAMERA_LABEL_KEY, preferredCameraLabel);
  startCamera(preferredCameraId);
};
function scheduleCameraListRefresh() {
  clearTimeout(cameraListTimer);
  cameraListTimer = setTimeout(() => {
    if (document.activeElement === $('cameraSelect')) {
      $('cameraSelect').addEventListener('blur', listCameras, { once: true });
      return;
    }
    listCameras();
  }, 300);
}
navigator.mediaDevices?.addEventListener('devicechange', scheduleCameraListRefresh);
window.addEventListener('focus', scheduleCameraListRefresh);
$('videoFile').onchange = e => e.target.files[0] && openVideoFile(e.target.files[0]);
$('calibrate').onclick = calibrate;
$('baselineSelect').onchange = e => {
  if (mode !== 'idle' || recorder || guidedTest) { e.target.value = profile.activeBaselineId || ''; return; }
  activateBaseline(profile, e.target.value);
  persist(); applyProfile();
  setStatus(`已切换校准环境；当前 ${activeSamples().length} 个样本，档案共保存 ${profile.samples.length} 个样本`);
};
$('restoreRecordedBaseline').onclick = () => {
  if (mode !== 'idle' || recorder || guidedTest) return;
  const recovery = restoreRecordedBaseline(profile);
  if (!recovery) { setStatus('当前环境已有样本，或没有可恢复的历史校准环境'); return; }
  profile.baselineRecoveryNotice = recovery;
  persist(); applyProfile();
  setStatus(`已恢复 ${recovery.sampleCount} 个历史样本的显示与识别`);
};
$('keepCurrentBaseline').onclick = () => {
  if (mode !== 'idle') return;
  profile.pendingBaselineId = null;
  persist(); renderTrain();
  setStatus(`继续使用原环境的 ${activeSamples().length} 个样本；新校准保留在历史记录中`);
};
$('activatePendingBaseline').onclick = e => {
  if (mode !== 'idle' || !profile.pendingBaselineId) return;
  if (!confirmInline(e.target)) return;
  activateBaseline(profile, profile.pendingBaselineId, { reason: 'confirmed-new-calibration' });
  persist(); applyProfile();
  setStatus(`已明确启用新环境；旧样本仍保留在历史环境中，档案共 ${profile.samples.length} 个样本`);
};
$('calibrateGaze').onclick = () => startGazeCalibration('personal');
$('calibrateSlider').onclick = () => startGazeCalibration('slider');
$('tryGazeSlider').onclick = () => openGazeSlider(GAZE_SLIDER_ACTIONS.volume);
$('tryTrackPicker').onclick = () => openGazeSlider(GAZE_SLIDER_ACTIONS.track);
$('openTrackPicker').onclick = () => openGazeSlider(GAZE_SLIDER_ACTIONS.track);
$('confirmGazeSlider').onclick = () => finishGazeSlider(true);
$('cancelGazeSlider').onclick = restoreGazeSlider;

document.querySelector('.tabs').onclick = e => {
  const tab = e.target.dataset.tab; if (!tab || mode !== 'idle') return;
  quickControlSelected = tab === 'gazedeck'
    && (quickControlRequested && quickExperience.ready() || activeTab === 'gazedeck' && quickControlSelected);
  quickControlRequested = false;
  if (activeTab === 'quick' || tab === 'quick') quickExperience.setActive(tab === 'quick');
  gazeDeck.setQuickBindings(quickControlSelected);
  if (activeTab === 'gazedeck' || tab === 'gazedeck') gazeDeck.setActive(tab === 'gazedeck');
  activeTab = tab;
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.id === `tab-${tab}`));
  if (tab === 'eval') renderEval();
  if (tab !== 'music' && beatBox.playing) { beatBox.stop(); renderMusic(); }
  if (tab !== 'music') trackAudio.pause();
  updateAutoScan();
};
$('quickLaunch').onclick = () => document.querySelector('[data-tab="quick"]').click();

$('gestureRows').onclick = e => {
  const d = e.target.dataset;
  if (d.delLatest) {
    if (mode !== 'idle' || recorder || guidedTest || recordingSpaceCheckPending) {
      setStatus('请先结束录制、校准或测试，再删除最近样本', 'warn');
      return;
    }
    const count = Math.min(5, activeSamples().filter(s => s.label === d.delLatest).length);
    if (!count) { setStatus('当前环境中该动作没有可删除的样本'); return; }
    if (!confirmInline(e.target, `再点确认：删除 ${count} 个`)) return;
    const removed = deleteLatestGestureSamples(profile, d.delLatest);
    if (removed) {
      rebuildClassifier(); persist(); renderAll();
      setStatus(`已删除「${d.delLatest}」在当前环境中最新的 ${removed} 个样本；更早样本、其他动作和历史环境保留`);
    }
    return;
  }
  if (d.rename) {
    if (mode !== 'idle' || guidedTest) {
      alert('请先结束录制、校准或测试（包括待确认的测试改进），再重命名动作。');
      return;
    }
    const name = prompt('输入新的动作名称（已有样本和动作绑定将保留）：', d.rename);
    if (name === null) return;
    try {
      if (!renameGesture(profile, d.rename, name)) return;
      segmenter.reset();
      engine = new GestureEngine(profile.settings.engine);
      rebuildClassifier(); renderAll(); renderPause(); persist();
    } catch (error) { alert(error.message); }
    return;
  }
  if (d.rec) { startRecording(d.rec); return; }
  // Re-render only after something was actually removed: re-rendering on the first (arming) click of a
  // two-click button would replace the button and silently discard its "再点确认" state.
  let changed = false;
  if (d.undo) {
    const i = profile.samples.findLastIndex(s => s.label === d.undo && s.baselineId === profile.activeBaselineId);
    if (i >= 0) { profile.samples.splice(i, 1); changed = true; }
  }
  if (d.clear) {
    if (!confirmInline(e.target)) return;
    profile.samples = profile.samples.filter(s => s.label !== d.clear || s.baselineId !== profile.activeBaselineId);
    changed = true;
  }
  if (d.del) {
    if (!confirmInline(e.target)) return;
    profile.gestures = profile.gestures.filter(g => g !== d.del);
    profile.samples = profile.samples.filter(s => s.label !== d.del);
    for (const m of Object.values(profile.mappings)) delete m[d.del];
    changed = true;
  }
  if (changed) { rebuildClassifier(); persist(); renderAll(); }
};

// Two-click confirmation without a blocking browser dialog.
function confirmInline(btn, confirmationText = '再点确认') {
  if (btn.dataset.armed) return true;
  btn.dataset.armed = '1'; const old = btn.textContent; btn.textContent = confirmationText;
  setTimeout(() => { delete btn.dataset.armed; btn.textContent = old; }, 2500);
  return false;
}

$('addGesture').onclick = () => {
  const name = $('newGesture').value.trim();
  if (!name || profile.gestures.includes(name) || name === UNKNOWN_LABEL) return;
  profile.gestures.push(name); $('newGesture').value = '';
  persist(); renderAll();
};

$('runEval').onclick = renderEval;

$('startTuningTest').onclick = () => beginGuidedTest('tuning');
$('startConfirmationTest').onclick = () => beginGuidedTest('confirmation');
$('confirmTrial').onclick = () => reviewCurrentTrial('confirmed', guidedTest.current.targetLabel);
$('correctTrial').onclick = () => reviewCurrentTrial('corrected', $('actualGesture').value);
$('invalidateTrial').onclick = () => reviewCurrentTrial('invalid');
$('stopTest').onclick = stopGuidedTest;
$('captureStop').onclick = () => {
  if (recorder) cancelRecording();
  else if (mode === 'gaze-calibrating') cancelGazeCalibration();
  else stopGuidedTest();
};
$('discardTestImprovement').onclick = () => {
  guidedTest = null; $('testActions').classList.add('hidden');
  $('testSetup').classList.remove('hidden'); renderStoredTestResult();
  setStatus('已放弃候选改进，原模型未变；本轮测试结果已保留');
};
$('applyTestImprovement').onclick = () => {
  if (!guidedTest?.confirmationTrials?.length || !guidedTest.candidateSamples.length) return;
  const before = summariseTrials(guidedTest.confirmationTrials, 'predictedBefore', guidedTest);
  const after = summariseTrials(guidedTest.confirmationTrials, 'predictedAfter', guidedTest);
  if (!shouldPromoteCandidate(before, after)) { setStatus('候选模型未达到安全应用条件', 'warn'); return; }
  profile.samples.push(...guidedTest.candidateSamples);
  const count = guidedTest.candidateSamples.length;
  rebuildClassifier(); persist();
  guidedTest = null; renderAll();
  setStatus(`已应用 ${count} 个人工确认的困难样本`);
};
$('deleteLatestTestRun').onclick = () => {
  if (mode !== 'idle') { setStatus('请先结束当前测试，再删除本轮测试数据', 'warn'); return; }
  const run = latestSavedTestRun();
  if (!run || !confirm('确定删除本轮测试数据吗？这会删除本轮调优和独立确认记录；已应用的训练样本不会被删除。')) return;
  const previousRuns = profile.testRuns, previousId = profile.latestTestRunId;
  const roundIds = new Set([run.id]);
  if (run.phase === 'confirmation' && typeof run.parentId === 'string') roundIds.add(run.parentId);
  profile.testRuns = profile.testRuns.filter(item => !roundIds.has(item?.id));
  profile.latestTestRunId = null;
  if (!persist()) {
    profile.testRuns = previousRuns; profile.latestTestRunId = previousId;
    renderStoredTestResult(); return;
  }
  guidedTest = null;
  $('testActions').classList.add('hidden'); $('testSetup').classList.remove('hidden');
  renderStoredTestResult(); setStatus('本轮测试数据已删除，可以开始下一次测试');
};

document.addEventListener('change', e => {
  const t = e.target;
  if (t.dataset.map) { profile.mappings[t.dataset.map][t.dataset.gesture] = t.value || undefined; persist(); }
});

$('phrases').onchange = e => { profile.board.phrases = e.target.value.split('\n').map(s => s.trim()).filter(Boolean); persist(); renderBoard(); };
$('autoScan').onchange = e => { profile.board.autoScan = e.target.checked; persist(); updateAutoScan(); };
$('scanInterval').onchange = e => { profile.board.scanIntervalMs = Math.max(500, +e.target.value); persist(); updateAutoScan(); };

$('musicToggle').onclick = () => { beatBox.toggle(); renderMusic(); };
$('trackFiles').onchange = e => {
  if (mode !== 'idle') {
    e.target.value = '';
    setStatus('请先完成当前录制或滑块操作，再添加曲目', 'warn');
    return;
  }
  const files = [...e.target.files];
  let added = 0;
  for (const file of files) {
    if (tracks.length >= MAX_TRACKS) break;
    if (!file.type.startsWith('audio/') && !/\.(mp3|wav|ogg|m4a|flac)$/i.test(file.name)) continue;
    tracks.push({ name: file.name, url: URL.createObjectURL(file) });
    added++;
  }
  e.target.value = '';
  renderMusic();
  if (added) setStatus(`已添加 ${added} 首本机曲目；可用眼动弹窗选择，音频不会存入眼动档案`);
  else if (files.length) setStatus(tracks.length >= MAX_TRACKS ? '最多支持 5 首曲目' : '未添加曲目：请选择音频文件', 'warn');
};
trackAudio.onerror = () => {
  if (selectedTrackIndex >= 0) setStatus(`无法播放「${tracks[selectedTrackIndex].name}」，请检查音频格式`, 'warn');
};
$('bpm').oninput = e => { profile.music.bpm = +e.target.value; beatBox.bpm = profile.music.bpm; $('bpmValue').textContent = e.target.value; persist(); };
$('chords').onchange = e => { if (beatBox.setChords(e.target.value)) { profile.music.chords = e.target.value; persist(); renderMusic(); } };
$('enableMidi').onclick = async () => {
  if (!navigator.requestMIDIAccess) { $('midiInfo').textContent = '此浏览器不支持 Web MIDI（请用 Chrome / Edge）'; return; }
  try {
    const access = await navigator.requestMIDIAccess();
    const outs = [...access.outputs.values()];
    const sel = $('midiSelect');
    sel.innerHTML = '<option value="">（不发送 MIDI）</option>' + outs.map(o => `<option value="${o.id}">${o.name}</option>`).join('');
    sel.classList.remove('hidden');
    sel.value = profile.music.midiOutputId || '';
    beatBox.midiOut = access.outputs.get(sel.value) || null;
    sel.onchange = () => { profile.music.midiOutputId = sel.value; beatBox.midiOut = access.outputs.get(sel.value) || null; persist(); };
    $('midiInfo').textContent = outs.length ? `${outs.length} 个 MIDI 输出` : '没有 MIDI 输出设备（macOS：音频 MIDI 设置 → MIDI 工作室 → IAC 驱动 → 勾选「设备在线」）';
  } catch (e) { $('midiInfo').textContent = `MIDI 不可用：${e.message}`; }
};

$('sliders').oninput = e => {
  const t = e.target; if (!t.dataset.key) return;
  const v = +t.value;
  if (t.dataset.grp) profile.settings[t.dataset.grp][t.dataset.key] = v; else profile.settings[t.dataset.key] = v;
  $(`sv-${t.dataset.key}`).textContent = v;
};
$('sliders').onchange = () => { persist(); applyProfile(); };

$('saveParameterDefaults').onclick = async () => {
  if (mode !== 'idle' || recorder || guidedTest || recordingSpaceCheckPending) {
    setStatus('请先结束录制、校准或测试，再保存默认设置', 'warn'); return;
  }
  const button = $('saveParameterDefaults');
  button.disabled = true;
  try {
    if (!await saveParameterDefaults(profile)) {
      setStatus('浏览器存储不可用，未保存共享默认设置', 'warn'); return;
    }
    renderSettings();
    setStatus('已保存共享默认设置；其他用户可点击“恢复到共享默认设置”应用，新建用户会以此为初始参数');
  } finally { button.disabled = false; }
};
function restoreSettingsDefaults(system = false) {
  if (mode !== 'idle' || recorder || guidedTest || recordingSpaceCheckPending) {
    setStatus('请先结束录制、校准或测试，再恢复默认设置', 'warn'); return;
  }
  const source = restoreParameterDefaults(profile, { system });
  Object.assign(segmenter.settings, profile.settings.segmenter); segmenter.reset();
  Object.assign(engine.settings, profile.settings.engine);
  rebuildClassifier(); renderSettings();
  if (!profile.settings.cameraAssist.faceGuideEnabled) $('faceGuide').classList.add('hidden');
  if (!profile.settings.cameraAssist.lightingWarningEnabled) $('lightingWarning').classList.add('hidden');
  if (persist()) setStatus(system
    ? '已恢复系统初始参数；共享默认设置、动作样本、校准结果和动作绑定保留'
    : `${source === 'shared' ? '已恢复共享默认参数' : source === 'legacy' ? '已恢复当前用户的旧版个人默认参数' : '共享默认尚未保存，已恢复系统初始参数'}；动作样本、校准结果和动作绑定保留`);
}
$('restoreParameterDefaults').onclick = () => restoreSettingsDefaults();
$('restoreSystemDefaults').onclick = () => restoreSettingsDefaults(true);

$('gazeSliderEnabled').onchange = e => { profile.gazeSlider.settings.enabled = e.target.checked; persist(); };
for (const [id, key] of [['personalCalibrationPace', 'personal'], ['sliderCalibrationPace', 'slider']]) {
  $(id).onchange = e => {
    profile.settings.calibrationPace[key] = calibrationDurationFactor(Number(e.target.value));
    e.target.value = String(profile.settings.calibrationPace[key]);
    persist();
  };
}
$('gazeDeckUseClosestGuess').onchange = e => {
  profile.settings.gazeDeckUseClosestGuess = e.target.checked;
  persist();
};
$('testCountClosestGuess').onchange = e => {
  profile.settings.testCountClosestGuess = e.target.checked;
  persist();
};
$('faceGuideEnabled').onchange = e => {
  profile.settings.cameraAssist.faceGuideEnabled = e.target.checked;
  if (!e.target.checked) $('faceGuide').classList.add('hidden');
  persist();
};
$('lightingWarningEnabled').onchange = e => {
  profile.settings.cameraAssist.lightingWarningEnabled = e.target.checked;
  persist();
};
for (const [id, key, valueId, suffix, scale = 1] of [
  ['faceToleranceX', 'faceCenterToleranceX', 'faceToleranceXValue', '%', 100],
  ['faceToleranceY', 'faceCenterToleranceY', 'faceToleranceYValue', '%', 100],
  ['faceMinWidth', 'faceMinWidth', 'faceMinWidthValue', '%', 100],
  ['faceMaxWidth', 'faceMaxWidth', 'faceMaxWidthValue', '%', 100],
  ['faceMaxHeight', 'faceMaxHeight', 'faceMaxHeightValue', '%', 100],
  ['darkThreshold', 'darkThreshold', 'darkThresholdValue', ' / 255'],
  ['brightThreshold', 'brightThreshold', 'brightThresholdValue', ' / 255'],
]) {
  $(id).oninput = e => {
    const value = +e.target.value;
    profile.settings.cameraAssist[key] = value / scale;
    $(valueId).textContent = `${Math.round(value)}${suffix}`;
  };
  $(id).onchange = persist;
}
for (const [id, key, valueId, suffix] of [
  ['gazeDwellMs', 'dwellMs', 'gazeDwellValue', ' ms'],
  ['gazeMaxRate', 'maxRatePerSec', 'gazeMaxRateValue', ' / 秒'],
  ['gazeDeadZone', 'deadZone', 'gazeDeadZoneValue', ''],
  ['gazeSmoothingMs', 'smoothingMs', 'gazeSmoothingValue', ' ms'],
]) {
  $(id).oninput = e => {
    profile.gazeSlider.settings[key] = +e.target.value;
    $(valueId).textContent = `${e.target.value}${suffix}`;
  };
  $(id).onchange = persist;
}
document.addEventListener('keydown', e => {
  if (mode !== 'gaze-slider') return;
  if (e.key === 'Escape') { e.preventDefault(); finishGazeSlider(false); }
  if (e.key === 'Enter') { e.preventDefault(); finishGazeSlider(true); }
});

$('profileName').onchange = e => { profile.name = e.target.value.trim() || '未命名'; persist(); renderUsers(); };
$('refreshStorage').onclick = refreshStorageInfo;
$('exportProfile').onclick = () => exportProfile(profile);
$('importProfile').onchange = async e => {
  try { profile = await importProfile(e.target.files[0]); applyProfile(); setStatus(`已导入为新用户「${profile.name}」`); }
  catch (err) { setStatus(`导入失败：${err.message}`, 'err'); }
  e.target.value = '';
};
$('resetProfile').onclick = e => {
  if (!confirmInline(e.target)) return;
  const { id, name } = profile;
  profile = Object.assign(defaultProfile(), { id, name });
  persist(); applyProfile(); setStatus(`已清空「${name}」的校准与样本`);
};
$('deleteUser').onclick = e => {
  if (!confirmInline(e.target)) return;
  const name = profile.name;
  stopForSwitch(); profile = deleteProfile(profile.id); applyProfile();
  setStatus(`已删除用户「${name}」，当前用户：${profile.name}`);
};

// ---------------------------------------------------------------- users
// Every person has their own baseline, samples, mappings and thresholds; switching swaps all of them.
function renderUsers() {
  const sel = $('userSelect');
  sel.innerHTML = listProfiles().map(u =>
    `<option value="${u.id}">${u.name}（${u.calibrated ? `${u.samples} 个样本` : '未校准'}）</option>`).join('');
  sel.value = profile.id;
}
function stopForSwitch() {
  if (beatBox.playing) beatBox.stop(); clearInterval(scanTimer);
  trackAudio.pause();
  if (recorder) cancelRecording();
  if (guidedTest) { guidedTest.cancelled = true; guidedTest = null; mode = 'idle'; hidePrompt(); }
  if (gazeSliderSession) finishGazeSlider(false);
  if (gazeCalibrationRun) cancelGazeCalibration({ silent: true });
  quickControlSelected = false;
  quickExperience.resetBaseline();
  setCaptureWorkspace('idle');
}
function afterSwitch() {
  applyProfile();
  setStatus(activeBaseline(profile) ? `当前用户：${profile.name}` : `当前用户：${profile.name} —— 请先做静息校准`, activeBaseline(profile) ? '' : 'warn');
}
$('userSelect').onchange = e => {
  if (mode !== 'idle' || recorder) { e.target.value = profile.id; return; } // never switch during an active recording batch
  stopForSwitch(); profile = switchProfile(e.target.value); afterSwitch();
};
$('newUser').onclick = () => {
  if (mode !== 'idle' || recorder) return;
  stopForSwitch();
  try { profile = createProfile(`用户 ${listProfiles().length + 1}`); }
  catch (e) { setStatus(e.message, 'err'); return; }
  afterSwitch();
  document.querySelector('[data-tab="train"]').click();
  setStatus(`已新建「${profile.name}」（可在⑤设置里改名）—— 请先做静息校准`, 'warn');
};
$('delegate').onchange = e => safeSet(DELEGATE_KEY, e.target.value);
window.addEventListener('focus', refreshStorageInfo);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshStorageInfo(); });
setInterval(() => { if (!document.hidden) refreshStorageInfo(); }, 5000);

// ---------------------------------------------------------------- boot
if (testFeed) {
  window.__eyeTest = {
    feed: (raw, t) => onFeatures(Float32Array.from(raw), t),
    setSettings: patch => { Object.assign(profile.settings, patch); persist(); applyProfile(); },
    state: () => ({ mode, samples: profile.samples.length, labels: classifier.labels(), paused: engine.paused,
                    user: profile.name, users: listProfiles().length, calibrated: !!activeBaseline(profile), gestures: [...profile.gestures],
                    counts: profile.samples.reduce((c, x) => (c[x.label] = (c[x.label] || 0) + 1, c), {}),
                    boardIndex, output: $('boardOutput').textContent, chord: beatBox.chord.name,
                    accents: beatBox.accentCount || 0, playing: beatBox.playing,
                    gazeCalibrated: validGazeCalibration(), gazeSliderOpen: !!gazeSliderSession,
                    volume: profile.music.volume, effectIntensity: profile.music.effectIntensity }),
  };
}
buildFeatureBars();
applyProfile();
quickExperience.init().catch(error => setStatus(`快捷体验初始化失败：${error.message}`, 'warn'));
listCameras(); // Enumerate before requesting a stream, even if the camera cannot start.
requestAnimationFrame(loop);
initModel().catch(e => { console.error(e); setStatus(`模型加载失败：${e.message}`, 'err'); });
if (!profileStoreReady) setStatus('浏览器扩展档案存储不可用，当前使用旧存储；建议导出档案备份并检查浏览器网站数据权限', 'warn');
if (!window.isSecureContext) setStatus('当前不是安全环境（需 localhost 或 https），浏览器将禁止使用摄像头', 'err');

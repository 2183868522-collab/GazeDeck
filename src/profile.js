// A "profile" = everything that is specific to one patient: their resting baseline, recorded examples,
// gesture names, which gesture triggers which action, and thresholds. Saved in the browser and
// exportable as a JSON file, so it can be backed up or moved to another computer.
import { DEFAULT_SEGMENTER_SETTINGS } from './segmenter.js';
import { DEFAULT_CLASSIFIER_SETTINGS, REST_LABEL, UNKNOWN_LABEL } from './classifier.js';
import { DEFAULT_ENGINE_SETTINGS, PAUSE_ACTION } from './engine.js';
import { FEATURE_NAMES } from './features.js';
import { normalise } from './baseline.js';
import { DEFAULT_GAZE_SLIDER_SETTINGS } from './gaze-slider.js';

const STORAGE_KEY = 'eye-gesture-control/profile/v1'; // original single-profile key; retained as backup
const SHARED_DEFAULTS_KEY = 'eye-gesture-control/parameter-defaults/v1';
export const PROFILE_VERSION = 2;
export const FEATURE_VERSION = 1;
const makeId = prefix => `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `p${Date.now()}${Math.random().toString(36).slice(2, 8)}`}`;
export const CALIBRATION_DURATION_FACTORS = Object.freeze([1, 1.5, 2, 3]);
export const calibrationDurationFactor = value => CALIBRATION_DURATION_FACTORS.includes(value) ? value : 2;

export function defaultProfile() {
  return {
    version: PROFILE_VERSION,
    settingsRevision: 6,
    name: '新用户',
    featureNames: FEATURE_NAMES,
    gestures: [REST_LABEL, '长眨', '双眨', '左看', '右看', '上看'],
    baselines: [],
    sessions: [],
    activeBaselineId: null,
    activeSessionId: null,
    samples: [], // v2: raw frames with timestamps; v1 migration: explicitly marked normalized-v1
    testRuns: [], // guided tuning/confirmation runs; never used as training data unless explicitly promoted
    latestTestRunId: null, // the one completed round shown after refresh; null means explicitly cleared
    gazeSlider: {
      calibration: null,
      settings: { ...DEFAULT_GAZE_SLIDER_SETTINGS },
    },
    eyeCalibration: null,
    parameterDefaults: null,
    settings: {
      segmenter: { ...DEFAULT_SEGMENTER_SETTINGS },
      classifier: { ...DEFAULT_CLASSIFIER_SETTINGS },
      engine: { ...DEFAULT_ENGINE_SETTINGS },
      gazeDeckUseClosestGuess: false,
      testCountClosestGuess: false,
      calibrationPace: { personal: 2, slider: 2 },
      cameraAssist: {
        faceGuideEnabled: true,
        faceCenterToleranceX: 0.15,
        faceCenterToleranceY: 0.17,
        faceMinWidth: 0.35,
        faceMaxWidth: 0.65,
        faceMaxHeight: 0.82,
        lightingWarningEnabled: true,
        darkThreshold: 55,
        brightThreshold: 210,
      },
      adaptAlpha: 0.002,
      recordWindowMs: 3000,
      repeats: 5,
    },
    mappings: {
      board: { '长眨': 'select', '左看': 'prev', '右看': 'next', '双眨': PAUSE_ACTION },
      music: { '长眨': 'toggleLoop', '左看': 'chordPrev', '右看': 'chordNext', '双眨': 'accent', '上看': PAUSE_ACTION },
    },
    board: {
      phrases: ['我要喝水', '我要翻身', '有点疼', '请叫护士', '是', '不是', '谢谢', '我很好'],
      autoScan: false,
      scanIntervalMs: 2000,
    },
    music: { bpm: 84, chords: 'C G Am F', midiOutputId: '', volume: 70, effectIntensity: 50 },
  };
}

// Only controls shown in calibration pace, slider, camera-assist and recognition/recording settings.
// Keep calibrations, samples, bindings, devices and unrelated switches out of saved defaults.
const PARAMETER_GROUPS = [
  [['settings', 'calibrationPace'], ['personal', 'slider']],
  [['gazeSlider', 'settings'], ['enabled', 'dwellMs', 'maxRatePerSec', 'deadZone', 'smoothingMs']],
  [['settings', 'cameraAssist'], ['faceGuideEnabled', 'lightingWarningEnabled', 'faceCenterToleranceX', 'faceCenterToleranceY', 'faceMinWidth', 'faceMaxWidth', 'faceMaxHeight', 'darkThreshold', 'brightThreshold']],
  [['settings', 'segmenter'], ['onThreshold', 'offThreshold', 'minOffMs', 'maxDurationMs']],
  [['settings', 'classifier'], ['rejectFactor', 'durationWeight', 'k']],
  [['settings', 'engine'], ['refractoryMs']],
  [['settings'], ['recordWindowMs', 'repeats', 'adaptAlpha']],
];
const validParameterValue = (value, fallback) => typeof value === typeof fallback
  && (typeof fallback === 'boolean' || Number.isFinite(value));
const calibrationPaceKey = key => key === 'settings.calibrationPace.personal' || key === 'settings.calibrationPace.slider';
const parameterValue = (key, value, fallback) => calibrationPaceKey(key)
  ? calibrationDurationFactor(value) : validParameterValue(value, fallback) ? value : fallback;

function parameterValues(p) {
  const factory = defaultProfile(), values = {};
  for (const [path, keys] of PARAMETER_GROUPS) {
    const current = path.reduce((value, key) => value?.[key], p);
    const fallback = path.reduce((value, key) => value[key], factory);
    for (const key of keys) {
      const id = [...path, key].join('.');
      values[id] = parameterValue(id, current?.[key], fallback[key]);
    }
  }
  return values;
}

function validDefaultsRecord(record) {
  if (!record || record.version !== 1 || !Number.isSafeInteger(record.savedAt) || record.savedAt <= 0
    || !record.values || typeof record.values !== 'object' || Array.isArray(record.values)) return null;
  const factory = parameterValues(defaultProfile());
  const values = { ...record.values };
  for (const [key, fallback] of Object.entries(factory)) {
    // Shared defaults saved before calibration pace existed remain usable.
    if (calibrationPaceKey(key) && values[key] === undefined) values[key] = fallback;
    if (!validParameterValue(values[key], fallback)) return null;
    values[key] = parameterValue(key, values[key], fallback);
  }
  return { ...record, values };
}

function readLocalSharedDefaults() {
  try { return validDefaultsRecord(JSON.parse(localStorage.getItem(SHARED_DEFAULTS_KEY))); }
  catch { return null; }
}

function currentSharedDefaults() {
  return profileStorageMode === 'indexedDB' ? cachedSharedDefaults : readLocalSharedDefaults();
}

export function parameterDefaultsInfo(p) {
  const shared = currentSharedDefaults();
  if (shared) return { scope: 'shared', savedAt: shared.savedAt };
  const legacy = validDefaultsRecord(p.parameterDefaults);
  return legacy ? { scope: 'legacy', savedAt: legacy.savedAt } : { scope: 'system', savedAt: null };
}

export async function saveParameterDefaults(p) {
  const saved = { version: 1, savedAt: Date.now(), values: parameterValues(p) };
  if (profileStorageMode === 'indexedDB') {
    try {
      await enqueueProfileWrite(() => new Promise((resolve, reject) => {
        const tx = profileDb.transaction('meta', 'readwrite');
        tx.objectStore('meta').put({ key: 'parameterDefaults', value: saved });
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error || new Error('共享默认设置保存失败'));
        tx.onabort = () => reject(tx.error || new Error('共享默认设置事务已中止'));
      }));
      cachedSharedDefaults = saved;
      return true;
    } catch { return false; }
  }
  try { localStorage.setItem(SHARED_DEFAULTS_KEY, JSON.stringify(saved)); return true; }
  catch { return false; }
}

function applyParameterValues(p, saved) {
  const factory = parameterValues(defaultProfile());
  for (const [path, keys] of PARAMETER_GROUPS) {
    const target = path.reduce((value, key) => (value[key] ??= {}), p);
    for (const key of keys) {
      const id = [...path, key].join('.');
      target[key] = parameterValue(id, saved?.[id], factory[id]);
    }
  }
}

export function restoreParameterDefaults(p, { system = false } = {}) {
  const shared = !system && currentSharedDefaults();
  const legacy = !system && !shared && validDefaultsRecord(p.parameterDefaults);
  applyParameterValues(p, shared?.values || legacy?.values || null);
  return system ? 'system' : shared ? 'shared' : legacy ? 'legacy' : 'system';
}

// Test/migration fixture for the public v1 format. Kept separate so new profiles can never regress to v1.
export function defaultProfileV1ForTest() {
  const p = defaultProfile();
  p.version = 1;
  p.baseline = null;
  delete p.baselines; delete p.sessions; delete p.activeBaselineId; delete p.activeSessionId;
  return p;
}

export function activeBaseline(p) {
  return p.baselines.find(b => b.id === p.activeBaselineId) ?? null;
}

// Rename a class across every baseline/session without touching recorded frames.
// Completed test runs remain historical snapshots of the names used at test time.
export function renameGesture(p, oldName, input) {
  const name = typeof input === 'string' ? input.trim() : '';
  if (oldName === REST_LABEL) throw new Error('自然（防误触）是系统固定类别，不能重命名');
  if (!p.gestures.includes(oldName)) throw new Error('找不到该动作');
  if (!name) throw new Error('动作名称不能为空');
  if (name === REST_LABEL || name === UNKNOWN_LABEL) throw new Error('不能使用系统保留名称');
  if (/[<>"'&\u0000-\u001f]/.test(name)) throw new Error('动作名称不能包含引号、尖括号、& 或控制字符');
  if (name === oldName) return false;
  if (p.gestures.includes(name)) throw new Error('已有同名动作，请使用其他名称');
  // Validate everything before making any change. Define own keys safely even for
  // names such as __proto__, since mappings are ordinary JavaScript objects.
  p.gestures[p.gestures.indexOf(oldName)] = name;
  for (const sample of p.samples) if (sample.label === oldName) sample.label = name;
  for (const mapping of Object.values(p.mappings || {})) {
    if (!Object.hasOwn(mapping, oldName)) continue;
    Object.defineProperty(mapping, name, { value: mapping[oldName], enumerable: true, writable: true, configurable: true });
    delete mapping[oldName];
  }
  const slider = p.gazeSlider?.settings;
  for (const key of ['confirmGesture', 'cancelGesture']) {
    if (slider?.[key] === oldName) slider[key] = name;
  }
  return true;
}

// Delete only this gesture's newest five samples in the active environment.
// Array order resolves equal/missing timestamps for older recordings.
export function deleteLatestGestureSamples(p, label) {
  if (!p.activeBaselineId) return 0;
  const candidates = p.samples.map((sample, index) => ({ sample, index }))
    .filter(({ sample }) => sample.label === label && sample.baselineId === p.activeBaselineId)
    .sort((a, b) => (Number.isFinite(b.sample.createdAt) ? b.sample.createdAt : 0)
      - (Number.isFinite(a.sample.createdAt) ? a.sample.createdAt : 0) || b.index - a.index)
    .slice(0, 5);
  const removed = new Set(candidates.map(({ index }) => index));
  if (removed.size) p.samples = p.samples.filter((_, index) => !removed.has(index));
  return removed.size;
}

export function startSession(p, { reason = 'manual', camera = null } = {}) {
  const session = {
    id: makeId('session'), baselineId: p.activeBaselineId, startedAt: Date.now(), endedAt: null,
    reason, camera, featureVersion: FEATURE_VERSION,
  };
  p.sessions.push(session); p.activeSessionId = session.id;
  return session;
}

export function baselineSampleSummary(p) {
  const counts = new Map();
  for (const sample of p.samples) counts.set(sample.baselineId, (counts.get(sample.baselineId) || 0) + 1);
  return p.baselines.map(baseline => ({
    id: baseline.id, createdAt: baseline.createdAt, numFrames: baseline.numFrames,
    sampleCount: counts.get(baseline.id) || 0, active: baseline.id === p.activeBaselineId,
  }));
}

export function activateBaseline(p, baselineId, { reason = 'baseline-switch' } = {}) {
  const baseline = p.baselines.find(item => item.id === baselineId);
  if (!baseline) throw new Error('找不到所选的历史校准记录');
  if (p.activeBaselineId === baselineId) return baseline;
  const previous = activeBaseline(p);
  if (previous) {
    previous.savedCalibrations ||= {};
    if (p.eyeCalibration?.baselineId === previous.id) previous.savedCalibrations.eye = structuredClone(p.eyeCalibration);
    if (p.gazeSlider?.calibration?.baselineId === previous.id) previous.savedCalibrations.gaze = structuredClone(p.gazeSlider.calibration);
  }
  p.activeBaselineId = baseline.id;
  if (baseline.savedCalibrations?.eye) p.eyeCalibration = structuredClone(baseline.savedCalibrations.eye);
  if (baseline.savedCalibrations?.gaze) p.gazeSlider.calibration = structuredClone(baseline.savedCalibrations.gaze);
  if (p.pendingBaselineId === baseline.id) p.pendingBaselineId = null;
  startSession(p, { reason });
  return baseline;
}

export function restoreRecordedBaseline(p) {
  if (p.samples.some(sample => sample.baselineId === p.activeBaselineId)) return null;
  const previous = baselineSampleSummary(p).slice().reverse().find(item => item.sampleCount > 0);
  if (!previous) return null;
  const fromId = p.activeBaselineId;
  activateBaseline(p, previous.id, { reason: 'restore-recorded-samples' });
  return { fromId, baselineId: previous.id, sampleCount: previous.sampleCount, restoredAt: Date.now() };
}

// One-time repair for older versions that silently activated an empty environment.
// Later, deliberately selected empty environments must remain selectable.
export function repairLegacyBaselineSelection(p) {
  if (p.baselineSafetyVersion >= 1) return { changed: false, recovery: null };
  const recovery = restoreRecordedBaseline(p);
  p.baselineSafetyVersion = 1;
  if (recovery) p.baselineRecoveryNotice = recovery;
  return { changed: true, recovery };
}

export function addBaseline(p, baseline, metadata = {}, { activate = true } = {}) {
  const stored = {
    ...structuredClone(baseline), id: makeId('baseline'), createdAt: Date.now(),
    featureVersion: FEATURE_VERSION, ...metadata,
  };
  p.baselines.push(stored);
  if (activate) activateBaseline(p, stored.id, { reason: 'calibration' });
  return stored;
}

export function createRawSample(p, label, segment) {
  if (!p.activeBaselineId || !p.activeSessionId) throw new Error('录制样本前需要有效的校准和 session');
  if (!segment.rawFrames?.length || segment.rawFrames.length !== segment.timestampsMs?.length) {
    throw new Error('片段缺少原始帧或时间戳');
  }
  const t0 = segment.timestampsMs[0];
  return {
    id: makeId('sample'), label, durationMs: Math.round(segment.durationMs * 1000) / 1000, createdAt: Date.now(),
    baselineId: p.activeBaselineId, sessionId: p.activeSessionId,
    encoding: 'raw-v2', featureVersion: FEATURE_VERSION,
    frames: segment.rawFrames.map((frame, i) => ({
      offsetMs: Math.round((segment.timestampsMs[i] - t0) * 1000) / 1000,
      values: Array.from(frame, value => Math.round(value * 100000) / 100000),
    })),
  };
}

export function materialiseSample(p, sample) {
  if (sample.encoding === 'normalized-v1') return { label: sample.label, frames: sample.frames, durationMs: sample.durationMs };
  const baseline = p.baselines.find(b => b.id === sample.baselineId);
  if (!baseline || sample.encoding !== 'raw-v2') return null;
  return { label: sample.label, frames: sample.frames.map(f => normalise(f.values, baseline, p.eyeCalibration)), durationMs: sample.durationMs };
}

function migrateV1(p) {
  const out = structuredClone(p), stamp = Date.now();
  out.version = PROFILE_VERSION;
  out.baselines = []; out.sessions = [];
  out.activeBaselineId = null; out.activeSessionId = null;
  if (p.baseline) {
    const baselineId = `baseline-legacy-${stamp}`;
    const sessionId = `session-legacy-${stamp}`;
    out.baselines.push({ ...structuredClone(p.baseline), id: baselineId, createdAt: stamp, featureVersion: FEATURE_VERSION, legacy: true });
    out.sessions.push({ id: sessionId, baselineId, startedAt: stamp, endedAt: null, reason: 'v1-migration', featureVersion: FEATURE_VERSION, legacy: true });
    out.activeBaselineId = baselineId; out.activeSessionId = sessionId;
    out.samples = (p.samples || []).map(s => ({
      ...structuredClone(s), encoding: 'normalized-v1', featureVersion: FEATURE_VERSION, baselineId, sessionId,
    }));
  } else out.samples = (p.samples || []).map(s => ({ ...structuredClone(s), encoding: 'normalized-v1', featureVersion: FEATURE_VERSION, baselineId: null, sessionId: null }));
  delete out.baseline;
  return out;
}

// Fill in fields missing from older saved profiles so new settings get their defaults.
function mergeDefaults(p) {
  const d = defaultProfile();
  const out = { ...d, ...p };
  out.settings = { ...d.settings, ...p.settings };
  for (const k of ['segmenter', 'classifier', 'engine', 'cameraAssist', 'calibrationPace']) out.settings[k] = { ...d.settings[k], ...(p.settings?.[k] || {}) };
  for (const key of ['personal', 'slider']) out.settings.calibrationPace[key] = calibrationDurationFactor(out.settings.calibrationPace[key]);
  out.mappings = { ...d.mappings, ...p.mappings };
  out.board = { ...d.board, ...p.board };
  out.music = { ...d.music, ...p.music };
  out.gazeSlider = {
    ...d.gazeSlider,
    ...(p.gazeSlider || {}),
    settings: { ...d.gazeSlider.settings, ...(p.gazeSlider?.settings || {}) },
  };
  out.testRuns = Array.isArray(p.testRuns) ? p.testRuns : [];
  const latestSavedRun = out.testRuns.findLast(run => run && typeof run.id === 'string'
    && (run.phase === 'tuning' ? run.summary?.byLabel : run.phase === 'confirmation' && run.before?.byLabel && run.after?.byLabel));
  // Older profiles already contain testRuns but had no pointer for restoring the page.
  // Keep an explicit null after deletion so an older historical run does not reappear.
  const latestId = Object.hasOwn(p, 'latestTestRunId') ? p.latestTestRunId : latestSavedRun?.id;
  out.latestTestRunId = typeof latestId === 'string' && out.testRuns.some(run => run?.id === latestId) ? latestId : null;
  // Settings revision 2 (v0.2.3): the old 150 ms "rest confirmation" split real double blinks in two.
  // Upgrade it only if the user never changed it from the old default.
  if ((p.settingsRevision ?? 1) < 2 && out.settings.segmenter.minOffMs === 150) out.settings.segmenter.minOffMs = d.settings.segmenter.minOffMs;
  // Settings revision 4: increase the default minimum face width for a closer camera position.
  // Upgrade only profiles that still carry the previous untouched default.
  if ((p.settingsRevision ?? 1) < 4 && p.settings?.cameraAssist?.faceMinWidth === 0.25) out.settings.cameraAssist.faceMinWidth = 0.38;
  // Settings revision 5: lower the default close-distance width limit and add a height limit.
  // Preserve any user-customized thresholds.
  if ((p.settingsRevision ?? 1) < 5 && p.settings?.cameraAssist?.faceMaxWidth === 0.72) out.settings.cameraAssist.faceMaxWidth = 0.62;
  // Settings revision 6: centre the eyes in the preview and allow a little more
  // horizontal, vertical and distance variation. Keep values changed by the user.
  if ((p.settingsRevision ?? 1) < 6) {
    for (const [key, previousDefault] of Object.entries({
      faceCenterToleranceX: 0.12,
      faceCenterToleranceY: 0.14,
      faceMinWidth: 0.38,
      faceMaxWidth: 0.62,
      faceMaxHeight: 0.78,
    })) {
      if (out.settings.cameraAssist[key] === previousDefault) out.settings.cameraAssist[key] = d.settings.cameraAssist[key];
    }
  }
  out.settingsRevision = 6;
  return out;
}

export function validateProfile(p) {
  if (!p || typeof p !== 'object') throw new Error('不是有效的档案文件');
  if (p.version === 1) p = migrateV1(p);
  if (p.version !== PROFILE_VERSION) throw new Error(`档案版本 ${p.version} 不受支持`);
  if (JSON.stringify(p.featureNames) !== JSON.stringify(FEATURE_NAMES)) {
    throw new Error('档案的特征定义与当前程序不一致（程序升级过？），样本无法直接使用');
  }
  return mergeDefaults(p);
}

// ---------------------------------------------------------------- multi-user store
// Each person gets their own profile under its own key; a small index records which profiles exist
// and which one is active. Browser storage can be unavailable (private window, blocked site data),
// so every access is wrapped and the app keeps working in memory.
const INDEX_KEY = 'eye-gesture-control/profiles/v1';
const profileKey = id => `eye-gesture-control/profile/v1/${id}`;
const newId = () => makeId('profile');
const STORAGE_FRAME_CODEC = 'i32-e5-base64-v1';
const PROFILE_DB_NAME = 'eye-gesture-control/archive';
const PROFILE_DB_VERSION = 1;
let profileDb = null;
let profileStorageMode = 'localStorage';
let cachedProfiles = new Map();
let cachedProfileIndex = null;
let cachedSharedDefaults = null;
let profileWriteQueue = Promise.resolve();

function cloneProfile(profile) {
  return JSON.parse(JSON.stringify(profile));
}

function signalProfileStorageError(error) {
  console.error('[profile] IndexedDB write failed:', error);
  window.dispatchEvent(new CustomEvent('eye-profile-storage-error', {
    detail: { message: error?.message || '浏览器扩展存储写入失败' },
  }));
}

function openProfileDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(PROFILE_DB_NAME, PROFILE_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('profiles')) db.createObjectStore('profiles', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('无法打开 IndexedDB'));
    request.onblocked = () => reject(new Error('档案数据库正在被其他页面占用，请关闭其他项目标签页后重试'));
  });
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('读取档案数据库失败'));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('档案数据库事务失败'));
    transaction.onabort = () => reject(transaction.error || new Error('档案数据库事务已中止'));
  });
}

function enqueueProfileWrite(operation) {
  const pending = profileWriteQueue.catch(() => {}).then(operation);
  profileWriteQueue = pending;
  pending.catch(signalProfileStorageError);
  return pending;
}

async function persistProfileSnapshot(profile, index) {
  if (!profileDb) throw new Error('档案数据库尚未就绪');
  await enqueueProfileWrite(() => new Promise((resolve, reject) => {
    const tx = profileDb.transaction(['profiles', 'meta'], 'readwrite');
    tx.objectStore('profiles').put(cloneProfile(profile));
    tx.objectStore('meta').put({ key: 'profilesIndex', value: { ...index, ids: [...index.ids] } });
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error || new Error('档案保存失败'));
    tx.onabort = () => reject(tx.error || new Error('档案保存事务已中止'));
  }));
}

/** Initialize the larger IndexedDB archive and migrate existing localStorage profiles without deleting them. */
export async function initProfileStore() {
  if (typeof indexedDB === 'undefined') return false;
  try {
    profileDb = await openProfileDatabase();
    profileDb.onversionchange = () => profileDb.close();

    const readTx = profileDb.transaction(['profiles', 'meta'], 'readonly');
    const storedRecordsPromise = requestResult(readTx.objectStore('profiles').getAll());
    const storedIndexPromise = requestResult(readTx.objectStore('meta').get('profilesIndex'));
    const storedDefaultsPromise = requestResult(readTx.objectStore('meta').get('parameterDefaults'));
    const [storedRecords, storedIndexRecord, storedDefaultsRecord] = await Promise.all([
      storedRecordsPromise, storedIndexPromise, storedDefaultsPromise,
    ]);
    const indexedDefaults = validDefaultsRecord(storedDefaultsRecord?.value);
    cachedSharedDefaults = indexedDefaults || readLocalSharedDefaults();

    // Read and recover the old store before switching the active backend. The old data is retained.
    let legacyIndex = discoverOrphanProfiles(readIndex());
    if (!legacyIndex) {
      const legacyProfile = migrateLegacy();
      if (legacyProfile) legacyIndex = readIndex();
    }
    const mergedProfiles = new Map();
    for (const record of storedRecords) {
      try { mergedProfiles.set(record.id, validateProfile(record)); }
      catch (error) { console.warn('[profile] skipped invalid IndexedDB archive entry', error); }
    }
    for (const id of legacyIndex?.ids || []) {
      if (mergedProfiles.has(id)) continue;
      const profile = readProfile(id);
      if (profile) mergedProfiles.set(id, profile);
    }

    const validIds = new Set(mergedProfiles.keys());
    const ids = [...(storedIndexRecord?.value?.ids || []).filter(id => validIds.has(id))];
    for (const id of legacyIndex?.ids || []) if (validIds.has(id) && !ids.includes(id)) ids.push(id);
    for (const id of validIds) if (!ids.includes(id)) ids.push(id);
    const preferredActive = storedIndexRecord?.value?.activeId;
    let activeId = validIds.has(preferredActive) ? preferredActive
      : validIds.has(legacyIndex?.activeId) ? legacyIndex.activeId : ids[0] || null;

    if (!ids.length) {
      const p = defaultProfile(); p.id = newId(); p.name = '用户 1';
      if (cachedSharedDefaults) applyParameterValues(p, cachedSharedDefaults.values);
      mergedProfiles.set(p.id, p); ids.push(p.id); activeId = p.id;
    }
    cachedProfiles = mergedProfiles;
    cachedProfileIndex = { activeId, ids };
    profileStorageMode = 'indexedDB';

    // Import each old profile that is not already present and commit the merged index atomically.
    await enqueueProfileWrite(() => new Promise((resolve, reject) => {
      const tx = profileDb.transaction(['profiles', 'meta'], 'readwrite');
      const store = tx.objectStore('profiles');
      for (const id of ids) if (!storedRecords.some(record => record.id === id)) store.put(cloneProfile(mergedProfiles.get(id)));
      tx.objectStore('meta').put({ key: 'profilesIndex', value: { ...cachedProfileIndex, ids: [...ids] } });
      if (!indexedDefaults && cachedSharedDefaults) {
        tx.objectStore('meta').put({ key: 'parameterDefaults', value: cachedSharedDefaults });
      }
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error('迁移旧档案失败'));
      tx.onabort = () => reject(tx.error || new Error('旧档案迁移事务已中止'));
    }));
    // Persistent storage is best-effort; IndexedDB itself already has a substantially larger quota.
    navigator.storage?.persist?.().catch(() => {});
    return true;
  } catch (error) {
    console.warn('[profile] IndexedDB unavailable; retaining localStorage backend:', error);
    profileDb?.close(); profileDb = null;
    profileWriteQueue = Promise.resolve();
    profileStorageMode = 'localStorage';
    cachedSharedDefaults = null;
    return false;
  }
}

export async function flushProfileStore() {
  await profileWriteQueue;
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

// Keep the public/exported profile format readable. The localStorage copy packs each
// five-decimal raw feature as a scaled int32, preserving its stored value with less quota.
function encodeStoredProfile(profile) {
  const samples = (profile.samples || []).map(sample => {
    if (sample.encoding !== 'raw-v2' || !Array.isArray(sample.frames) || !sample.frames.length) return sample;
    const featureCount = sample.frames[0].values?.length;
    if (!Number.isInteger(featureCount) || !sample.frames.every(frame => frame.values?.length === featureCount)) return sample;
    const bytes = new Uint8Array(sample.frames.length * featureCount * 4);
    const view = new DataView(bytes.buffer);
    let offset = 0;
    for (const frame of sample.frames) for (const value of frame.values) {
      view.setInt32(offset, Math.round(value * 100000), true); offset += 4;
    }
    const { frames, ...metadata } = sample;
    return { ...metadata, storageFrames: {
      codec: STORAGE_FRAME_CODEC, featureCount,
      offsetsMs: frames.map(frame => frame.offsetMs),
      base64: bytesToBase64(bytes),
    } };
  });
  return JSON.stringify({ ...profile, samples });
}

function decodeStoredProfile(value) {
  if (!Array.isArray(value?.samples)) return value;
  return {
    ...value,
    samples: value.samples.map(sample => {
      const packed = sample.storageFrames;
      if (packed?.codec !== STORAGE_FRAME_CODEC) return sample;
      const bytes = base64ToBytes(packed.base64);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const valuesPerFrame = packed.featureCount;
      if (!Number.isInteger(valuesPerFrame) || valuesPerFrame < 1 || bytes.byteLength % (valuesPerFrame * 4)) {
        throw new Error('档案中的压缩样本数据不完整');
      }
      const frameCount = bytes.byteLength / (valuesPerFrame * 4);
      if (!Array.isArray(packed.offsetsMs) || packed.offsetsMs.length !== frameCount) throw new Error('档案中的样本时间戳不完整');
      const frames = Array.from({ length: frameCount }, (_, frameIndex) => ({
        offsetMs: packed.offsetsMs[frameIndex],
        values: Array.from({ length: valuesPerFrame }, (_, featureIndex) =>
          view.getInt32((frameIndex * valuesPerFrame + featureIndex) * 4, true) / 100000),
      }));
      const { storageFrames, ...metadata } = sample;
      return { ...metadata, frames };
    }),
  };
}

function readIndex() {
  if (profileStorageMode === 'indexedDB') return cachedProfileIndex && { ...cachedProfileIndex, ids: [...cachedProfileIndex.ids] };
  try { const raw = localStorage.getItem(INDEX_KEY); if (raw) return JSON.parse(raw); } catch { /* unavailable */ }
  return null;
}
function writeIndex(index) {
  if (profileStorageMode === 'indexedDB') {
    cachedProfileIndex = { ...index, ids: [...index.ids] };
    enqueueProfileWrite(() => new Promise((resolve, reject) => {
      const tx = profileDb.transaction('meta', 'readwrite');
      tx.objectStore('meta').put({ key: 'profilesIndex', value: cachedProfileIndex });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error('用户索引写入失败'));
      tx.onabort = () => reject(tx.error || new Error('用户索引事务已中止'));
    }));
    return true;
  }
  try { localStorage.setItem(INDEX_KEY, JSON.stringify(index)); return true; } catch { return false; }
}
function readProfile(id) {
  if (profileStorageMode === 'indexedDB') {
    const profile = cachedProfiles.get(id);
    return profile ? cloneProfile(profile) : null;
  }
  try { const raw = localStorage.getItem(profileKey(id)); if (raw) return validateProfile(decodeStoredProfile(JSON.parse(raw))); }
  catch (e) { console.warn('[profile] cannot read', id, e); }
  return null;
}

function compactStoredProfiles(index) {
  if (profileStorageMode === 'indexedDB') return;
  for (const id of index?.ids || []) {
    try {
      const key = profileKey(id), raw = localStorage.getItem(key);
      if (!raw) continue;
      const compact = encodeStoredProfile(validateProfile(decodeStoredProfile(JSON.parse(raw))));
      if (compact.length < raw.length) localStorage.setItem(key, compact);
    } catch (e) { console.warn('[profile] storage compaction skipped for', id, e); }
  }
}

function discoverOrphanProfiles(index) {
  const prefix = `${INDEX_KEY.replace(/profiles\/v1$/, 'profile/v1')}/`;
  const keys = [];
  try {
    if (Number.isInteger(localStorage.length) && typeof localStorage.key === 'function') {
      for (let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i));
    } else if (typeof localStorage.keys === 'function') keys.push(...localStorage.keys());
  } catch { return index; }

  const ids = [...(index?.ids || [])];
  const known = new Set(ids);
  for (const key of keys) {
    if (!key?.startsWith(prefix)) continue;
    const id = key.slice(prefix.length);
    if (!id || known.has(id) || !readProfile(id)) continue;
    known.add(id); ids.push(id);
  }
  if (!ids.length) return index;
  const recovered = { activeId: index?.activeId || ids[0], ids };
  compactStoredProfiles(recovered);
  if (ids.length !== (index?.ids?.length || 0) && !writeIndex(recovered)) {
    console.warn('[profile] recovered user profiles could not be added to the index yet');
    return index;
  }
  return recovered;
}

// v0.1 stored a single profile under STORAGE_KEY. Move it into the multi-user store as the first user.
// The old key is left in place as a backup; it is never read again once the index exists.
function migrateLegacy() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const p = validateProfile(JSON.parse(raw));
    p.id = newId();
    localStorage.setItem(profileKey(p.id), JSON.stringify(p));
    writeIndex({ activeId: p.id, ids: [p.id] });
    return p;
  } catch (e) { console.warn('[profile] legacy migration failed:', e); return null; }
}

/** Load the active profile, creating (or migrating) one if the store is empty. */
export function loadProfile() {
  if (profileStorageMode === 'indexedDB') {
    const index = readIndex();
    const p = readProfile(index?.activeId) ?? index?.ids.map(readProfile).find(Boolean);
    if (p) return p;
    const fresh = defaultProfile(); fresh.id = newId(); fresh.name = '用户 1';
    restoreParameterDefaults(fresh);
    saveProfile(fresh);
    return fresh;
  }
  const index = discoverOrphanProfiles(readIndex());
  if (index) {
    const p = readProfile(index.activeId) ?? index.ids.map(readProfile).find(Boolean);
    if (p) { if (p.id !== index.activeId) writeIndex({ ...index, activeId: p.id }); return p; }
  }
  const migrated = migrateLegacy();
  if (migrated) return migrated;
  try { return createProfile('用户 1'); }
  catch (e) {
    console.warn('[profile] starting with an in-memory profile because storage is unavailable:', e);
    const p = defaultProfile(); p.id = newId(); p.name = '用户 1'; restoreParameterDefaults(p); return p;
  }
}

export function saveProfile(p) {
  if (!p.id) p.id = newId();
  if (profileStorageMode === 'indexedDB') {
    const snapshot = cloneProfile(p);
    const index = readIndex() ?? { activeId: p.id, ids: [] };
    if (!index.ids.includes(p.id)) index.ids.push(p.id);
    index.activeId = p.id;
    cachedProfiles.set(p.id, snapshot);
    cachedProfileIndex = index;
    persistProfileSnapshot(snapshot, index).catch(() => {});
    return true;
  }
  const key = profileKey(p.id);
  let previousProfile = null;
  try {
    previousProfile = localStorage.getItem(key);
    localStorage.setItem(key, encodeStoredProfile(p));
    const index = readIndex() ?? { activeId: p.id, ids: [] };
    if (!index.ids.includes(p.id)) index.ids.push(p.id);
    index.activeId = p.id;
    if (!writeIndex(index)) throw new Error('用户索引无法写入');
    return true;
  } catch (e) {
    console.warn('[profile] save failed; compacting existing profiles and retrying:', e);
    compactStoredProfiles(readIndex());
    try {
      localStorage.setItem(key, encodeStoredProfile(p));
      const index = readIndex() ?? { activeId: p.id, ids: [] };
      if (!index.ids.includes(p.id)) index.ids.push(p.id);
      index.activeId = p.id;
      if (writeIndex(index)) return true;
    } catch (retryError) { console.warn('[profile] compacted retry failed:', retryError); }
    try {
      if (previousProfile === null) localStorage.removeItem(key);
      else localStorage.setItem(key, previousProfile);
    } catch { /* best effort rollback if storage is exhausted */ }
    return false;
  }
}

/** [{ id, name, samples, calibrated }] for the user picker. */
export function listProfiles() {
  const index = readIndex();
  if (!index) return [];
  return index.ids.map(id => {
    const p = readProfile(id);
    return p && { id, name: p.name, samples: p.samples.length, calibrated: !!activeBaseline(p) };
  }).filter(Boolean);
}

// Quick experience copies each user's samples into its own versioned archive.
// Return validated snapshots, never live cached profile objects.
export function listProfileSnapshots() {
  return (readIndex()?.ids || []).map(readProfile).filter(Boolean);
}

export function switchProfile(id) {
  const p = readProfile(id);
  if (!p) throw new Error('找不到这个用户的档案');
  const index = readIndex();
  writeIndex({ ...index, activeId: id });
  return p;
}

export function createProfile(name) {
  const p = defaultProfile();
  p.id = newId();
  p.name = name;
  restoreParameterDefaults(p);
  if (!saveProfile(p)) throw new Error('浏览器存储空间不足，无法保存新用户。请先导出并备份样本较多的档案，再清理不需要的档案后重试。');
  return p;
}

/** Delete a profile; returns the profile that becomes active (a fresh one if none is left). */
export function deleteProfile(id) {
  const index = readIndex() ?? { ids: [] };
  if (profileStorageMode === 'indexedDB') {
    const ids = index.ids.filter(x => x !== id);
    cachedProfiles.delete(id);
    cachedProfileIndex = { activeId: ids[0] ?? null, ids };
    enqueueProfileWrite(() => new Promise((resolve, reject) => {
      const tx = profileDb.transaction(['profiles', 'meta'], 'readwrite');
      tx.objectStore('profiles').delete(id);
      tx.objectStore('meta').put({ key: 'profilesIndex', value: cachedProfileIndex });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error('删除档案失败'));
      tx.onabort = () => reject(tx.error || new Error('删除档案事务已中止'));
    }));
    return ids.length ? switchProfile(ids[0]) : createProfile('用户 1');
  }
  try { localStorage.removeItem(profileKey(id)); } catch { /* unavailable */ }
  const ids = index.ids.filter(x => x !== id);
  writeIndex({ activeId: ids[0] ?? null, ids });
  return ids.length ? switchProfile(ids[0]) : createProfile('用户 1');
}

export function exportProfile(p) {
  const blob = new Blob([JSON.stringify(p)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  a.download = `eye-profile-${p.name}-${stamp}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// An imported file always becomes a *new* user, so importing can never overwrite someone else's data.
export async function importProfile(file) {
  const p = validateProfile(JSON.parse(await file.text()));
  p.id = newId();
  if (!saveProfile(p)) throw new Error('浏览器存储空间不足，导入的用户档案未保存。请先导出并备份样本较多的档案，再清理不需要的档案后重试。');
  await flushProfileStore();
  return p;
}

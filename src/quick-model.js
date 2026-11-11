// Shared, versioned recognition templates for the optional quick experience.
// Each source recording is normalised against its *own* recorded resting baseline.
import { normalise } from './baseline.js';
import { FEATURE_NAMES } from './features.js';
import { GestureClassifier, REST_LABEL, resample } from './classifier.js';

export const QUICK_LABELS = Object.freeze([REST_LABEL, '长眨', '双眨', '左看', '右看', '上看', '下看']);
export const QUICK_FORMAT = 'gazedeck-quick-model/v1';
export const RETIRED_BUNDLED_QUICK_MODEL_ID = 'builtin-quick-model-v1';
const SEQUENCE_LENGTH = 20;
const MAX_PROTOTYPES_PER_LABEL = 24;
const SETTINGS_TO_COMPARE = Object.freeze([
  { k: 1, rejectFactor: 1.6, durationWeight: 1.0 },
  { k: 3, rejectFactor: 2.0, durationWeight: 1.0 },
  { k: 3, rejectFactor: 1.7, durationWeight: 1.3 },
]);

const newId = () => globalThis.crypto?.randomUUID?.() ?? `q-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const validFrame = frame => Array.isArray(frame) && frame.length === FEATURE_NAMES.length
  && frame.every(Number.isFinite);
const validSequence = frames => Array.isArray(frames) && frames.length === SEQUENCE_LENGTH
  && frames.every(validFrame);

export function emptyQuickState() {
  return { format: QUICK_FORMAT, datasets: [], versions: [], candidate: null,
    activeVersionId: null, initialVersionId: null };
}

function preparedSample(profile, sample, index) {
  if (!sample || !Number.isFinite(sample.durationMs) || sample.durationMs <= 0) return null;
  if (sample.featureVersion != null && sample.featureVersion !== 1) return null;
  if (profile.featureNames?.join('|') !== FEATURE_NAMES.join('|')) return null;
  let frames;
  if (sample.encoding === 'raw-v2') {
    const baseline = profile.baselines?.find(item => item.id === sample.baselineId);
    if (!baseline || !Array.isArray(sample.frames)) return null;
    frames = sample.frames.map(frame => frame?.values && normalise(frame.values, baseline));
  } else if (sample.encoding === 'normalized-v1') {
    frames = sample.frames;
  } else return null;
  if (!Array.isArray(frames) || !frames.length || !frames.every(frame => frame?.length === FEATURE_NAMES.length
    && Array.from(frame).every(Number.isFinite))) return null;
  const compact = resample(frames, SEQUENCE_LENGTH).map(frame => Array.from(frame, value => Math.round(value * 10000) / 10000));
  if (!validSequence(compact)) return null;
  return {
    key: String(sample.id ?? `${sample.sessionId || 'legacy'}:${index}`),
    label: String(sample.label || ''), sessionId: String(sample.sessionId || ''),
    durationMs: sample.durationMs, frames: compact,
  };
}

export function datasetFromProfile(profile, previous = null) {
  if (!profile?.id || !Array.isArray(profile.samples)) return null;
  const samples = profile.samples.map((sample, index) => preparedSample(profile, sample, index)).filter(Boolean);
  const labels = [...new Set(samples.map(sample => sample.label))];
  const mappings = Object.fromEntries(labels.map(label => [label,
    previous?.mappings?.[label] !== undefined ? previous.mappings[label] : QUICK_LABELS.includes(label) ? label : '',
  ]));
  return {
    id: String(profile.id), name: String(profile.name || '未命名用户'),
    enabled: previous?.enabled !== false, syncedAt: Date.now(),
    sourceCount: profile.samples.length, samples, mappings,
  };
}

export function syncProfileDatasets(state, profiles, selectedIds = null) {
  const selected = selectedIds ? new Set(selectedIds) : null;
  let added = 0, updated = 0;
  for (const profile of profiles) {
    if (selected && !selected.has(profile.id)) continue;
    const index = state.datasets.findIndex(dataset => dataset.id === profile.id);
    const dataset = datasetFromProfile(profile, index >= 0 ? state.datasets[index] : null);
    if (!dataset) continue;
    if (index < 0) { state.datasets.push(dataset); added++; }
    else { state.datasets[index] = dataset; updated++; }
  }
  return { added, updated };
}

export function collectIncludedSamples(datasets) {
  const included = [];
  for (const dataset of datasets || []) {
    if (!dataset?.enabled) continue;
    for (const sample of dataset.samples || []) {
      const label = dataset.mappings?.[sample.label];
      if (!QUICK_LABELS.includes(label) || !validSequence(sample.frames)
        || !Number.isFinite(sample.durationMs) || sample.durationMs <= 0) continue;
      included.push({ ...sample, label, userId: dataset.id, userName: dataset.name });
    }
  }
  return included;
}

function spreadOrder(items) {
  const ordered = [];
  let left = 0, right = items.length - 1;
  while (left <= right) {
    const middle = Math.floor((left + right) / 2);
    ordered.push(items[middle]);
    if (middle !== left) ordered.push(items[left]);
    if (middle !== right) ordered.push(items[right]);
    left++; right--;
  }
  return [...new Map(ordered.map(item => [item.key, item])).values()];
}

// Limit live DTW comparisons while giving each user representation in every class.
export function selectPrototypes(samples, perLabel = MAX_PROTOTYPES_PER_LABEL) {
  const output = [];
  for (const label of QUICK_LABELS) {
    const own = samples.filter(sample => sample.label === label);
    if (own.length < 2) continue; // a singleton has no within-class rejection scale
    const groups = new Map();
    for (const sample of own) {
      if (!groups.has(sample.userId)) groups.set(sample.userId, []);
      groups.get(sample.userId).push(sample);
    }
    const queues = [...groups.values()].map(group => spreadOrder(group));
    let taken = 0;
    while (taken < perLabel && queues.some(queue => queue.length)) {
      for (const queue of queues) {
        const sample = queue.shift();
        if (!sample) continue;
        output.push({ label, frames: sample.frames, durationMs: sample.durationMs });
        if (++taken >= perLabel) break;
      }
    }
  }
  return output;
}

export function evaluateAcrossUsers(samples, settings) {
  const users = [...new Set(samples.map(sample => sample.userId))];
  if (users.length < 2) return { status: 'insufficient-users', userCount: users.length };
  const rows = Object.fromEntries(QUICK_LABELS.map(label => [label, { total: 0, success: 0 }]));
  let unknown = 0, falseNatural = 0, total = 0;
  let incompleteFold = false;
  const timings = [];
  for (const heldOut of users) {
    const training = selectPrototypes(samples.filter(sample => sample.userId !== heldOut));
    if (!training.length) { incompleteFold = true; continue; }
    const classifier = new GestureClassifier(settings);
    classifier.fit(training);
    for (const sample of samples) {
      if (sample.userId !== heldOut) continue;
      const start = performance.now();
      const prediction = classifier.predict(sample.frames, sample.durationMs);
      timings.push(performance.now() - start);
      const row = rows[sample.label];
      row.total++; total++;
      if (prediction.label === '未知') unknown++;
      const success = sample.label === REST_LABEL
        ? prediction.label === REST_LABEL || prediction.label === '未知'
        : prediction.label === sample.label;
      if (success) row.success++;
      if (sample.label === REST_LABEL && !success) falseNatural++;
    }
  }
  if (!total || incompleteFold) return { status: 'insufficient-training', userCount: users.length };
  const present = Object.values(rows).filter(row => row.total);
  timings.sort((a, b) => a - b);
  return {
    status: 'ok', userCount: users.length, total,
    balancedAccuracy: present.reduce((sum, row) => sum + row.success / row.total, 0) / present.length,
    falseNaturalRate: rows[REST_LABEL].total ? falseNatural / rows[REST_LABEL].total : null,
    unknownRate: unknown / total, p95Ms: timings[Math.ceil(timings.length * 0.95) - 1] || 0,
    byLabel: rows,
  };
}

export function buildQuickCandidate(datasets) {
  const samples = collectIncludedSamples(datasets);
  const counts = Object.fromEntries(QUICK_LABELS.map(label => [label, samples.filter(s => s.label === label).length]));
  if (counts[REST_LABEL] < 2 || Object.entries(counts).filter(([label, n]) => label !== REST_LABEL && n >= 2).length < 1) {
    throw new Error('至少需要 2 个“自然”样本和同一动作的 2 个样本，才能构建快捷模型。');
  }
  let chosen = null;
  for (const partial of SETTINGS_TO_COMPARE) {
    const settings = { resampleLength: SEQUENCE_LENGTH, band: 3, ...partial };
    const report = evaluateAcrossUsers(samples, settings);
    if (!chosen || report.status === 'ok' && (chosen.report.status !== 'ok'
      || report.balancedAccuracy > chosen.report.balancedAccuracy
      || report.balancedAccuracy === chosen.report.balancedAccuracy
        && (report.falseNaturalRate ?? 1) < (chosen.report.falseNaturalRate ?? 1))) {
      chosen = { settings, report };
    }
  }
  const model = selectPrototypes(samples);
  const users = [...new Set(samples.map(sample => sample.userId))];
  return {
    id: newId(), createdAt: Date.now(), name: '快捷体验候选模型',
    settings: chosen.settings, model, report: chosen.report,
    sourceUserIds: users, sourceSampleCount: samples.length, counts,
  };
}

export function validQuickVersion(version) {
  return !!version && typeof version.id === 'string' && Array.isArray(version.model)
    && version.model.length > 0 && version.model.length <= QUICK_LABELS.length * MAX_PROTOTYPES_PER_LABEL
    && version.model.every(sample => QUICK_LABELS.includes(sample.label)
      && validSequence(sample.frames) && Number.isFinite(sample.durationMs) && sample.durationMs > 0)
    && Number.isInteger(version.settings?.k) && version.settings.k >= 1 && version.settings.k <= 5
    && Number.isFinite(version.settings?.rejectFactor) && version.settings.rejectFactor > 0 && version.settings.rejectFactor <= 10
    && Number.isFinite(version.settings?.durationWeight) && version.settings.durationWeight >= 0 && version.settings.durationWeight <= 5
    && version.settings.resampleLength === SEQUENCE_LENGTH && version.settings.band === 3;
}

export function validateQuickState(value) {
  if (!value || value.format !== QUICK_FORMAT || !Array.isArray(value.datasets)
    || !Array.isArray(value.versions)) throw new Error('快捷模型数据包格式不受支持');
  const state = emptyQuickState();
  state.datasets = value.datasets.filter(dataset => dataset && typeof dataset.id === 'string'
    && Array.isArray(dataset.samples)).map(dataset => ({
      id: dataset.id, name: String(dataset.name || '未命名用户'), enabled: dataset.enabled !== false,
      syncedAt: Number(dataset.syncedAt) || 0, sourceCount: Number(dataset.sourceCount) || 0,
      mappings: Object.fromEntries(Object.entries(dataset.mappings || {}).filter(([, target]) => target === '' || QUICK_LABELS.includes(target))),
      samples: dataset.samples.filter(sample => sample && typeof sample.key === 'string'
        && typeof sample.label === 'string' && validSequence(sample.frames)
        && Number.isFinite(sample.durationMs) && sample.durationMs > 0),
    }));
  state.versions = value.versions.filter(validQuickVersion);
  state.candidate = validQuickVersion(value.candidate) ? value.candidate : null;
  state.activeVersionId = state.versions.some(version => version.id === value.activeVersionId) ? value.activeVersionId : null;
  state.initialVersionId = state.versions.some(version => version.id === value.initialVersionId) ? value.initialVersionId : null;
  return state;
}

// First-run installation must not replace user-maintained sources or versions.
// An already selected model always wins over the bundled starting point.
export function installBundledQuickState(currentValue, bundledValue) {
  const current = validateQuickState(currentValue);
  const bundled = validateQuickState(bundledValue);
  if (!bundled.activeVersionId || !bundled.initialVersionId || bundled.versions.length !== 1
    || !bundled.datasets.length) throw new Error('内置快捷模型缺少初始版本或来源数据');
  // Replace the retired built-in version even for existing browsers. A custom active
  // version stays selected; only the shipped starting point is changed.
  if (current.versions.some(version => version.id === RETIRED_BUNDLED_QUICK_MODEL_ID)
    && bundled.activeVersionId !== RETIRED_BUNDLED_QUICK_MODEL_ID) {
    const versions = current.versions.filter(version => version.id !== RETIRED_BUNDLED_QUICK_MODEL_ID);
    const existingVersions = new Set(versions.map(version => version.id));
    const existingDatasets = new Set(current.datasets.map(dataset => dataset.id));
    return validateQuickState({
      ...current,
      datasets: [...bundled.datasets.filter(dataset => !existingDatasets.has(dataset.id)), ...current.datasets],
      versions: [...bundled.versions.filter(version => !existingVersions.has(version.id)), ...versions],
      activeVersionId: !current.activeVersionId || current.activeVersionId === RETIRED_BUNDLED_QUICK_MODEL_ID
        ? bundled.activeVersionId : current.activeVersionId,
      initialVersionId: !current.initialVersionId || current.initialVersionId === RETIRED_BUNDLED_QUICK_MODEL_ID
        ? bundled.initialVersionId : current.initialVersionId,
    });
  }
  if (current.activeVersionId) return current;
  const existingDatasets = new Set(current.datasets.map(dataset => dataset.id));
  const existingVersions = new Set(current.versions.map(version => version.id));
  return validateQuickState({
    ...current,
    datasets: [...bundled.datasets.filter(dataset => !existingDatasets.has(dataset.id)), ...current.datasets],
    versions: [...bundled.versions.filter(version => !existingVersions.has(version.id)), ...current.versions],
    activeVersionId: bundled.activeVersionId,
    initialVersionId: current.initialVersionId || bundled.initialVersionId,
  });
}

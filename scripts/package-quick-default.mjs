// Rebuild the public first-run archive from an exported Quick Experience package.
// Only usable gesture features are retained; profile names and source IDs are replaced.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  QUICK_FORMAT, QUICK_LABELS, validateQuickState,
} from '../src/quick-model.js';

const input = process.argv[2];
if (!input) throw new Error('用法：node scripts/package-quick-default.mjs <导出的快捷模型包.json>');

const exported = validateQuickState(JSON.parse(await readFile(resolve(input), 'utf8')));
const active = exported.versions.find(version => version.id === exported.activeVersionId);
if (!active || active.report?.status !== 'ok'
  || QUICK_LABELS.some(label => !active.model.some(sample => sample.label === label))) {
  throw new Error('导出包没有覆盖全部动作且带跨用户评估的启用模型');
}
const sourceIdsInExport = new Set(exported.datasets.map(dataset => dataset.id));
if (active.sourceUserIds.some(id => !sourceIdsInExport.has(id))) {
  throw new Error('启用模型含有已移出数据集的来源，请从现有来源重新构建并评估模型后再导出');
}
const sourceTemplates = new Set(exported.datasets.flatMap(dataset => dataset.samples.map(sample =>
  JSON.stringify([dataset.mappings[sample.label], sample.durationMs, sample.frames]))));
if (active.model.some(sample => !sourceTemplates.has(JSON.stringify([sample.label, sample.durationMs, sample.frames])))) {
  throw new Error('启用模型含有当前数据集中不存在的识别模板，请重新构建模型后再导出');
}

const sourceIds = new Map();
const anonymisedId = sourceId => {
  if (!sourceIds.has(sourceId)) sourceIds.set(sourceId, `builtin-source-${String(sourceIds.size + 1).padStart(2, '0')}`);
  return sourceIds.get(sourceId);
};
const datasets = exported.datasets.map((dataset, datasetIndex) => {
  const id = anonymisedId(dataset.id);
  const samples = dataset.samples.filter(sample => QUICK_LABELS.includes(dataset.mappings[sample.label]))
    .map((sample, index) => ({
      key: `sample-${String(index + 1).padStart(4, '0')}`,
      label: dataset.mappings[sample.label],
      sessionId: '',
      durationMs: sample.durationMs,
      frames: sample.frames,
    }));
  return {
    id, name: `内置来源 ${String(datasetIndex + 1).padStart(2, '0')}`,
    enabled: dataset.enabled, syncedAt: 0, sourceCount: samples.length,
    mappings: Object.fromEntries([...new Set(samples.map(sample => sample.label))].map(label => [label, label])),
    samples,
  };
});

const report = active.report;
const safeReport = {
  status: 'ok', userCount: report.userCount, total: report.total,
  balancedAccuracy: report.balancedAccuracy, falseNaturalRate: report.falseNaturalRate,
  unknownRate: report.unknownRate, p95Ms: report.p95Ms,
  byLabel: Object.fromEntries(QUICK_LABELS.map(label => [label, {
    total: report.byLabel?.[label]?.total ?? 0,
    success: report.byLabel?.[label]?.success ?? 0,
  }])),
};
const versionId = 'builtin-quick-model-v2';
const seed = validateQuickState({
  format: QUICK_FORMAT,
  datasets,
  versions: [{
    id: versionId, name: '内置快捷模型 v2', createdAt: Date.UTC(2026, 10, 11),
    settings: active.settings,
    model: active.model.map(({ label, frames, durationMs }) => ({ label, frames, durationMs })),
    report: safeReport,
    sourceUserIds: active.sourceUserIds.map(anonymisedId),
    sourceSampleCount: active.sourceSampleCount,
    counts: Object.fromEntries(QUICK_LABELS.map(label => [label, active.counts?.[label] ?? 0])),
  }],
  candidate: null,
  activeVersionId: versionId,
  initialVersionId: versionId,
});

const output = fileURLToPath(new URL('../data/quick-model-default.v1.json', import.meta.url));
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(seed)}\n`, 'utf8');
console.log(`已生成内置模型：${seed.datasets.length} 份去标识化来源，${seed.datasets.reduce((sum, item) => sum + item.samples.length, 0)} 个可用来源样本，${seed.versions[0].model.length} 个识别模板。`);

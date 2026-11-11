import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { QUICK_LABELS, RETIRED_BUNDLED_QUICK_MODEL_ID, emptyQuickState, installBundledQuickState } from '../src/quick-model.js';
import { loadBundledQuickState } from '../src/quick-model-store.js';

const assetUrl = new URL('../data/quick-model-default.v1.json', import.meta.url);
const asset = JSON.parse(await readFile(fileURLToPath(assetUrl), 'utf8'));
const fetchFile = async (url, options) => {
  assert.equal(url.href, assetUrl.href);
  assert.equal(options.cache, 'no-store');
  return { ok: true, json: async () => asset };
};

test('clean browser installs a usable, de-identified default without personal samples', async () => {
  const bundled = await loadBundledQuickState(fetchFile);
  const installed = installBundledQuickState(emptyQuickState(), bundled);
  const active = installed.versions.find(version => version.id === installed.activeVersionId);
  assert.equal(installed.initialVersionId, active.id);
  assert.equal(installed.datasets.length, 14);
  assert.deepEqual(new Set(active.model.map(sample => sample.label)), new Set(QUICK_LABELS));
  assert(installed.datasets.every(dataset => /^builtin-source-\d+$/.test(dataset.id)
    && /^内置来源 \d+$/.test(dataset.name)
    && dataset.samples.every(sample => sample.sessionId === '' && /^sample-\d+$/.test(sample.key))));
});

test('existing active model is preserved on startup', async () => {
  const bundled = await loadBundledQuickState(fetchFile);
  const custom = { ...bundled.versions[0], id: 'personal-model', name: 'Personal' };
  const current = { ...emptyQuickState(), versions: [custom],
    activeVersionId: custom.id, initialVersionId: custom.id };
  const installed = installBundledQuickState(current, bundled);
  assert.equal(installed.activeVersionId, custom.id);
  assert.equal(installed.versions.length, 1);
  assert.equal(installed.datasets.length, 0);
});

test('old bundled model is replaced without changing a personal active model', async () => {
  const bundled = await loadBundledQuickState(fetchFile);
  const retired = { ...bundled.versions[0], id: RETIRED_BUNDLED_QUICK_MODEL_ID,
    sourceUserIds: [...bundled.datasets.map(dataset => dataset.id), 'builtin-source-15'] };
  const custom = { ...bundled.versions[0], id: 'personal-model', name: 'Personal' };
  const current = { ...emptyQuickState(), datasets: bundled.datasets,
    versions: [retired, custom], activeVersionId: custom.id,
    initialVersionId: retired.id };
  const installed = installBundledQuickState(current, bundled);
  assert.equal(installed.activeVersionId, custom.id);
  assert.equal(installed.initialVersionId, bundled.initialVersionId);
  assert(!installed.versions.some(version => version.id === retired.id));
  assert(installed.versions.some(version => version.id === custom.id));
  const retiredActive = installBundledQuickState({ ...current, activeVersionId: retired.id }, bundled);
  assert.equal(retiredActive.activeVersionId, bundled.activeVersionId);
});

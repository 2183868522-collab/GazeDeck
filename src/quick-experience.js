import { computeBaseline, normalise, adaptBaseline } from './baseline.js';
import { BLENDSHAPE_CHANNELS } from './features.js';
import { GestureClassifier, REST_LABEL, UNKNOWN_LABEL } from './classifier.js';
import { Segmenter, DEFAULT_SEGMENTER_SETTINGS } from './segmenter.js';
import { QUICK_LABELS, RETIRED_BUNDLED_QUICK_MODEL_ID, installBundledQuickState, syncProfileDatasets } from './quick-model.js';
import { loadQuickState, loadBundledQuickState, saveQuickState, exportQuickPackage, readQuickPackage } from './quick-model-store.js';

const html = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));
const percent = value => Number.isFinite(value) ? `${Math.round(value * 100)}%` : '—';
const newId = () => globalThis.crypto?.randomUUID?.() ?? `q-${Date.now()}-${Math.random().toString(36).slice(2)}`;

function buildInWorker(datasets) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./quick-model-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = event => {
      worker.terminate();
      if (event.data.error) reject(new Error(event.data.error));
      else resolve(event.data.candidate);
    };
    worker.onerror = event => { worker.terminate(); reject(new Error(event.message || '模型计算失败')); };
    worker.postMessage({ datasets });
  });
}

function reportHtml(report) {
  if (!report || report.status !== 'ok') return `<p class="muted">${report?.status === 'insufficient-training'
    ? '跨用户评估待完成：留出某位用户后，其他用户的可用训练样本不足。'
    : '跨用户评估待完成：至少需要两个有可用样本的用户。'}当前模型可试用，普适性尚未得到验证。</p>`;
  const rows = QUICK_LABELS.filter(label => report.byLabel?.[label]?.total).map(label => {
    const row = report.byLabel[label];
    return `<tr><td>${html(label)}</td><td>${html(row.success)} / ${html(row.total)}</td><td>${percent(row.success / row.total)}</td></tr>`;
  }).join('');
  return `<div class="quick-metrics"><span>跨用户平衡成功率 <b>${percent(report.balancedAccuracy)}</b></span>
    <span>自然动作误触率 <b>${percent(report.falseNaturalRate)}</b></span>
    <span>未知率 <b>${percent(report.unknownRate)}</b></span>
    <span>离线识别耗时 P95 <b>${Math.round(report.p95Ms)} ms</b></span></div>
    <p class="muted">按完整用户留出评估 · ${html(report.userCount)} 位用户 · ${html(report.total)} 个样本。属于已录片段的离线估计，仍需新受试者连续使用验证。</p>
    <table class="quick-report"><thead><tr><th>动作</th><th>成功 / 总数</th><th>成功率</th></tr></thead><tbody>${rows}</tbody></table>`;
}

export class QuickExperience {
  constructor(root, { profiles, onStatus, onEnterAdvanced, stage, cameraRow }) {
    this.root = root;
    this.profiles = profiles;
    this.onStatus = onStatus;
    this.onEnterAdvanced = onEnterAdvanced;
    this.stage = stage;
    this.cameraRow = cameraRow;
    this.stageHome = { parent: stage.parentNode, next: stage.nextSibling };
    this.cameraHome = { parent: cameraRow.parentNode, next: cameraRow.nextSibling };
    this.state = null;
    this.sourceProfiles = [];
    this.backend = 'memory';
    this.classifier = null;
    this.baseline = null;
    this.baselineFrames = [];
    this.lastBaselineFrameT = null;
    this.noFaceSince = null;
    this.segmenter = new Segmenter(DEFAULT_SEGMENTER_SETTINGS);
    this.active = false;
    this.building = false;
    this.operationQueue = Promise.resolve();
    this.selectedVersionId = '';
    this.lastPrediction = null;
    this.message = '';
    this.hookEvents();
  }

  q(id) { return this.root.querySelector(`#${id}`); }
  activeVersion() { return this.state?.versions.find(version => version.id === this.state.activeVersionId) ?? null; }
  labels() { return this.classifier?.labels() ?? []; }
  cameraReady() {
    const video = this.stage.querySelector('video');
    return !!video?.srcObject?.getVideoTracks?.().some(track => track.readyState === 'live' && !track.muted)
      || !!video?.src && !video.paused && video.readyState >= 2;
  }
  ready() { return !!this.classifier && !!this.baseline && this.cameraReady(); }
  modelName() { return this.activeVersion()?.name || '无快捷模型'; }

  async init() {
    this.sourceProfiles = this.profiles();
    const loaded = await loadQuickState();
    this.state = loaded.state;
    this.backend = loaded.backend;
    if (loaded.warning) this.message = `模型存储提示：${loaded.warning}`;
    this.activateClassifier();
    this.render();
    // Install the bundled model on first use and retire the previous built-in
    // model in existing browsers without replacing a custom active version.
    const hadActiveVersion = !!this.activeVersion();
    if (!hadActiveVersion || this.state.versions.some(version => version.id === RETIRED_BUNDLED_QUICK_MODEL_ID)) {
      try {
        const previousActiveId = this.state.activeVersionId;
        this.state = installBundledQuickState(this.state, await loadBundledQuickState());
        this.activateClassifier();
        this.render();
        try {
          await this.save();
          this.setMessage(previousActiveId === RETIRED_BUNDLED_QUICK_MODEL_ID
            ? '已更新内置快捷模型并移除旧来源；可启动摄像头体验识别'
            : '已加载项目内置快捷模型；可启动摄像头直接体验识别');
        } catch (error) {
          this.setMessage(`内置模型本次可用，但浏览器未保存它：${error.message}`, 'warn');
        }
      } catch (bundledError) {
        if (hadActiveVersion) {
          this.setMessage(`旧内置模型更新失败：${bundledError.message}`, 'warn');
          return;
        }
        const profiles = this.sourceProfiles;
        if (profiles.length) {
          try {
            syncProfileDatasets(this.state, profiles);
            await this.save();
            await this.buildCandidate({ activateFirst: true });
          } catch (error) { this.setMessage(`内置模型不可用：${bundledError.message}；本地样本也无法建立模型：${error.message}`, 'warn'); }
        } else this.setMessage(`内置模型不可用：${bundledError.message}`, 'warn');
      }
    }
  }

  async save() { await saveQuickState(this.state, this.backend); }

  mutate(update) {
    const pending = this.operationQueue.then(async () => {
      const previous = structuredClone(this.state);
      try {
        update(this.state);
        await this.save();
        this.activateClassifier();
        this.render();
      } catch (error) {
        this.state = previous;
        this.activateClassifier();
        this.render();
        this.setMessage(`保存失败：${error.message}`, 'err');
        throw error;
      }
    });
    this.operationQueue = pending.catch(() => {});
    return pending;
  }

  setMessage(message, level = '') {
    this.message = message;
    this.q('quickMessage').textContent = message;
    this.q('quickMessage').className = `quick-message ${level}`;
    this.onStatus?.(message, level);
  }

  activateClassifier() {
    const version = this.activeVersion();
    this.classifier = null;
    if (!version) return;
    const classifier = new GestureClassifier(version.settings);
    classifier.fit(version.model);
    this.classifier = classifier;
    this.segmenter.reset();
    this.lastPrediction = null;
  }

  resetBaseline() {
    this.baseline = null;
    this.baselineFrames = [];
    this.lastBaselineFrameT = null;
    this.noFaceSince = null;
    this.segmenter.reset();
    this.updateReadiness();
  }

  setActive(active) {
    if (this.active === active) return;
    this.active = active;
    if (active) {
      this.resetBaseline(); // a different person may have sat down while this page was hidden
      this.sourceProfiles = this.profiles();
      this.q('quickCameraSlot').appendChild(this.stage);
      this.q('quickCameraControls').appendChild(this.cameraRow);
      document.body.classList.add('quick-workspace');
    } else {
      this.stageHome.parent.insertBefore(this.stage, this.stageHome.next);
      this.cameraHome.parent.insertBefore(this.cameraRow, this.cameraHome.next);
      document.body.classList.remove('quick-workspace');
      this.segmenter.reset();
    }
    if (active) this.render();
    this.updateReadiness();
  }

  processFrame(raw, t, { showResult = false } = {}) {
    if (!raw) {
      if (this.noFaceSince == null) this.noFaceSince = t;
      if (this.baseline && t - this.noFaceSince > 3000) this.resetBaseline();
      this.segmenter.reset();
      if (showResult) this.q('quickCameraStatus').textContent = '等待检测到人脸';
      return null;
    }
    this.noFaceSince = null;
    if (!this.classifier) return null;
    if (!this.baseline) {
      if (this.lastBaselineFrameT != null && t - this.lastBaselineFrameT > 600) this.baselineFrames = [];
      this.lastBaselineFrameT = t;
      this.baselineFrames.push(Float32Array.from(raw));
      if (this.baselineFrames.length >= 60) {
        this.baseline = { ...computeBaseline(this.baselineFrames, BLENDSHAPE_CHANNELS.length), id: 'quick-session' };
        this.baselineFrames = [];
        this.segmenter.reset();
        this.updateReadiness();
      } else if (showResult) {
        this.q('quickCameraStatus').textContent = `自动建立静息基线 ${Math.round(this.baselineFrames.length / 60 * 100)}% · 请自然看向屏幕`;
      }
      return null;
    }
    if (showResult) this.q('quickCameraStatus').textContent = '摄像头已就绪 · 正在识别眼动动作';
    const normalized = normalise(raw, this.baseline);
    if (!this.segmenter.isActive) adaptBaseline(this.baseline, raw, 0.001);
    const segment = this.segmenter.push({ raw, normalized, timestampMs: t });
    if (!segment) return null;
    const prediction = this.classifier.predict(segment.frames, segment.durationMs);
    if (showResult) this.showPrediction(prediction);
    return prediction;
  }

  showPrediction(prediction) {
    this.lastPrediction = prediction;
    const label = prediction.label === UNKNOWN_LABEL && prediction.guess
      ? `未知（最像 ${prediction.guess}）` : prediction.label;
    this.q('quickPrediction').textContent = label;
    this.q('quickPrediction').dataset.state = prediction.label === UNKNOWN_LABEL ? 'unknown'
      : prediction.label === REST_LABEL ? 'rest' : 'recognized';
    this.q('quickPredictionDetail').textContent = `${Math.round(prediction.distance * 100) / 100} · ${this.modelName()}`;
    this.root.querySelectorAll('[data-quick-gesture]').forEach(card =>
      card.classList.toggle('detected', card.dataset.quickGesture === prediction.label));
  }

  updateReadiness() {
    if (!this.state) return;
    const model = this.activeVersion();
    this.q('quickModelName').textContent = model?.name || '尚无快捷模型';
    const status = this.q('quickCameraStatus');
    if (!model) status.textContent = '请在下方模型管理中同步样本并构建模型';
    else if (!this.cameraReady() || !this.baseline) status.textContent = '启动摄像头后，将自动采集短暂静息基线';
    const needed = QUICK_LABELS.filter(label => label !== REST_LABEL && !this.labels().includes(label));
    const enter = this.q('quickEnterAdvanced');
    enter.disabled = !this.ready() || needed.length > 0;
    this.q('quickAdvancedHint').textContent = needed.length
      ? `进入进阶控制还缺少：${needed.join('、')}。当前仍可体验已有动作。`
      : '可沿用快捷模型进入进阶控制；真实控制仍需连接 SoundCraft，连续滑块需另行校准。';
  }

  async buildCandidate({ activateFirst = false } = {}) {
    if (this.building) return;
    this.building = true;
    this.render();
    this.setMessage('正在计算候选模型与跨用户评估…');
    try {
      await this.operationQueue;
      const candidate = await buildInWorker(structuredClone(this.state.datasets));
      await this.mutate(state => { state.candidate = candidate; });
      if (activateFirst && !this.activeVersion()) await this.publishCandidate();
      else this.setMessage('候选模型已生成；检查评估结果后可手动启用');
    } catch (error) { this.setMessage(`候选模型构建失败：${error.message}`, 'warn'); }
    finally { this.building = false; this.render(); }
  }

  async publishCandidate() {
    const candidate = this.state.candidate;
    if (!candidate) return;
    await this.mutate(state => {
      const version = { ...candidate, name: `快捷体验 v${state.versions.length + 1}${candidate.report?.status === 'ok' ? '' : '（待跨用户验证）'}` };
      state.versions.push(version);
      state.activeVersionId = version.id;
      state.initialVersionId ??= version.id;
      state.candidate = null;
    });
    this.setMessage(`${this.modelName()} 已启用`);
  }

  render() {
    if (!this.state) return;
    const active = this.activeVersion();
    this.q('quickModelName').textContent = active?.name || '尚无快捷模型';
    this.q('quickModelMeta').textContent = active
      ? `${active.sourceUserIds?.length || 0} 位来源用户 · ${active.sourceSampleCount || 0} 个样本 · ${active.model.length} 个实时模板`
      : '快捷模型与个人档案分开保存';
    this.q('quickGestureGrid').innerHTML = QUICK_LABELS.map(label => {
      const count = active?.counts?.[label] || 0;
      return `<div class="quick-gesture-card" data-quick-gesture="${html(label)}"><strong>${html(label)}</strong><span>${count ? `${count} 个来源样本` : '暂无样本'}</span></div>`;
    }).join('');
    this.q('quickActiveReport').classList.toggle('hidden', !active);
    this.q('quickActiveReport').innerHTML = active ? `<h3>当前模型的跨用户评估</h3>${reportHtml(active.report)}` : '';
    const candidateReport = this.state.candidate?.report;
    const comparison = active?.report?.status === 'ok' && candidateReport?.status === 'ok'
      ? `<p><b>与当前版历史评估对照（来源样本可能不同）：</b>平衡成功率 ${percent(active.report.balancedAccuracy)} → ${percent(candidateReport.balancedAccuracy)}；
          自然动作误触率 ${percent(active.report.falseNaturalRate)} → ${percent(candidateReport.falseNaturalRate)}。</p>` : '';
    this.q('quickCandidateReport').innerHTML = this.state.candidate
      ? `<h4>候选版本 · ${html(this.state.candidate.sourceSampleCount)} 个来源样本</h4>${comparison}${reportHtml(candidateReport)}`
      : '<p class="muted">当前没有待启用的候选版本。</p>';
    this.q('quickPublish').disabled = !this.state.candidate || this.building;
    this.q('quickBuild').disabled = this.building;
    this.q('quickSyncAll').disabled = this.building || !this.sourceProfiles.length;
    this.q('quickSyncSelected').disabled = this.building || !this.sourceProfiles.length;
    this.q('quickImport').disabled = this.building;
    this.q('quickExport').disabled = false;
    this.q('quickBuild').textContent = this.building ? '正在构建…' : '生成并评估候选模型';
    const profiles = this.sourceProfiles;
    this.q('quickSourceUser').innerHTML = profiles.map(profile =>
      `<option value="${html(profile.id)}">${html(profile.name)}（${profile.samples.length} 个样本）</option>`).join('');
    this.q('quickSourceList').innerHTML = this.state.datasets.length ? this.state.datasets.map((dataset, index) => {
      const counts = Object.fromEntries([...new Set(dataset.samples.map(sample => sample.label))].map(label =>
        [label, dataset.samples.filter(sample => sample.label === label).length]));
      const mappings = Object.entries(counts).map(([label, count]) =>
        `<label class="quick-map-row"><span>${html(label)} · ${count} 个</span><select data-quick-map="${index}" data-label="${encodeURIComponent(label)}" ${this.building ? 'disabled' : ''}>
        <option value="">不纳入</option>${QUICK_LABELS.map(target => `<option value="${html(target)}" ${dataset.mappings[label] === target ? 'selected' : ''}>${html(target)}</option>`).join('')}</select></label>`).join('');
      return `<div class="quick-source-card"><div class="quick-source-head"><label><input type="checkbox" data-quick-enabled="${index}" ${dataset.enabled ? 'checked' : ''} ${this.building ? 'disabled' : ''}> ${html(dataset.name)}</label>
        <span>${dataset.samples.length} / ${dataset.sourceCount} 个可用样本</span><button type="button" class="danger" data-quick-remove="${index}" ${this.building ? 'disabled' : ''}>移除数据集</button></div>
        <details><summary>查看动作映射</summary><div class="quick-map-grid">${mappings || '没有兼容的样本'}</div></details></div>`;
    }).join('') : '<p class="muted">尚无来源数据集。请同步已有用户样本。</p>';
    this.q('quickVersionSelect').innerHTML = this.state.versions.map(version =>
      `<option value="${html(version.id)}">${html(version.name)} · ${new Date(version.createdAt).toLocaleDateString()}</option>`).join('');
    if (this.selectedVersionId && this.state.versions.some(version => version.id === this.selectedVersionId))
      this.q('quickVersionSelect').value = this.selectedVersionId;
    else this.q('quickVersionSelect').value = this.state.activeVersionId || '';
    this.selectedVersionId = this.q('quickVersionSelect').value;
    this.q('quickRestoreInitial').disabled = !this.state.initialVersionId || this.state.initialVersionId === this.state.activeVersionId;
    this.q('quickRestorePrevious').disabled = this.state.versions.findIndex(version => version.id === this.state.activeVersionId) < 1;
    this.q('quickRestoreSelected').disabled = !this.selectedVersionId || this.selectedVersionId === this.state.activeVersionId;
    this.q('quickRemoveVersion').disabled = !this.selectedVersionId || this.selectedVersionId === this.state.activeVersionId
      || this.selectedVersionId === this.state.initialVersionId;
    this.q('quickStorageInfo').textContent = this.backend === 'indexedDB' ? '模型档案保存在此浏览器的扩展存储中'
      : this.backend === 'localStorage' ? '当前使用浏览器备用存储；建议导出模型包备份'
        : '浏览器存储不可用；模型修改无法保存';
    this.updateReadiness();
  }

  hookEvents() {
    this.q('quickSyncAll').onclick = async () => {
      try {
        const profiles = this.sourceProfiles = this.profiles();
        const result = { added: 0, updated: 0 };
        await this.mutate(state => { Object.assign(result, syncProfileDatasets(state, profiles)); state.candidate = null; });
        this.setMessage(`已同步 ${result.added} 个新用户、更新 ${result.updated} 个用户；请生成候选模型`);
      } catch { /* mutate reported the storage error */ }
    };
    this.q('quickSyncSelected').onclick = async () => {
      const id = this.q('quickSourceUser').value;
      if (!id) return;
      try {
        this.sourceProfiles = this.profiles();
        await this.mutate(state => { syncProfileDatasets(state, this.sourceProfiles, [id]); state.candidate = null; });
        this.setMessage('已纳入所选用户的最新样本；请生成候选模型');
      } catch { /* mutate reported the storage error */ }
    };
    this.q('quickBuild').onclick = () => this.buildCandidate();
    this.q('quickPublish').onclick = () => this.publishCandidate().catch(error => this.setMessage(`启用失败：${error.message}`, 'err'));
    this.q('quickEnterAdvanced').onclick = () => {
      if (this.ready() && QUICK_LABELS.every(label => this.labels().includes(label))) this.onEnterAdvanced?.();
    };
    this.q('quickVersionSelect').onchange = event => { this.selectedVersionId = event.target.value; this.render(); };
    this.q('quickRestoreSelected').onclick = async () => {
      const id = this.selectedVersionId;
      if (!this.state.versions.some(version => version.id === id)) return;
      try {
        await this.mutate(state => { state.activeVersionId = id; });
        this.setMessage(`已恢复 ${this.modelName()}`);
      } catch { /* mutate reported the storage error */ }
    };
    this.q('quickRestoreInitial').onclick = async () => {
      if (!this.state.initialVersionId) return;
      try {
        await this.mutate(state => { state.activeVersionId = state.initialVersionId; });
        this.setMessage('已恢复初始快捷模型');
      } catch { /* mutate reported the storage error */ }
    };
    this.q('quickRestorePrevious').onclick = async () => {
      const index = this.state.versions.findIndex(version => version.id === this.state.activeVersionId);
      if (index < 1) return;
      const id = this.state.versions[index - 1].id;
      try {
        await this.mutate(state => { state.activeVersionId = id; });
        this.setMessage(`已恢复 ${this.modelName()}`);
      } catch { /* mutate reported the storage error */ }
    };
    this.q('quickRemoveVersion').onclick = async () => {
      const id = this.selectedVersionId;
      if (!id || id === this.state.activeVersionId || id === this.state.initialVersionId) return;
      if (!confirm('确定删除所选旧版本吗？当前启用版本和初始版本不会删除。')) return;
      try {
        await this.mutate(state => { state.versions = state.versions.filter(version => version.id !== id); });
        this.setMessage('所选旧版本已删除');
      } catch { /* mutate reported the storage error */ }
    };
    this.q('quickExport').onclick = () => exportQuickPackage(this.state);
    this.q('quickImport').onchange = async event => {
      const file = event.target.files[0];
      if (!file) return;
      try {
        const incoming = await readQuickPackage(file);
        await this.mutate(state => {
          for (const dataset of incoming.datasets) {
            const old = state.datasets.find(item => item.id === dataset.id);
            if (!old) { state.datasets.push(dataset); continue; }
            const samples = new Map(old.samples.map(sample => [sample.key, sample]));
            for (const sample of dataset.samples) samples.set(sample.key, sample);
            old.samples = [...samples.values()];
            old.sourceCount = Math.max(old.sourceCount, dataset.sourceCount);
            old.mappings = { ...dataset.mappings, ...old.mappings };
          }
          const importedActive = incoming.versions.find(version => version.id === incoming.activeVersionId)
            || incoming.candidate;
          if (importedActive) state.candidate = { ...importedActive, id: newId(), name: '导入的候选模型' };
        });
        this.setMessage('模型包已导入；原启用版本保持不变，导入的版本可作为候选启用');
      } catch (error) { this.setMessage(`导入失败：${error.message}`, 'err'); }
      event.target.value = '';
    };
    this.q('quickSourceList').onchange = async event => {
      const target = event.target;
      const index = Number(target.dataset.quickEnabled ?? target.dataset.quickMap);
      if (!Number.isInteger(index) || !this.state.datasets[index]) return;
      try {
        if (target.matches('[data-quick-enabled]')) {
          await this.mutate(state => { state.datasets[index].enabled = target.checked; state.candidate = null; });
        } else if (target.matches('[data-quick-map]')) {
          const label = decodeURIComponent(target.dataset.label);
          await this.mutate(state => { state.datasets[index].mappings[label] = target.value; state.candidate = null; });
        }
        this.setMessage('来源数据已修改；当前启用模型未变，请重新生成候选模型');
      } catch { /* mutate reported the storage error */ }
    };
    this.q('quickSourceList').onclick = async event => {
      const button = event.target.closest('[data-quick-remove]');
      if (!button) return;
      const index = Number(button.dataset.quickRemove);
      const dataset = this.state.datasets[index];
      if (!dataset || !confirm(`确定移除“${dataset.name}”的快捷模型来源数据吗？当前已启用的模型版本不会改变。`)) return;
      try {
        await this.mutate(state => { state.datasets.splice(index, 1); state.candidate = null; });
        this.setMessage('来源数据集已移除；当前启用模型未变');
      } catch { /* mutate reported the storage error */ }
    };
  }
}

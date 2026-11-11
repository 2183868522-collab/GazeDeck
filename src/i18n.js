import { automaticExact, automaticRuns } from './i18n-catalog.js';
import { curatedExact, curatedRuns } from './i18n-curated.js';

const KEY = 'eye-gesture-control/interface-language/v1';
const HAN = /[\u3400-\u9fff]/;
const HAN_RUN = /[\u3400-\u9fff]+/g;
const ATTRIBUTES = ['title', 'aria-label', 'aria-description', 'placeholder', 'alt'];
const punctuation = {
  '，': ', ', '。': '. ', '：': ': ', '；': '; ', '、': ', ',
  '（': ' (', '）': ')', '「': '“', '」': '”', '“': '“', '”': '”',
  '！': '! ', '？': '? ', '／': '/', '～': '~', '　': ' ',
};
const textState = new WeakMap();
const attributeState = new WeakMap();
const originalTitle = document.title;
let language = readLanguage();
const runPrefixes = new Map();
for (const key of new Set([...Object.keys(automaticRuns), ...Object.keys(curatedRuns)])) {
  const matches = runPrefixes.get(key[0]) ?? [];
  matches.push(key);
  runPrefixes.set(key[0], matches);
}
for (const matches of runPrefixes.values()) matches.sort((a, b) => b.length - a.length);

function readLanguage() {
  try { return localStorage.getItem(KEY) === 'en' ? 'en' : 'zh-CN'; }
  catch { return 'zh-CN'; }
}

function polish(source, value) {
  if (/^已导入\s+\d+\s*\/\s*\d+\s*首/.test(source)) value = value.replace(/Imported (\d+) \/ (\d+) track\./, 'Imported $1 of $2 tracks.');
  if (source.includes('曲库')) value = value.replace(/\b(curves?|curvature|curved)\b/gi, 'track library');
  if (source.includes('工程')) value = value.replace(/\bengineering\b/gi, 'project');
  if (source.includes('音轨') || source.includes('轨道')) value = value.replace(/\borbitals?\b/gi, 'track').replace(/\borbits\b/gi, 'tracks').replace(/\borbit\b/gi, 'track');
  if (source.includes('弹窗')) value = value.replace(/\bbullet windows\b/gi, 'popups').replace(/\bbullet window\b/gi, 'popup');
  if (source.includes('调节')) value = value.replace(/\breconciliation\b/gi, 'adjustment');
  if (source.includes('眼动')) value = value.replace(/\beyebrow\b/gi, 'eye gesture');
  if (source.includes('进阶控制')) value = value.replace(/\bprogress control\b/gi, 'Advanced Control');
  if (source.includes('人脸')) value = value.replace(/\bhuman face\b/gi, 'face');
  if (source.includes('静息校准')) value = value.replace(/\bquiet calibration\b/gi, 'rest calibration');
  return value;
}

function translateRun(run) {
  const direct = curatedRuns[run] ?? automaticRuns[run];
  if (direct !== undefined) return direct;
  const memo = new Map();
  const split = index => {
    if (index === run.length) return [];
    if (memo.has(index)) return memo.get(index);
    for (const key of runPrefixes.get(run[index]) ?? []) {
      if (!run.startsWith(key, index)) continue;
      const rest = split(index + key.length);
      if (rest) {
        const parts = [curatedRuns[key] ?? automaticRuns[key], ...rest];
        memo.set(index, parts);
        return parts;
      }
    }
    memo.set(index, null);
    return null;
  };
  return split(0)?.filter(Boolean).join(' ') ?? run;
}

function translate(source) {
  if (language !== 'en' || !HAN.test(source)) return source;
  const leading = source.match(/^\s*/)[0];
  const trailing = source.match(/\s*$/)[0];
  const core = source.slice(leading.length, source.length - trailing.length);
  const direct = curatedExact[core] ?? curatedRuns[core] ?? automaticExact[core];
  if (direct !== undefined) return leading + polish(core, direct) + trailing;
  const translated = source.replace(HAN_RUN, translateRun)
    .replace(/[，。：；、（）「」“”！？／～　]/g, mark => punctuation[mark] ?? mark);
  return polish(source, translated);
}

function skipped(element) {
  return !!element?.closest?.('[data-i18n-skip], script, style, noscript, textarea, [contenteditable]');
}

function translateTextNode(node) {
  if (skipped(node.parentElement)) return;
  const current = node.nodeValue;
  let state = textState.get(node);
  if (!state || current !== state.rendered) {
    state = { source: current, rendered: current };
    textState.set(node, state);
  }
  const rendered = translate(state.source);
  if (current !== rendered) node.nodeValue = rendered;
  state.rendered = rendered;
}

function translateAttributes(element) {
  if (skipped(element)) return;
  let states = attributeState.get(element);
  if (!states) { states = new Map(); attributeState.set(element, states); }
  for (const name of ATTRIBUTES) {
    if (!element.hasAttribute(name)) continue;
    const current = element.getAttribute(name);
    let state = states.get(name);
    if (!state || current !== state.rendered) {
      state = { source: current, rendered: current };
      states.set(name, state);
    }
    const rendered = translate(state.source);
    if (current !== rendered) element.setAttribute(name, rendered);
    state.rendered = rendered;
  }
}

function translateTree(root) {
  if (root.nodeType === Node.TEXT_NODE) { translateTextNode(root); return; }
  if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
  if (root.nodeType === Node.ELEMENT_NODE) {
    if (skipped(root)) return;
    translateAttributes(root);
  }
  for (const child of root.childNodes) translateTree(child);
}

function syncSelectors() {
  for (const select of document.querySelectorAll('[data-language-select]')) select.value = language;
}

function applyLanguage() {
  document.documentElement.lang = language;
  document.body.classList.toggle('lang-en', language === 'en');
  document.title = translate(originalTitle);
  translateTree(document.body);
  syncSelectors();
}

function translateNativeDialogs() {
  for (const name of ['alert', 'confirm', 'prompt']) {
    const original = window[name].bind(window);
    window[name] = (message, ...rest) => original(translate(String(message ?? '')), ...rest);
  }
}

export function installLanguageSwitch() {
  translateNativeDialogs();
  const observer = new MutationObserver(records => {
    let added = false;
    for (const record of records) {
      if (record.type === 'characterData') translateTextNode(record.target);
      else if (record.type === 'attributes') translateAttributes(record.target);
      else for (const node of record.addedNodes) { translateTree(node); added = true; }
    }
    if (added) syncSelectors();
  });
  observer.observe(document.body, {
    subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: ATTRIBUTES,
  });
  document.addEventListener('change', event => {
    if (!event.target.matches?.('[data-language-select]')) return;
    language = event.target.value === 'en' ? 'en' : 'zh-CN';
    try { localStorage.setItem(KEY, language); } catch { /* private browsing */ }
    applyLanguage();
  });
  applyLanguage();
}

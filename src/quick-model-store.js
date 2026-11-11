import { emptyQuickState, validateQuickState } from './quick-model.js';

const DB_NAME = 'eye-gesture-control/quick-model';
const LOCAL_KEY = 'eye-gesture-control/quick-model/v1';
const BUNDLED_URL = new URL('../data/quick-model-default.v1.json', import.meta.url);
let dbPromise = null;

export async function loadBundledQuickState(fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(BUNDLED_URL, { cache: 'no-store' });
  if (!response.ok) throw new Error(`内置快捷模型读取失败（HTTP ${response.status}）`);
  return validateQuickState(await response.json());
}

function openDatabase() {
  if (!globalThis.indexedDB) return Promise.reject(new Error('IndexedDB 不可用'));
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('state');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('无法打开快捷模型档案'));
    request.onblocked = () => reject(new Error('快捷模型档案被其他页面占用'));
  });
  return dbPromise;
}

async function readDatabase() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('state', 'readonly');
    const request = tx.objectStore('state').get('main');
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error || new Error('快捷模型读取失败'));
  });
}

async function writeDatabase(state) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('state', 'readwrite');
    tx.objectStore('state').put(state, 'main');
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error || new Error('快捷模型保存失败'));
    tx.onabort = () => reject(tx.error || new Error('快捷模型保存事务已中止'));
  });
}

export async function loadQuickState() {
  try {
    const stored = await readDatabase();
    if (stored) return { state: validateQuickState(stored), backend: 'indexedDB' };
    let local = null;
    try { local = localStorage.getItem(LOCAL_KEY); } catch { /* IndexedDB still works */ }
    if (local) {
      try {
        const state = validateQuickState(JSON.parse(local));
        await writeDatabase(state);
        return { state, backend: 'indexedDB' };
      } catch (error) {
        return { state: emptyQuickState(), backend: 'indexedDB', warning: `备用模型档案无效：${error.message}` };
      }
    }
    return { state: emptyQuickState(), backend: 'indexedDB' };
  } catch (databaseError) {
    try {
      const stored = localStorage.getItem(LOCAL_KEY);
      return { state: stored ? validateQuickState(JSON.parse(stored)) : emptyQuickState(),
        backend: 'localStorage', warning: databaseError.message };
    } catch (storageError) {
      return { state: emptyQuickState(), backend: 'memory',
        warning: `${databaseError.message}；${storageError.message}` };
    }
  }
}

export async function saveQuickState(state, backend) {
  const snapshot = validateQuickState(state);
  if (backend === 'indexedDB') { await writeDatabase(snapshot); return; }
  if (backend === 'localStorage') {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(snapshot));
    return;
  }
  throw new Error('浏览器存储不可用，快捷模型修改无法保存');
}

export function exportQuickPackage(state) {
  const blob = new Blob([JSON.stringify(validateQuickState(state))], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `gazedeck-quick-model-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function readQuickPackage(file) {
  if (!file || file.size > 50 * 1024 * 1024) throw new Error('模型包超过 50 MiB，无法导入');
  return validateQuickState(JSON.parse(await file.text()));
}

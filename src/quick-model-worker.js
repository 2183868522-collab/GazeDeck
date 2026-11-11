import { buildQuickCandidate } from './quick-model.js';

self.onmessage = event => {
  try { self.postMessage({ candidate: buildQuickCandidate(event.data.datasets) }); }
  catch (error) { self.postMessage({ error: error?.message || String(error) }); }
};

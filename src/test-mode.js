import { REST_LABEL, UNKNOWN_LABEL } from './classifier.js';

function randomFor(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

export function buildTrials(labels, repeats, { includeRest = true, seed = Date.now() } = {}) {
  const selected = [...new Set(labels.filter(label => label && label !== REST_LABEL))];
  if (includeRest) selected.push(REST_LABEL);
  const trials = selected.flatMap(targetLabel => Array.from({ length: repeats }, (_, repeat) => ({
    id: `trial-${seed}-${targetLabel}-${repeat}`,
    targetLabel, repeat, reviewStatus: 'pending',
  })));
  const random = randomFor(seed);
  for (let i = trials.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [trials[i], trials[j]] = [trials[j], trials[i]];
  }
  return trials;
}

export function isSuccessfulPrediction(actualLabel, predictedLabel, { guess, countClosestGuess = false } = {}) {
  if (!actualLabel) return false;
  if (actualLabel === REST_LABEL) return predictedLabel === REST_LABEL || predictedLabel === UNKNOWN_LABEL;
  return predictedLabel === actualLabel
    || (countClosestGuess && predictedLabel === UNKNOWN_LABEL && guess === actualLabel);
}

export function summariseTrials(trials, predictionKey = 'predictedLabel', { countClosestGuess = false } = {}) {
  const valid = trials.filter(t => t.reviewStatus !== 'invalid' && t.actualLabel);
  const positiveTrials = valid.filter(t => t.actualLabel !== REST_LABEL);
  const negativeTrials = valid.filter(t => t.actualLabel === REST_LABEL);
  const guessKey = predictionKey === 'predictedLabel' ? 'predictedGuess' : `${predictionKey}Guess`;
  const succeeds = trial => isSuccessfulPrediction(trial.actualLabel, trial[predictionKey], {
    guess: trial[guessKey], countClosestGuess,
  });
  const positiveSuccess = positiveTrials.filter(succeeds).length;
  const negativeSuccess = negativeTrials.filter(succeeds).length;
  const rate = (n, d) => d ? n / d : null;
  const positiveRate = rate(positiveSuccess, positiveTrials.length);
  const negativeRate = rate(negativeSuccess, negativeTrials.length);
  const present = [positiveRate, negativeRate].filter(x => x !== null);
  const byLabel = {};
  for (const trial of valid) {
    const row = byLabel[trial.actualLabel] ??= { success: 0, total: 0, predictions: {} };
    row.total++;
    if (succeeds(trial)) row.success++;
    const predicted = trial[predictionKey]; row.predictions[predicted] = (row.predictions[predicted] || 0) + 1;
  }
  for (const row of Object.values(byLabel)) row.rate = rate(row.success, row.total);
  return {
    valid: valid.length, invalid: trials.length - valid.length,
    positive: { success: positiveSuccess, total: positiveTrials.length, rate: positiveRate },
    negative: { success: negativeSuccess, total: negativeTrials.length, rate: negativeRate },
    balancedAccuracy: present.length ? present.reduce((a, x) => a + x, 0) / present.length : null,
    unknown: valid.filter(t => t[predictionKey] === UNKNOWN_LABEL).length,
    byLabel,
  };
}

export function shouldPromoteCandidate(before, after) {
  if (before.balancedAccuracy === null || after.balancedAccuracy === null) return false;
  const beforeNegative = before.negative.rate ?? 0;
  const afterNegative = after.negative.rate ?? 0;
  return after.balancedAccuracy > before.balancedAccuracy && afterNegative >= beforeNegative;
}

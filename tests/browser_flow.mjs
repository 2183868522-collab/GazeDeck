// End-to-end UI flow test with synthetic eye-feature streams (no camera, no MediaPipe in the loop).
// Drives the real page (?test=1) through: rest calibration → recording every gesture via the on-screen
// prompts → session-safe evaluation guard → communication board (move, select, pause/unpause) → music.
// What it proves: the app's wiring and timing logic. What it cannot prove: that real faces produce
// separable features — that needs a person in front of a camera.
//
// Usage (server must be running: ./start.sh):  node tests/browser_flow.mjs
import { launch, reporter, sleep, APP_URL } from './cdp.mjs';

const { check, finish } = reporter();
const b = await launch({ port: 9334 });
const state = () => b.evaluate('window.__eyeTest.state()');

// Runs inside the page: a 30 fps feeder that plays queued gesture frames, otherwise resting-face frames,
// and "performs" the requested gesture whenever the recording prompt says 现在：X.
const FEEDER = `(async () => {
  const syn = await import('/tests/synthetic.js');
  const rng = syn.mulberry32(7);
  window.__q = [];
  setInterval(() => {
    const f = window.__q.shift();
    window.__eyeTest.feed(f ? f.frame : syn.restStream(rng, 34)[0].frame, performance.now());
  }, 33);
  window.__do = label => {
    for (const s of syn.makeStream(syn.GESTURES[label](rng), rng, { restBeforeMs: 300, restAfterMs: 0 })) window.__q.push(s);
  };
  new MutationObserver(() => {
    const t = document.getElementById('prompt').textContent;
    const m = /^现在：(.+)$/.exec(t);
    if (m) window.__do(m[1]);
    if (t === '自然状态录制中…') for (let i = 0; i < 8; i++) {
      for (const s of syn.makeStream(syn.GESTURES['自然'](rng), rng, { restBeforeMs: 1500, restAfterMs: 0 })) window.__q.push(s);
    }
  }).observe(document.getElementById('prompt'), { childList: true, subtree: true, characterData: true });
  return true;
})()`;

async function perform(label, waitMs = 2000) { await b.evaluate(`window.__do(${JSON.stringify(label)})`); await sleep(waitMs); }

try {
  // Seed v0.1-format data (single profile key) and reload: it must become the first user, intact.
  await b.send('Page.navigate', { url: `${APP_URL}?test=1` });
  await b.waitFor(`!!window.__eyeTest`, 15000, 'test hook');
  await b.evaluate(`(async () => {
    const { defaultProfileV1ForTest } = await import('/src/profile.js');
    const { NUM_FEATURES } = await import('/src/features.js');
    localStorage.clear();
    const p = defaultProfileV1ForTest(); p.name = '旧档案';
    p.samples = [{ id: 'legacy', label: '自然', durationMs: 120, createdAt: 1, frames: [0, 1, 2].map(() => Array(NUM_FEATURES).fill(0)) }];
    localStorage.setItem('eye-gesture-control/profile/v1', JSON.stringify(p));
  })()`);
  await b.send('Page.reload');
  await sleep(500);
  await b.waitFor(`!!window.__eyeTest`, 15000, 'test hook after reload');
  const migrated = await state();
  check('v0.1 data migrated to first user', migrated.user === '旧档案' && migrated.samples === 1 && migrated.users === 1,
    `${migrated.user}, ${migrated.samples} sample(s), ${migrated.users} user(s)`);
  await b.evaluate(FEEDER);
  await b.evaluate(`window.__eyeTest.setSettings({ repeats: 3, recordWindowMs: 2000 })`);
  // MIN_OFF_MS=150 reproduces the v0.2.2 behaviour (double blink split in two) for before/after comparison.
  if (process.env.MIN_OFF_MS) {
    await b.evaluate(`window.__eyeTest.setSettings({ segmenter: { ...${JSON.stringify((await import('../src/segmenter.js')).DEFAULT_SEGMENTER_SETTINGS)}, minOffMs: ${Number(process.env.MIN_OFF_MS)} } })`);
  }

  await b.evaluate(`document.getElementById('calibrate').click()`);
  await b.waitFor(`document.getElementById('baselineInfo').textContent.startsWith('已校准')`, 15000, 'calibration');
  check('calibration via UI', true, await b.text('baselineInfo'));

  for (const label of ['自然', '长眨', '双眨', '左看', '右看']) {
    await b.evaluate(`document.getElementById('status').textContent = ''; document.querySelector('[data-rec="${label}"]').click()`);
    await b.waitFor(`document.getElementById('status').textContent.includes('录到')`, 60000, `recording ${label}`);
    const status = await b.text('status');
    const n = parseInt(/录到 (\d+)/.exec(status)[1], 10);
    check(`record「${label}」`, label === '自然' ? n >= 5 : n === 3, status);
  }
  const s = await state();
  check('classifier knows all recorded labels', s.labels.length === 5, s.labels.join(','));

  await b.evaluate(`document.querySelector('[data-tab="eval"]').click()`);
  await sleep(300);
  const evalText = await b.text('evalResult');
  check('one session is not reported as generalisation accuracy', evalText.includes('数据不足') && !evalText.includes('准确率'), evalText);

  // Communication board: 右看 = next, 长眨 = select, 双眨 = pause toggle (default mapping).
  await b.evaluate(`document.querySelector('[data-tab="board"]').click()`);
  await sleep(500);
  await perform('右看');
  check('board: 右看 moves highlight', (await state()).boardIndex === 1, `index=${(await state()).boardIndex}`);
  await perform('长眨');
  check('board: 长眨 selects phrase', (await state()).output === '我要翻身', `output=${(await state()).output}`);
  await perform('双眨');
  check('board: 双眨 pauses', (await state()).paused === true);
  await perform('右看');
  check('board: paused ignores 右看', (await state()).boardIndex === 1, `index=${(await state()).boardIndex}`);
  await perform('双眨');
  check('board: 双眨 resumes (self-unpause)', (await state()).paused === false);
  await perform('自然');
  check('board: spontaneous blink does nothing', (await state()).boardIndex === 1 && (await state()).output === '我要翻身');

  await b.evaluate(`document.querySelector('[data-tab="music"]').click()`);
  await sleep(500);
  const before = (await state()).chord;
  await perform('右看');
  const after = (await state()).chord;
  check('music: 右看 changes chord', before === 'C' && after === 'G', `${before} → ${after}`);
  await perform('长眨');
  check('music: 长眨 starts the loop', (await state()).playing === true);
  const accentsBefore = (await state()).accents;
  await perform('双眨');
  check('music: 双眨 plays an accent', (await state()).accents === accentsBefore + 1, `${accentsBefore} → ${(await state()).accents}`);
  await perform('长眨');
  check('music: 长眨 stops the loop', (await state()).playing === false);

  // Second person: new user starts empty and uncalibrated; switching back restores the first user's data.
  const firstSamples = (await state()).samples;
  await b.evaluate(`document.getElementById('newUser').click()`);
  await sleep(300);
  const second = await state();
  check('new user starts empty', second.users === 2 && second.samples === 0 && !second.calibrated, `${second.user}: ${second.samples} samples`);
  const firstId = await b.evaluate(`document.getElementById('userSelect').options[0].value`);
  await b.evaluate(`(() => { const s = document.getElementById('userSelect'); s.value = ${JSON.stringify(firstId)}; s.dispatchEvent(new Event('change')); })()`);
  await sleep(300);
  const back = await state();
  check('switch back restores first user', back.user === '旧档案' && back.samples === firstSamples && back.calibrated, `${back.user}: ${back.samples} samples`);
  await b.send('Page.reload');
  await b.waitFor(`!!window.__eyeTest`, 15000, 'test hook after reload');
  const reloaded = await state();
  check('active user survives reload', reloaded.user === '旧档案' && reloaded.samples === firstSamples && reloaded.users === 2);

  // Two-click destructive buttons (清空 / 删除): the second click must actually perform the action.
  await b.evaluate(`document.querySelector('[data-tab="train"]').click()`);
  const dblClick = async sel => {
    await b.evaluate(`document.querySelector(${JSON.stringify(sel)}).click()`);
    await sleep(200);
    await b.evaluate(`document.querySelector(${JSON.stringify(sel)}).click()`);
    await sleep(200);
  };
  await dblClick('[data-clear="左看"]');
  check('表格「清空」 removes that gesture\'s samples', !((await state()).counts['左看']), JSON.stringify((await state()).counts));
  await dblClick('[data-del="上看"]');
  check('表格「删除」 removes the gesture', !(await state()).gestures.includes('上看'), (await state()).gestures.join(','));
  const undoBefore = (await state()).counts['右看'];
  await b.evaluate(`document.querySelector('[data-undo="右看"]').click()`);
  await sleep(200);
  check('表格「撤销」 removes one sample', (await state()).counts['右看'] === undoBefore - 1, `${undoBefore} → ${(await state()).counts['右看']}`);
  await b.evaluate(`document.querySelector('[data-tab="settings"]').click()`);
  await dblClick('#resetProfile');
  check('设置「清空此用户」 empties samples and calibration', (await state()).samples === 0 && !(await state()).calibrated);
  const usersBefore = (await state()).users;
  await dblClick('#deleteUser');
  check('设置「删除此用户」 removes the user', (await state()).users === usersBefore - 1 && (await state()).user !== '旧档案', `${usersBefore} → ${(await state()).users}, now ${(await state()).user}`);

  const logLines = await b.evaluate(`[...document.querySelectorAll('#log li')].slice(0, 8).map(li => li.textContent)`);
  console.log('\nrecent log:\n  ' + logLines.join('\n  '));
} catch (e) {
  check('flow run', false, e.message);
} finally {
  check('no console errors / exceptions', b.problems.length === 0, b.problems.slice(0, 5).join(' ; '));
  b.close();
  process.exit(finish());
}

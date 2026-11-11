import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { captureLayoutForMode } from '../src/capture-workspace.js';

test('slider calibration and trial controls follow gesture recording, separate from personal calibration', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const app = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
  const personal = html.indexOf('id="calibrateGaze"');
  const samples = html.indexOf('id="gestureRows"');
  const add = html.indexOf('id="addGesture"');
  const slider = html.indexOf('id="sliderCalibrationCard"');
  assert.ok(personal < samples && samples < add && add < slider);
  for (const id of ['calibrateSlider', 'tryGazeSlider', 'gazeCalibrationInfo']) {
    assert.equal(html.split(`id="${id}"`).length - 1, 1);
    assert.ok(html.indexOf(`id="${id}"`) > slider);
  }
  assert.match(app, /\$\('calibrateSlider'\)\.onclick = \(\) => startGazeCalibration\('slider'\)/);
  assert.match(app, /\$\('calibrateGaze'\)\.onclick = \(\) => startGazeCalibration\('personal'\)/);
});

test('recording and guided testing share the capture workspace', () => {
  for (const mode of ['calibrating', 'recording', 'testing-countdown', 'testing-window', 'gaze-calibrating', 'gaze-slider']) {
    assert.deepEqual(captureLayoutForMode(mode), { active: true, review: false });
  }
  assert.deepEqual(captureLayoutForMode('testing-review'), { active: true, review: true });
  assert.deepEqual(captureLayoutForMode('idle'), { active: false, review: false });
});

test('capture workspace has a single fixed HUD and centred stage rules', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');
  const app = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
  assert.match(html, /id="captureHud"/);
  assert.match(html, /id="captureTitle"/);
  assert.match(html, /id="captureProgressText"/);
  assert.match(html, /id="calibrateGaze"/);
  assert.match(html, /请保持头部自然稳定，视线朝目标方向移动到可舒适保持的最远位置。/);
  assert.match(html, /id="personalCalibrationInfo"/);
  assert.match(html, /id="gazeSliderOverlay"/);
  assert.match(html, /id="gazeConfirmGesture"/);
  assert.match(css, /body\.capture-workspace \.stage/);
  assert.match(app, /classList\.toggle\('capture-gaze-calibrating', workflowMode === 'gaze-calibrating'\)/);
  assert.match(css, /body\.capture-gaze-calibrating \.stage \{[^}]*width:\s*100vw;[^}]*height:\s*100vh;[^}]*aspect-ratio:\s*auto/s);
  assert.match(css, /body\.capture-gaze-calibrating \.stage video,[\s\S]*?object-fit:\s*cover/);
  assert.match(css, /\.gaze-target-prompt\.gaze-left \{[^}]*padding-left:\s*8px/);
  assert.match(css, /\.gaze-target-prompt\.gaze-right \{[^}]*padding-right:\s*8px/);
  assert.match(css, /\.gaze-target-prompt\.gaze-up/);
  assert.match(css, /\.gaze-target-prompt\.gaze-down/);
  assert.match(app, /key: 'up', label: '上方'/);
  assert.match(app, /key: 'down', label: '下方'/);
  assert.match(css, /left:\s*50%/);
  assert.match(css, /top:\s*50%/);
  assert.match(css, /translate\(-50%,\s*-50%\)/);
  assert.match(css, /body\.capture-review #testReview/);
  assert.match(css, /\.gaze-slider-overlay/);
});

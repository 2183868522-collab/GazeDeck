// Browser smoke test: headless Chrome with a fake camera (a .y4m video of a face).
// Checks that the model loads, a face is found, frames flow, and rest calibration produces a baseline —
// with no console errors. A still image cannot test gesture recognition; see browser_flow.mjs for that.
//
// Usage (server must be running: ./start.sh):  node tests/browser_smoke.mjs /path/to/face.y4m
// Make a .y4m from any face photo:  ffmpeg -loop 1 -i face.jpg -t 12 -r 30 -vf scale=640:480 -pix_fmt yuv420p face.y4m
import { launch, reporter, sleep, APP_URL } from './cdp.mjs';

const Y4M = process.argv[2];
if (!Y4M) { console.error('usage: node tests/browser_smoke.mjs face.y4m'); process.exit(2); }

const { check, finish } = reporter();
const b = await launch({ extraArgs: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${Y4M}`] });
try {
  await b.send('Page.navigate', { url: APP_URL });
  await b.waitFor(`document.getElementById('status').textContent.includes('模型已就绪')`, 30000, 'model ready');
  check('model loads', true, await b.text('status'));

  await b.evaluate(`document.getElementById('startCamera').click()`);
  await b.waitFor(`document.getElementById('status').textContent.startsWith('摄像头')`, 15000, 'camera started');
  check('fake camera opens', true);
  const cams = await b.evaluate(`[...document.getElementById('cameraSelect').options].map(o => o.textContent)`);
  check('camera list populated', cams.length >= 1, `${cams.length} device(s)`);

  await sleep(3000);
  const fps = parseInt(await b.text('fpsPill'), 10);
  check('frames are processed', fps > 0, `${fps} fps`);
  check('face detected', await b.evaluate(`document.getElementById('noFace').classList.contains('hidden')`));

  await b.evaluate(`document.getElementById('calibrate').click()`);
  await b.waitFor(`document.getElementById('baselineInfo').textContent.startsWith('已校准')`, 15000, 'calibration');
  check('rest calibration produces baseline', true, await b.text('baselineInfo'));
  await sleep(1500);
  const act = parseFloat(await b.text('activityValue'));
  check('activity of a still face stays below start threshold', act < 2.5, `activity=${act}`);
} catch (e) {
  check('smoke run', false, e.message);
} finally {
  check('no console errors / exceptions', b.problems.length === 0, b.problems.slice(0, 5).join(' ; '));
  b.close();
  process.exit(finish());
}

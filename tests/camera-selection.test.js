import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCameraOptionModel, openCameraStream } from '../src/camera-selection.js';

const integrated = { deviceId: 'integrated-id', label: 'Integrated Camera' };
const nvidia = { deviceId: 'nvidia-id', label: 'Camera (NVIDIA Broadcast)' };

test('keeps the selected integrated camera when enumeration order changes', () => {
  const result = buildCameraOptionModel([nvidia, integrated], 'integrated-id', 'Integrated Camera');
  assert.equal(result.selectedId, 'integrated-id');
  assert.equal(result.options.find(option => option.value === result.selectedId).label, 'Integrated Camera');
});

test('does not silently select NVIDIA when the preferred camera temporarily disappears', () => {
  const result = buildCameraOptionModel([nvidia], 'integrated-id', 'Integrated Camera');
  assert.equal(result.selectedId, 'integrated-id');
  assert.equal(result.options[0].value, 'integrated-id');
  assert.equal(result.options[0].disabled, true);
  assert.match(result.options[0].label, /暂不可用/);
  assert.equal(result.options[1].value, 'nvidia-id');
});

test('selects the first available camera only when the user has no saved choice', () => {
  const result = buildCameraOptionModel([nvidia, integrated]);
  assert.equal(result.selectedId, 'nvidia-id');
});

test('rebinds a changed device ID only when its exact camera name is unique', () => {
  const renewed = { ...integrated, deviceId: 'new-integrated-id' };
  const result = buildCameraOptionModel([nvidia, renewed], integrated.deviceId, integrated.label);
  assert.equal(result.selectedId, renewed.deviceId);
  assert.equal(result.options.length, 2);
  assert.ok(result.options.every(option => !option.disabled));
  const ambiguous = buildCameraOptionModel([renewed, { ...renewed, deviceId: 'another-id' }], integrated.deviceId, integrated.label);
  assert.equal(ambiguous.selectedId, integrated.deviceId);
  assert.equal(ambiguous.options[0].disabled, true);
});

const videoDevices = devices => devices.map(device => ({ kind: 'videoinput', ...device }));
function fakeStream(device = integrated) {
  const track = { label: device.label, stopped: false, getSettings: () => ({ deviceId: device.deviceId }), stop() { this.stopped = true; } };
  return { track, getTracks: () => [track], getVideoTracks: () => [track] };
}
const captureError = (name, constraint = '') => Object.assign(new Error(''), { name, constraint });

test('startup refreshes the selected camera ID before requesting a stream', async () => {
  const renewed = { ...integrated, deviceId: 'renewed-id' };
  const stream = fakeStream(renewed);
  let requested;
  const result = await openCameraStream({
    enumerateDevices: async () => videoDevices([nvidia, renewed]),
    getUserMedia: async constraints => { requested = constraints; return stream; },
  }, { deviceId: integrated.deviceId, deviceLabel: integrated.label });
  assert.equal(requested.video.deviceId.exact, renewed.deviceId);
  assert.equal(result.deviceId, renewed.deviceId);
  assert.equal(result.stream, stream);
});

test('compatibility retry removes capture preferences but keeps the selected device exact', async () => {
  const requests = [];
  let retries = 0;
  const stream = fakeStream();
  const result = await openCameraStream({
    enumerateDevices: async () => videoDevices([nvidia, integrated]),
    getUserMedia: async constraints => {
      requests.push(constraints);
      if (requests.length === 1) throw captureError('OverconstrainedError', 'frameRate');
      return stream;
    },
  }, { deviceId: integrated.deviceId, deviceLabel: integrated.label, onRetry: () => retries++ });
  assert.equal(retries, 1);
  assert.equal(result.compatibilityMode, true);
  assert.equal(requests[0].video.deviceId.exact, integrated.deviceId);
  assert.deepEqual(requests[1], { video: { deviceId: { exact: integrated.deviceId } }, audio: false });
});

test('a missing integrated camera never retries with NVIDIA or the default camera', async () => {
  let attempts = 0;
  const error = captureError('OverconstrainedError', 'deviceId');
  await assert.rejects(openCameraStream({
    enumerateDevices: async () => videoDevices([nvidia]),
    getUserMedia: async constraints => {
      attempts++;
      assert.equal(constraints.video.deviceId.exact, integrated.deviceId);
      throw error;
    },
  }, { deviceId: integrated.deviceId, deviceLabel: integrated.label }), e => e === error);
  assert.equal(attempts, 1);
});

test('a driver ID change during a failed start can recover on the same named camera', async () => {
  let reads = 0;
  const requests = [];
  const renewed = { ...integrated, deviceId: 'renewed-id' };
  const result = await openCameraStream({
    enumerateDevices: async () => videoDevices([++reads === 1 ? integrated : renewed, nvidia]),
    getUserMedia: async constraints => {
      requests.push(constraints);
      if (requests.length === 1) throw captureError('OverconstrainedError', 'deviceId');
      return fakeStream(renewed);
    },
  }, { deviceId: integrated.deviceId, deviceLabel: integrated.label });
  assert.deepEqual(requests.map(request => request.video.deviceId.exact), [integrated.deviceId, renewed.deviceId]);
  assert.equal(result.deviceId, renewed.deviceId);
});

test('a browser stream from a different device is stopped and rejected', async () => {
  const wrong = fakeStream(nvidia);
  await assert.rejects(openCameraStream({
    enumerateDevices: async () => videoDevices([integrated, nvidia]),
    getUserMedia: async () => wrong,
  }, { deviceId: integrated.deviceId, deviceLabel: integrated.label }), /不同的摄像头/);
  assert.equal(wrong.track.stopped, true);
});

test('superseded camera requests release their stream and never return it to the page', async () => {
  let current = true;
  const stream = fakeStream();
  const result = await openCameraStream({
    enumerateDevices: async () => videoDevices([integrated]),
    getUserMedia: async () => { current = false; return stream; },
  }, { deviceId: integrated.deviceId, isCurrent: () => current });
  assert.equal(result, null);
  assert.equal(stream.track.stopped, true);
});

test('permission rejection is returned directly without another capture request', async () => {
  let attempts = 0;
  const error = captureError('NotAllowedError');
  await assert.rejects(openCameraStream({
    enumerateDevices: async () => videoDevices([integrated]),
    getUserMedia: async () => { attempts++; throw error; },
  }, { deviceId: integrated.deviceId }), e => e === error);
  assert.equal(attempts, 1);
});

test('persistent video-source errors stop after one same-device compatibility retry', async () => {
  let attempts = 0;
  const error = captureError('NotReadableError');
  await assert.rejects(openCameraStream({
    enumerateDevices: async () => videoDevices([integrated, nvidia]),
    getUserMedia: async constraints => {
      attempts++;
      assert.equal(constraints.video.deviceId.exact, integrated.deviceId);
      throw error;
    },
  }, { deviceId: integrated.deviceId, deviceLabel: integrated.label }), e => e === error);
  assert.equal(attempts, 2);
});

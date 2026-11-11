const cameraLabelKey = label => String(label || '').trim().toLowerCase();

// A driver reset can change deviceId. Rebind only to one exactly named device;
// never guess between duplicate names or fall back to a different camera.
export function resolveCameraDevice(devices, preferredId = '', preferredLabel = '') {
  const byId = preferredId && devices.find(device => device.deviceId === preferredId);
  if (byId) return byId;
  const label = cameraLabelKey(preferredLabel);
  if (!label) return null;
  const matches = devices.filter(device => device.deviceId && cameraLabelKey(device.label) === label);
  return matches.length === 1 ? matches[0] : null;
}

// Keep the user's explicit camera choice stable while the browser device list changes.
export function buildCameraOptionModel(devices, preferredId = null, preferredLabel = '') {
  const options = devices.map((device, index) => ({
    value: device.deviceId || '',
    label: device.label || `摄像头 ${index + 1}`,
    disabled: false,
  }));
  const preferred = preferredId == null ? '' : String(preferredId);
  const resolved = resolveCameraDevice(devices, preferred, preferredLabel);
  const hasPreferred = !!resolved;

  if (preferred && !hasPreferred) {
    options.unshift({
      value: preferred,
      label: `${preferredLabel || '所选摄像头'}（暂不可用；不会自动切换）`,
      disabled: true,
    });
  }

  const selectedId = resolved?.deviceId || (preferredId != null
    ? preferred
    : (options[0]?.value ?? ''));
  return { options, selectedId };
}

export async function openCameraStream(mediaDevices, {
  deviceId = '', deviceLabel = '', isCurrent = () => true, onRetry = () => {},
} = {}) {
  const readDevices = async () => {
    try { return (await mediaDevices.enumerateDevices()).filter(device => device.kind === 'videoinput'); }
    catch { return null; } // Enumeration may be restricted before permission is granted.
  };
  const devices = await readDevices();
  if (!isCurrent()) return null;
  const selected = resolveCameraDevice(devices || [], deviceId, deviceLabel)
    || (!deviceId && !deviceLabel ? devices?.[0] : null);
  let requestedId = selected?.deviceId || deviceId;
  let requestedLabel = selected?.label || deviceLabel;
  const capture = async compatibilityMode => {
    const video = compatibilityMode ? {} : {
      width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 60 },
    };
    if (requestedId) video.deviceId = { exact: requestedId };
    const stream = await mediaDevices.getUserMedia({ video: Object.keys(video).length ? video : true, audio: false });
    const stop = () => stream.getTracks().forEach(track => track.stop());
    if (!isCurrent()) { stop(); return null; }
    const track = stream.getVideoTracks()[0];
    if (!track) { stop(); throw new Error('没有可用的视频轨道'); }
    const actualId = track.getSettings().deviceId || '';
    const mismatch = requestedId && actualId
      ? actualId !== requestedId
      : requestedLabel && track.label && cameraLabelKey(track.label) !== cameraLabelKey(requestedLabel);
    if (mismatch) { stop(); throw new Error('浏览器返回了不同的摄像头，已阻止自动切换'); }
    return { stream, deviceId: actualId || requestedId, compatibilityMode };
  };
  try { return await capture(false); }
  catch (error) {
    if (!isCurrent()) return null;
    if (!['OverconstrainedError', 'NotReadableError', 'NotFoundError'].includes(error.name)) throw error;
    const latest = await readDevices();
    if (!isCurrent()) return null;
    const rebound = resolveCameraDevice(latest || [], requestedId, requestedLabel);
    const idChanged = !!rebound?.deviceId && rebound.deviceId !== requestedId;
    if (rebound) {
      requestedId = rebound.deviceId || requestedId;
      requestedLabel = rebound.label || requestedLabel;
    }
    // Dropping the requested deviceId here would silently open NVIDIA/default camera.
    if ((error.name === 'NotFoundError' || error.constraint === 'deviceId') && !idChanged) throw error;
    if (requestedId && latest?.some(device => device.label)
      && !latest.some(device => device.deviceId === requestedId)) throw error;
    onRetry();
    if (!isCurrent()) return null;
    return capture(true); // Retry once with only the same camera's exact ID.
  }
}

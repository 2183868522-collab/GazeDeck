import { SoundCraftClientError } from './soundcraft-client.js';

const updateMessage = '单轨播放需要新版 SoundCraft 控制模式与桌面网页服务。';
const seekUpdateMessage = '单轨实时快进／快退需要新版 SoundCraft 控制模式与桌面网页服务。';
const fail = (code, message, uncertain = false) => new SoundCraftClientError(code, message, uncertain);
const audioIds = core => core.tracks.filter(track => track.kind === 'audio').map(track => track.id);
const rowFor = (value, track) => value.tracks.find(row => row.track === track);

function sameIds(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length
    && new Set(actual).size === actual.length && actual.every(id => expected.includes(id));
}

function parse(value, core, uncertain = false) {
  if (!value || value.version !== 1 || typeof value.epoch !== 'string' || !value.epoch || value.epoch.length > 256
    || value.projectKey !== core.projectKey || value.projectPath !== core.projectPath || value.projectName !== core.projectName
    || !sameIds(value.trackIds, core.tracks.map(track => track.id)) || typeof value.playing !== 'boolean'
    || !Array.isArray(value.tracks) || !sameIds(value.tracks.map(row => row?.track), audioIds(core))
    || value.tracks.some(row => typeof row.paused !== 'boolean'
      || !(row.position === null || Number.isFinite(row.position) && row.position >= 0))) {
    throw fail('deck_playback_invalid_state', '未取得可信的单轨播放状态，请核对 SoundCraft。', uncertain);
  }
  return value;
}

export class SoundCraftDeckPlaybackClient {
  constructor(core) {
    this.core = core;
    this.reset();
  }

  reset() {
    this.snapshot = null;
    this.unsupportedKey = null;
    this.message = '';
  }

  unsupported() {
    return !!this.unsupportedKey && this.unsupportedKey === this.core.snapshot?.projectKey;
  }

  async read() {
    const core = this.core;
    if (!core.connected || this.unsupported()) return null;
    return core._run(async context => {
      const { value } = await this.readBound(context);
      return value;
    });
  }

  async readBound(context) {
    const core = this.core;
    try {
      const reply = await core._request('/api/soundcraft/deck-playback', {}, context);
      const value = parse(reply.result, core.snapshot);
      this.snapshot = value;
      core.snapshot = { ...core.snapshot, playing: value.playing };
      this.message = '';
      return { value };
    } catch (error) {
      core._assertCurrent(context);
      this.snapshot = null;
      const unsupported = ['not_found', 'invalid_reply', 'deck_playback_unsupported'].includes(error.code);
      if (unsupported) this.unsupportedKey = core.snapshot?.projectKey;
      const failure = unsupported ? fail('deck_playback_unsupported', updateMessage) : error;
      this.message = failure.message;
      return { error: failure };
    }
  }

  async toggle(track, peer, canWrite) {
    const core = this.core;
    core._requireConnected();
    if (this.unsupported()) throw fail('deck_playback_unsupported', updateMessage);
    const result = await core._run(async context => {
      const { value: before, error } = await this.readBound(context);
      if (error) return { error };
      const target = rowFor(before, track);
      if (!target || !rowFor(before, peer) || peer === track) {
        return { error: fail('deck_playback_invalid_target', '请为 A、B 绑定两条不同的音频轨道。') };
      }
      if (!canWrite()) {
        return { error: fail('deck_playback_unavailable', '连接、界面或眼动条件已变化，单轨操作已取消。') };
      }
      const paused = before.playing && !target.paused;
      const { projectPath, projectName, trackIds, epoch } = before;
      const params = { projectPath, projectName, trackIds, epoch, track, paused, peer,
        expectedPaused: target.paused, expectedPlaying: before.playing };
      context.mutationSent = true;
      let reply;
      try {
        reply = await core._request('/api/soundcraft', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'SET_DECK_PLAYBACK', params }) }, context);
      } catch (failure) {
        this.snapshot = null;
        if (failure.mayHaveExecuted) throw failure;
        if (['invalid_action', 'deck_playback_unsupported'].includes(failure.code)) {
          this.unsupportedKey = core.snapshot?.projectKey;
          this.message = updateMessage;
          return { error: fail('deck_playback_unsupported', updateMessage) };
        }
        this.message = failure.message;
        return { error: failure };
      }
      context.mutationAccepted = true;
      const after = parse(reply.result, core.snapshot, true);
      if (after.epoch !== epoch || after.playing !== true || before.tracks.some(row => {
        const expected = row.track === track ? paused : row.track === peer && !before.playing ? true : row.paused;
        return rowFor(after, row.track).paused !== expected;
      })) {
        this.snapshot = null;
        throw fail('deck_playback_not_confirmed', '单轨播放回执与请求不一致，请重新连接核对。', true);
      }
      this.snapshot = after;
      core.snapshot = { ...core.snapshot, playing: after.playing };
      return { value: after };
    });
    if (result.error) throw result.error;
    return result.value;
  }

  async seekRelative(track, offsetSeconds, opening, canWrite) {
    const core = this.core;
    core._requireConnected();
    const before = this.snapshot;
    if (before?.seekSupported !== true) throw fail('deck_seek_unsupported', seekUpdateMessage);
    if (before.projectKey !== opening.projectKey || before.epoch !== opening.epoch
      || core.snapshot.projectKey !== before.projectKey || !rowFor(before, track)) {
      throw fail('deck_seek_changed', '单轨定位的工程或轨道已变化，请重新打开弹窗。');
    }
    if (!Number.isFinite(offsetSeconds) || offsetSeconds === 0 || Math.abs(offsetSeconds) > 30) {
      throw fail('deck_seek_invalid_offset', '单次定位的偏移须在 ±30 秒内。');
    }
    const result = await core._run(async context => {
      if (!canWrite()) return { error: fail('deck_seek_unavailable', '单轨定位条件已变化，本次偏移未发送。') };
      const { projectPath, projectName, trackIds, epoch } = before;
      const params = { projectPath, projectName, trackIds, epoch, track, offsetSeconds };
      context.mutationSent = true;
      let reply;
      try {
        reply = await core._request('/api/soundcraft', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'SEEK_DECK_RELATIVE', params }),
        }, context);
      } catch (error) {
        if (error.mayHaveExecuted) {
          this.snapshot = null;
          throw error;
        }
        if (['invalid_action', 'deck_seek_unsupported'].includes(error.code)) {
          this.snapshot = { ...before, seekSupported: false };
          return { error: fail('deck_seek_unsupported', seekUpdateMessage) };
        }
        return { error };
      }
      context.mutationAccepted = true;
      const after = parse(reply.result, core.snapshot, true);
      const seek = after.seek;
      const tolerance = 1 / (core.snapshot.sampleRate || 48000);
      if (after.seekSupported !== true || after.epoch !== epoch || !seek || seek.track !== track
        || !Number.isFinite(seek.beforeSeconds) || seek.beforeSeconds < 0
        || !Number.isFinite(seek.afterSeconds) || seek.afterSeconds < 0
        || !Number.isFinite(seek.deltaSeconds)
        || Math.abs(seek.deltaSeconds) > Math.abs(offsetSeconds) + tolerance
        || seek.deltaSeconds * offsetSeconds < 0 || rowFor(after, track).position === null) {
        this.snapshot = null;
        throw fail('deck_seek_not_confirmed', '单轨定位回执与请求不一致，请重新连接核对。', true);
      }
      this.snapshot = after;
      core.snapshot = { ...core.snapshot, playing: after.playing };
      return { value: seek };
    });
    if (result.error) throw result.error;
    return result.value;
  }
}

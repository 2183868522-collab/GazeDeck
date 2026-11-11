"""Local GazeDeck static server and SoundCraft HTTP -> TCP JSON bridge.

Double-click this file as before, or: python serve.py [port] [--soundcraft-port 7979].
The browser origin stays localhost:8917 so existing browser profiles remain available.
SoundCraft must already be running with --control 7979; no audio is started at launch.
Only Python's standard library is required.
"""
import argparse
import copy
import hashlib
import itertools
import json
import math
import os
import socket
import struct
import sys
import tempfile
import threading
import time
import webbrowser
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

APP_ROOT = Path(__file__).resolve().parent
PORT = 8917
SOUNDCRAFT_PORT = 7979
MAX_BODY = 64 * 1024
MAX_REPLY = 4 * 1024 * 1024
MAX_SAFE_INTEGER = 2 ** 53 - 1
MAX_LIBRARY_SONGS = 5
MAX_SONG_BYTES = 128 * 1024 * 1024
SONG_EXTENSIONS = {'.wav', '.mp3', '.flac', '.aiff', '.aif', '.m4a', '.aac', '.ogg', '.caf'}
EQ_BANDS = {'low': 'low_shelf_gain', 'mid': 'mid_gain', 'high': 'high_shelf_gain'}
RATE_POLICY = 'fixed_seconds_independent_source_wrap'
EFFECT_PLUGINS = {'reverb': 'room_reverb', 'delay': 'mod_delay', 'chorus': 'chorus'}
TONE_PLUGINS = {'eq_7band', *EFFECT_PLUGINS.values()}
TONE_DEFAULT_AMOUNTS = {'reverb': .25, 'delay': .30, 'chorus': .50}
TRANSPORT_PARAMS = {
    'transport.play': {'from'}, 'transport.pause': set(), 'transport.stop': set(),
    'transport.locate': {'at'}, 'transport.rewind': {'seconds'}, 'transport.fast_forward': {'seconds'},
}
MIX_COMMANDS = {
    'mix.volume', 'mix.pan', 'mix.mute', 'mix.solo', 'mix.insert',
    'mix.insert_param', 'mix.insert_params', 'mix.insert_bypass',
}


class BridgeError(Exception):
    def __init__(self, code, message, status=400, may_have_executed=False):
        super().__init__(message)
        self.code, self.status, self.may_have_executed = code, status, may_have_executed


def valid_song_id(value):
    return isinstance(value, str) and len(value) == 64 and all(c in '0123456789abcdef' for c in value)


def valid_song_name(value):
    return (isinstance(value, str) and 0 < len(value) <= 200 and value == value.strip()
            and not any(c in '<>:"/\\|?*' or not c.isprintable() for c in value)
            and Path(value).suffix.lower() in SONG_EXTENSIONS)


class SongLibrary:
    def __init__(self, path=None):
        local = Path(os.environ.get('LOCALAPPDATA') or Path.home() / '.gazedeck')
        self.root = Path(path) if path is not None else local / 'GazeDeck' / 'soundcraft-song-library'
        self.catalog = self.root / 'songs.json'
        self.lock = threading.Lock()

    def _list(self):
        try:
            with self.catalog.open(encoding='utf-8') as stream:
                songs = json.loads(stream.read(16384))
        except FileNotFoundError:
            return []
        except (OSError, ValueError) as error:
            raise BridgeError('library_unavailable', '本机曲库清单无法读取', 409) from error
        if (not isinstance(songs, list) or len(songs) > MAX_LIBRARY_SONGS
                or any(not isinstance(row, dict) or set(row) != {'id', 'name', 'size'}
                       or not valid_song_id(row['id']) or not valid_song_name(row['name'])
                       or type(row['size']) is not int or not 0 < row['size'] <= MAX_SONG_BYTES for row in songs)
                or len({row['id'] for row in songs}) != len(songs)):
            raise BridgeError('library_unavailable', '本机曲库清单格式无效', 409)
        return songs

    def _save(self, songs):
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=self.root, delete=False) as stream:
                temporary = Path(stream.name)
                json.dump(songs, stream, ensure_ascii=False)
            temporary.replace(self.catalog)
        except OSError as error:
            raise BridgeError('library_unavailable', '无法更新本机曲库清单，请检查可用空间', 507) from error
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)

    def _public_song(self, song):
        """Read only the WAV header; the catalog remains the source of identity."""
        public = dict(song)
        if Path(song['name']).suffix.lower() != '.wav':
            return public
        try:
            path = self._asset_path(song)
            size = path.stat().st_size
            if size != song['size']:
                return public
            with path.open('rb') as stream:
                header = stream.read(12)
                if len(header) != 12 or header[:4] != b'RIFF' or header[8:] != b'WAVE':
                    return public
                fmt, data_size = None, None
                for _ in range(128):
                    chunk = stream.read(8)
                    if len(chunk) != 8:
                        break
                    chunk_size = struct.unpack_from('<I', chunk, 4)[0]
                    start = stream.tell()
                    if start + chunk_size > size:
                        break
                    if chunk[:4] == b'fmt ' and chunk_size >= 16:
                        fmt = struct.unpack('<HHIIHH', stream.read(16))
                    elif chunk[:4] == b'data':
                        data_size = chunk_size
                    if fmt is not None and data_size is not None:
                        encoding, channels, rate, _, block, _ = fmt
                        if encoding in (1, 3, 0xfffe) and 0 < channels <= 64 and 0 < rate <= 768000 and block >= channels:
                            duration = data_size / block / rate
                            if 0 < duration <= 1000000 and math.isfinite(duration):
                                public['durationSeconds'] = duration
                        break
                    stream.seek(start + chunk_size + (chunk_size & 1))
        except (OSError, ValueError, struct.error):
            pass
        return public

    def list(self):
        with self.lock:
            return [self._public_song(song) for song in self._list()]

    def remove(self, song_id):
        with self.lock:
            songs = self._list()
            retained = [row for row in songs if row['id'] != song_id]
            if retained != songs:
                self._save(retained)
            return [self._public_song(song) for song in retained]

    def _asset_path(self, song):
        return self.root / (song['id'] + Path(song['name']).suffix.lower())

    def lookup(self, song_id):
        with self.lock:
            song = next((row for row in self._list() if row['id'] == song_id), None)
            if song is None:
                raise BridgeError('song_not_found', '这首曲目已不在本机曲库，请刷新列表', 404)
            try:
                path = self._asset_path(song).resolve(strict=True)
                if not path.is_relative_to(self.root.resolve()) or not path.is_file() or path.stat().st_size != song['size']:
                    raise OSError('invalid cached audio file')
            except OSError as error:
                raise BridgeError('song_missing', '本机曲库的音频副本已丢失或变化，请重新导入', 409) from error
            return song, path

    def add(self, name, source, length):
        temporary = None
        digest = hashlib.sha256()
        try:
            self.root.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(dir=self.root, delete=False) as output:
                temporary = Path(output.name)
                remaining = length
                while remaining:
                    chunk = source.read(min(remaining, 256 * 1024))
                    if not chunk:
                        raise BridgeError('incomplete_upload', '音频上传中断，请重新选择文件')
                    output.write(chunk)
                    digest.update(chunk)
                    remaining -= len(chunk)
            song = {'id': digest.hexdigest(), 'name': name, 'size': length}
            with self.lock:
                songs = self._list()
                old = next((row for row in songs if row['id'] == song['id']), None)
                if old is None and len(songs) >= MAX_LIBRARY_SONGS:
                    raise BridgeError('library_full', '曲库已有五首，请先移除一个条目再导入', 409)
                if old is not None:
                    song = old
                asset = self._asset_path(song)
                if not asset.exists():
                    temporary.replace(asset)
                elif not asset.is_file() or asset.stat().st_size != length:
                    raise BridgeError('library_unavailable', '本机音频副本已变化，请检查曲库文件', 409)
                if old is None:
                    songs.append(song)
                    self._save(songs)
                return [self._public_song(row) for row in songs], self._public_song(song)
        except TimeoutError as error:
            raise BridgeError('upload_timeout', '音频上传超时，请重新选择文件', 408) from error
        except OSError as error:
            raise BridgeError('library_unavailable', '无法写入本机曲库，请检查可用空间', 507) from error
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)


def valid_track_ids(values):
    return (isinstance(values, list) and bool(values) and all(type(track) is int and track > 0 for track in values)
            and len(set(values)) == len(values))


def valid_bpm(value):
    # The engine accepts 5..1000; this UI deliberately offers a narrower range.
    return type(value) in (int, float) and 20 <= value <= 300 and math.isfinite(value)


def valid_expected_tempo(value):
    return (isinstance(value, list) and len(value) == 1 and isinstance(value[0], list)
            and len(value[0]) == 2 and type(value[0][0]) is int and value[0][0] == 0
            and valid_bpm(value[0][1]))


def valid_eq_db(value):
    return type(value) in (int, float) and -24 <= value <= 24 and math.isfinite(value)


def valid_eq_insert(value):
    return (isinstance(value, dict) and set(value) == {'plugin', 'bypass', 'params'}
            and value['plugin'] == 'eq_7band' and value['bypass'] is False
            and isinstance(value['params'], dict) and 0 < len(value['params']) <= 128
            and all(isinstance(key, str) and 0 < len(key) <= 128
                    and type(number) in (int, float) and -1e12 <= number <= 1e12 and math.isfinite(number)
                    for key, number in value['params'].items())
            and all(valid_eq_db(value['params'].get(key)) for key in EQ_BANDS.values()))


def valid_rate(value):
    return type(value) in (int, float) and .5 <= value <= 2 and math.isfinite(value)


def valid_rate_loop(value):
    return (isinstance(value, dict) and set(value) == {'start', 'end'}
            and type(value.get('start')) is int and type(value.get('end')) is int
            and 0 <= value['start'] < value['end'] <= MAX_SAFE_INTEGER)


def valid_rate_state(value):
    return (isinstance(value, dict) and set(value) == {'rate', 'revision', 'loop'}
            and valid_rate(value.get('rate')) and type(value.get('revision')) is int
            and 0 <= value['revision'] <= MAX_SAFE_INTEGER
            and (value['loop'] is None or valid_rate_loop(value['loop'])))


def valid_rate_update(value):
    return (isinstance(value, dict) and set(value) == {'track', 'rate', 'expected'}
            and type(value.get('track')) is int and 0 < value['track'] <= MAX_SAFE_INTEGER
            and valid_rate(value.get('rate')) and valid_rate_state(value.get('expected')))


def valid_effect_amount(value):
    return type(value) in (int, float) and math.isfinite(value) and 0 <= value <= 1


def valid_effect_insert(value, effect, read_only=False):
    return (isinstance(value, dict) and set(value) == {'plugin', 'bypass', 'params'}
            and value.get('plugin') == EFFECT_PLUGINS[effect] and type(value.get('bypass')) is bool
            and isinstance(value.get('params'), dict) and len(value['params']) <= 128
            and all(isinstance(key, str) and 0 < len(key) <= 128
                    and type(number) in (int, float) and math.isfinite(number) and abs(number) <= 1e12
                    for key, number in value['params'].items())
            and (read_only or 'mix' not in value['params'] or 0 <= value['params']['mix'] <= 100))


def valid_effect_update(value, effect, restore=False):
    fields = {'track', 'slot', 'expectedInsert'} | ({'restoreInsert'} if restore else {'enabled', 'amount'})
    return (isinstance(value, dict) and set(value) == fields
            and type(value.get('track')) is int and 0 < value['track'] <= MAX_SAFE_INTEGER
            and type(value.get('slot')) is int and 0 <= value['slot'] <= 9
            and (value['expectedInsert'] is None or valid_effect_insert(value['expectedInsert'], effect))
            and ((value['restoreInsert'] is None or valid_effect_insert(value['restoreInsert'], effect)) if restore
                 else type(value.get('enabled')) is bool and valid_effect_amount(value.get('amount'))))


def valid_tone(value):
    if not isinstance(value, dict) or set(value) != {'eq', 'effects'}:
        return False
    eq, effects = value.get('eq'), value.get('effects')
    return (isinstance(eq, dict) and set(eq) == {'enabled', *EQ_BANDS}
            and type(eq.get('enabled')) is bool and all(valid_eq_db(eq.get(band)) for band in EQ_BANDS)
            and isinstance(effects, dict) and set(effects) == set(EFFECT_PLUGINS)
            and all(isinstance(row, dict) and set(row) == {'enabled', 'amount'}
                    and type(row.get('enabled')) is bool and valid_effect_amount(row.get('amount'))
                    for row in effects.values()))


def valid_tone_inserts(value):
    return (isinstance(value, list) and len(value) <= 10
            and all(isinstance(row, dict) and set(row) == {'slot', 'plugin', 'bypass', 'params'}
                    and type(row.get('slot')) is int and 0 <= row['slot'] < 10
                    and isinstance(row.get('plugin'), str) and 0 < len(row['plugin']) <= 256
                    and type(row.get('bypass')) is bool and isinstance(row.get('params'), dict)
                    and len(row['params']) <= 512
                    and all(isinstance(key, str) and 0 < len(key) <= 256
                            and type(number) in (int, float) and math.isfinite(number) and abs(number) <= 1e12
                            for key, number in row['params'].items()) for row in value)
            and len({row['slot'] for row in value}) == len(value))


def valid_tone_update(value):
    return (isinstance(value, dict) and set(value) == {'track', 'expectedInserts', 'tone'}
            and type(value.get('track')) is int and 0 < value['track'] <= MAX_SAFE_INTEGER
            and valid_tone_inserts(value.get('expectedInserts')) and valid_tone(value.get('tone')))


def valid_level_db(value):
    return type(value) in (int, float) and math.isfinite(value) and -144 <= value <= 12


def valid_level_update(value):
    return (isinstance(value, dict) and set(value) == {'track', 'expectedDb', 'db'}
            and type(value.get('track')) is int and 0 < value['track'] <= MAX_SAFE_INTEGER
            and valid_level_db(value.get('expectedDb')) and valid_level_db(value.get('db')))


def valid_waveform_request(tracks, bins):
    return (valid_track_ids(tracks) and len(tracks) <= 2
            and all(track <= MAX_SAFE_INTEGER for track in tracks)
            and type(bins) is int and 32 <= bins <= 1024)


def waveform_query(raw):
    """Strict, bounded query parsing; no file paths or arbitrary native params."""
    if not isinstance(raw, str) or len(raw) > 128:
        raise BridgeError('invalid_params', '波形查询过长')
    try:
        query = parse_qs(raw, keep_blank_values=True, strict_parsing=True, max_num_fields=2)
    except ValueError as error:
        raise BridgeError('invalid_params', '波形查询需要 tracks=轨道ID（最多两条）及可选 bins=32–1024') from error
    if (set(query) not in ({'tracks'}, {'tracks', 'bins'})
            or any(len(values) != 1 for values in query.values())):
        raise BridgeError('invalid_params', '波形查询仅接受唯一 tracks 及可选 bins 参数')
    parts = query['tracks'][0].split(',')
    value = query.get('bins', ['256'])[0]
    if (not 1 <= len(parts) <= 2 or any(not 0 < len(part) <= 16 or not part.isascii() or not part.isdigit() for part in parts)
            or not 0 < len(value) <= 4 or not value.isascii() or not value.isdigit()):
        raise BridgeError('invalid_params', '轨道 ID 与 bins 必须是有效的十进制整数')
    tracks, bins = [int(part) for part in parts], int(value)
    if not valid_waveform_request(tracks, bins):
        raise BridgeError('invalid_params', '波形查询最多两条不同轨道，bins 范围为 32–1024')
    return tracks, bins


class SoundCraftBridge:
    def __init__(self, port=SOUNDCRAFT_PORT, timeout=3.0, pin_path=None, library_path=None):
        self.port, self.timeout = port, timeout
        # A compound loop operation holds this lock across all reads and writes.
        self._ids, self._lock = itertools.count(1), threading.RLock()
        # Native receipts are process-local. Retain only verified, scoped before/after
        # states; browser storage never grants arbitrary insert restore authority.
        self._tone_receipts = {}
        self._level_receipts = {}
        # A reset baseline belongs to the live native playback session. It is
        # captured when the user enables real control, never supplied by a browser.
        self._audio_reset_baseline = None
        self.song_library = SongLibrary(library_path)
        self.pin_path = Path(pin_path) if pin_path is not None else APP_ROOT / '.soundcraft-loop.json'
        self.loop_pin, self._pin_error = None, None
        try:
            if self.pin_path.exists():
                raw = self.pin_path.read_bytes()
                if len(raw) > 64 * 1024:
                    raise ValueError('配置文件过大')
                saved = json.loads(raw)
                pin = saved['loop']
                if saved.get('version') != 1 or pin is not None and not self._valid_pin(pin):
                    raise ValueError('固定循环配置无效')
                self.loop_pin = pin
        except (OSError, ValueError, KeyError, TypeError) as error:
            self._pin_error = str(error)

    @property
    def target(self):
        return {'host': '127.0.0.1', 'port': self.port}

    @staticmethod
    def _valid_pin(pin):
        return (isinstance(pin, dict) and isinstance(pin.get('projectPath'), str)
                and isinstance(pin.get('projectName'), str) and pin.get('projectPath')
                and type(pin.get('start')) is int and pin['start'] == 0
                and type(pin.get('end')) is int and pin['end'] > 0
                and type(pin.get('sampleRate')) in (int, float) and math.isfinite(pin['sampleRate']) and pin['sampleRate'] > 0
                and valid_track_ids(pin.get('trackIds')))

    def _session_identity(self, detail='summary'):
        reply = self.call('session.inspect', {'detail': detail})
        session = reply['result']
        if not isinstance(session, dict):
            raise BridgeError('invalid_reply', 'SoundCraft 没有返回有效工程', 502)
        tracks = session.get('tracks')
        if (not isinstance(tracks, list) or any(not isinstance(track, dict) or type(track.get('id')) is not int
                                               or track['id'] <= 0 for track in tracks)):
            raise BridgeError('invalid_reply', 'SoundCraft 轨道信息无效', 502)
        identity = {'projectPath': session.get('path'), 'projectName': session.get('name'),
                    'trackIds': sorted(track['id'] for track in tracks)}
        if (not isinstance(identity['projectPath'], str) or not identity['projectPath']
                or not isinstance(identity['projectName'], str)
                or len(set(identity['trackIds'])) != len(identity['trackIds'])):
            raise BridgeError('invalid_reply', '请先打开并保存有效的 SoundCraft 工程', 409)
        transport = session.get('transport')
        if not isinstance(transport, dict) or type(transport.get('playing')) is not bool:
            raise BridgeError('invalid_reply', 'SoundCraft 播放状态无效', 502)
        return identity, session, reply

    def _session_pin(self):
        identity, session, reply = self._session_identity()
        pin = {**identity, 'start': 0, 'end': session.get('length_samples'), 'sampleRate': session.get('sample_rate')}
        if not self._valid_pin(pin):
            raise BridgeError('empty_project', '请先打开并保存含有音轨和有效音频范围的 SoundCraft 工程', 409)
        return pin, session, reply

    @staticmethod
    def _same_pin(first, second):
        return all(first.get(key) == second.get(key) for key in
                   ('projectPath', 'projectName', 'trackIds', 'sampleRate', 'start', 'end'))

    @staticmethod
    def _public_pin(pin):
        return {**pin, 'pinned': True,
                'projectKey': json.dumps([pin['projectPath'], pin['projectName'], pin['trackIds']],
                                         ensure_ascii=False, separators=(',', ':'))}

    def _save_pin(self, pin):
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=self.pin_path.parent,
                                             prefix='.soundcraft-loop-', suffix='.tmp', delete=False) as stream:
                temporary = Path(stream.name)
                json.dump({'version': 1, 'loop': pin}, stream, ensure_ascii=False, allow_nan=False)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.pin_path)
        except OSError as error:
            if pin is None:
                raise BridgeError('loop_cancel_save_failed', '未能保存取消循环设置；尚未更改 SoundCraft 循环开关，请检查文件夹写入权限', 500) from error
            raise BridgeError('loop_save_failed', '循环范围已设置，但固定范围未能保存到本机；请检查文件夹写入权限后重新设置', 500, True) from error
        finally:
            if temporary is not None:
                try:
                    temporary.unlink(missing_ok=True)
                except OSError:
                    pass
        self.loop_pin, self._pin_error = pin, None

    def _apply_loop(self, pin, *, expected_playing=False):
        wrote = False
        try:
            # Explicit values are idempotent. Never toggle an unknown option or send PLAY here.
            selection = self.call('engine.execute', {'command': 'edit.select', 'params': {
                'tracks': pin['trackIds'], 'start': pin['start'], 'end': pin['end'], 'exact': True}})
            wrote = True
            result = selection.get('result')
            if (not isinstance(result, dict) or result.get('selection') != {'start': pin['start'], 'end': pin['end']}
                    or not valid_track_ids(result.get('tracks')) or set(result['tracks']) != set(pin['trackIds'])):
                raise BridgeError('loop_not_confirmed', 'SoundCraft 未确认全部轨道与循环范围', 502, True)
            for option, value in (('options.loop_playback', True), ('options.insertion_follows_playback', False)):
                reply = self.call('engine.execute', {'command': option, 'params': {'value': value}})
                if not isinstance(reply.get('result'), dict) or reply['result'].get('value') is not value:
                    raise BridgeError('loop_not_confirmed', 'SoundCraft 未确认循环开关设置', 502, True)
            current, session, reply = self._session_pin()
            selection = session.get('selection', {})
            if (not self._same_pin(pin, current) or not isinstance(selection, dict)
                    or selection.get('start') != pin['start'] or selection.get('end') != pin['end']
                    or not valid_track_ids(selection.get('tracks')) or set(selection['tracks']) != set(pin['trackIds'])
                    or session['transport']['playing'] is not expected_playing):
                raise BridgeError('loop_not_confirmed', '工程、选区或播放状态在设置过程中发生变化；请刷新核对', 409, True)
            return reply
        except BridgeError as error:
            error.may_have_executed = error.may_have_executed or wrote
            raise

    def execute(self, command):
        if not self._lock.acquire(timeout=0.2):
            raise BridgeError('busy', 'SoundCraft 正在处理上一请求，请稍后重试', 503)
        try:
            name, params = command['command'], command['params']
            if name == 'gazedeck.set_deck_playback':
                return self._set_deck_playback(params)
            if name == 'gazedeck.load_deck_song':
                return self._load_deck_song(params)
            if name == 'gazedeck.capture_audio_baseline':
                return self._capture_audio_baseline(params)
            if name == 'gazedeck.reset_audio':
                return self._reset_audio(params)
            if name == 'gazedeck.remove_library_song':
                return {'ok': True, 'result': {'songs': self.song_library.remove(params['id'])}}
            if name == 'gazedeck.seek_deck_relative':
                return self._seek_deck_relative(params)
            if name == 'gazedeck.set_track_rate':
                return self._set_track_rate(params)
            if name == 'gazedeck.set_eq':
                return self._edit_eq(params)
            if name in {'gazedeck.set_effect', 'gazedeck.restore_effect'}:
                return self._edit_effect(params, restore=name == 'gazedeck.restore_effect')
            if name in {'gazedeck.apply_tone', 'gazedeck.restore_tone'}:
                return self._edit_tone(params, restore=name == 'gazedeck.restore_tone')
            if name in {'gazedeck.set_levels', 'gazedeck.restore_levels'}:
                return self._edit_levels(params, restore=name == 'gazedeck.restore_levels')
            if name == 'gazedeck.set_tempo':
                return self._set_tempo(params)
            if name == 'gazedeck.seek_relative':
                return self._seek_relative(params)
            if name == 'gazedeck.disable_full_loop':
                identity, session, _ = self._session_identity()
                if params['projectPath'] != identity['projectPath'] or sorted(params['trackIds']) != identity['trackIds']:
                    raise BridgeError('project_changed', 'SoundCraft 工程或轨道已变化，请重新连接后取消循环', 409)
                if session['transport']['playing']:
                    raise BridgeError('pause_required', '请先暂停 SoundCraft，再取消全音轨循环', 409)
                runtime_reset = self._reset_runtime_loop_rates(identity)
                # Persist cancellation first: an engine timeout must not revive the old pin on restart.
                try:
                    self._save_pin(None)
                except BridgeError as error:
                    if runtime_reset:
                        error.may_have_executed = True
                        error.args = ('独立音源循环已清除、倍率已恢复 1×，但固定循环取消未能保存；' + str(error),)
                    raise
                try:
                    reply = self.call('engine.execute', {'command': 'options.loop_playback', 'params': {'value': False}})
                    if not isinstance(reply.get('result'), dict) or reply['result'].get('value') is not False:
                        raise BridgeError('loop_not_confirmed', 'SoundCraft 未确认循环开关已关闭', 502, True)
                    current, session, _ = self._session_identity()
                    if current != identity or session['transport']['playing']:
                        raise BridgeError('loop_not_confirmed', '工程、轨道或播放状态在取消过程中发生变化，请重新连接核对', 409, True)
                except BridgeError as error:
                    error.may_have_executed = True  # The persisted fixed-loop policy has already been cancelled.
                    error.args = ('网页固定循环范围已取消，但 SoundCraft 循环关闭状态未确认；' + str(error),)
                    raise
                public = {'pinned': False, 'enabled': False,
                          'projectKey': json.dumps([identity['projectPath'], identity['projectName'], identity['trackIds']],
                                                   ensure_ascii=False, separators=(',', ':'))}
                if runtime_reset:
                    public['runtimeRatesReset'] = runtime_reset
                return {**reply, 'result': {'loop': public}}
            if name == 'gazedeck.enable_full_loop':
                pin, session, _ = self._session_pin()
                if params['projectPath'] != pin['projectPath'] or sorted(params['trackIds']) != pin['trackIds']:
                    raise BridgeError('project_changed', 'SoundCraft 工程或轨道已变化，请重新连接后设置循环', 409)
                if session['transport']['playing']:
                    raise BridgeError('pause_required', '请先暂停 SoundCraft，再设置循环范围', 409)
                identity = {key: pin[key] for key in ('projectPath', 'projectName', 'trackIds')}
                runtime_reset = self._reset_runtime_loop_rates(identity, {'start': pin['start'], 'end': pin['end']})
                try:
                    reply = self._apply_loop(pin)
                    self._save_pin(pin)
                except BridgeError as error:
                    if runtime_reset:
                        error.may_have_executed = True
                        error.args = ('旧独立音源循环已清除、倍率已恢复 1×；新的全工程循环尚未完成，请核对后重新设置；' + str(error),)
                    raise
                public = self._public_pin(pin)
                if runtime_reset:
                    public['runtimeRatesReset'] = runtime_reset
                return {**reply, 'result': {'loop': public}}
            if name == 'transport.play':
                self._prepare_transport_play(params)
            return self.call('engine.execute', command)
        finally:
            self._lock.release()

    def _prepare_transport_play(self, params):
        if self._pin_error:
            raise BridgeError('loop_config_invalid', '本机固定循环配置无法读取，请重新设置或取消全音轨循环', 409)
        if not self.loop_pin:
            return
        if params:
            raise BridgeError('fixed_loop_active', '已固定循环范围，请使用不带定位参数的播放指令', 409)
        current, session, _ = self._session_pin()
        if not self._same_pin(self.loop_pin, current):
            raise BridgeError('project_changed', 'SoundCraft 工程、轨道或长度已变化，请重新设置固定循环范围', 409)
        if not session['transport']['playing']:
            self._apply_loop(self.loop_pin)

    @staticmethod
    def _rate_project_key(identity):
        return json.dumps([identity['projectPath'], identity['projectName'], identity['trackIds']],
                          ensure_ascii=False, separators=(',', ':'))

    @staticmethod
    def _validate_deck_playback(value, session):
        if (not isinstance(value, dict) or type(value.get('version')) is not int or value['version'] != 1
                or not isinstance(value.get('epoch'), str) or not 0 < len(value['epoch']) <= 256
                or type(value.get('playing')) is not bool or not isinstance(value.get('tracks'), list)):
            raise BridgeError('invalid_deck_playback_reply', 'SoundCraft 单轨播放回执格式无效', 502)
        audio_ids = {track['id'] for track in session['tracks'] if track.get('kind') == 'audio'}
        seen = set()
        for row in value['tracks']:
            if (not isinstance(row, dict) or set(row) != {'track', 'paused', 'position'}
                    or type(row.get('track')) is not int or row['track'] not in audio_ids
                    or row['track'] in seen or type(row.get('paused')) is not bool):
                raise BridgeError('invalid_deck_playback_reply', 'SoundCraft 单轨播放回执中的音轨无效', 502)
            position = row['position']
            if position is not None and (type(position) not in (int, float)
                                         or not 0 <= position <= MAX_SAFE_INTEGER):
                raise BridgeError('invalid_deck_playback_reply', 'SoundCraft 单轨播放位置无效', 502)
            seen.add(row['track'])
        if seen != audio_ids:
            raise BridgeError('invalid_deck_playback_reply', 'SoundCraft 没有返回所有音频轨道的播放状态', 502)
        return value

    def _read_deck_playback(self, session):
        try:
            reply = self.call('engine.execute', {'command': 'playback.deck.inspect', 'params': {}})
        except BridgeError as error:
            if error.code == 'engine_error' and 'unknown command' in str(error).lower():
                raise BridgeError('deck_playback_unsupported', '当前 SoundCraft 不支持单轨播放，请从桌面的控制模式快捷方式启动新版', 409) from error
            raise
        return self._validate_deck_playback(reply.get('result'), session), reply

    def _public_deck_playback(self, identity, model, reply):
        public = {key: model[key] for key in ('version', 'epoch', 'playing', 'tracks')}
        return {**reply, 'result': {**public, **identity, 'projectKey': self._rate_project_key(identity),
                                    'seekSupported': model.get('seek_supported') is True,
                                    'loadSupported': model.get('load_supported') is True}}

    @staticmethod
    def _reset_clip_matches(actual, saved):
        audio = saved.get('content', {}).get('Audio', {})
        return (isinstance(actual, dict) and isinstance(audio, dict)
                and all(actual.get(key) == saved.get(key) for key in
                        ('id', 'name', 'start', 'length', 'gain_db', 'muted', 'stretch'))
                and actual.get('source') == audio.get('source')
                and actual.get('offset') == audio.get('offset')
                and actual.get('fade_in') == saved.get('fade_in', {}).get('len')
                and actual.get('fade_out') == saved.get('fade_out', {}).get('len'))

    def _audio_reset_session(self, params):
        identity, session, _ = self._session_identity('full')
        if (params['projectPath'] != identity['projectPath'] or params['projectName'] != identity['projectName']
                or sorted(params['trackIds']) != identity['trackIds']):
            raise BridgeError('project_changed', 'SoundCraft 工程或轨道已变化，请重新连接', 409)
        if session['transport'].get('recording') is True:
            raise BridgeError('recording_active', 'SoundCraft 正在录音；未重置任何音频，请先结束录音', 409)
        targets = [params['deckA'], params['deckB']]
        audio_ids = sorted(row['id'] for row in session['tracks'] if row.get('kind') == 'audio')
        if audio_ids != sorted(targets):
            raise BridgeError('reset_unsupported', '一键重置仅支持当前工程正好由已绑定的 A/B 两条音频轨组成；未改动其他轨道', 409)
        model, _ = self._read_deck_playback(session)
        if model['epoch'] != params['epoch']:
            raise BridgeError('project_changed', 'SoundCraft 播放会话已变化，请重新连接', 409)
        return identity, session, model

    def _capture_audio_baseline(self, params):
        identity, session, model = self._audio_reset_session(params)
        project = Path(identity['projectPath'])
        try:
            if not project.is_file() or project.stat().st_size > 32 * 1024 * 1024:
                raise ValueError('工程文件不存在或过大')
            raw = project.read_bytes()
            saved = json.loads(raw)
        except (OSError, ValueError, UnicodeError) as error:
            raise BridgeError('reset_baseline_unavailable', '无法读取已保存的 SoundCraft 工程作为音频初始值；请先保存工程', 409) from error
        if (not isinstance(saved, dict) or saved.get('name') != identity['projectName']
                or saved.get('sample_rate') != session.get('sample_rate')
                or not isinstance(saved.get('tracks'), list) or not isinstance(saved.get('sources'), list)
                or sorted(row.get('id') for row in saved['tracks'] if isinstance(row, dict)) != identity['trackIds']):
            raise BridgeError('reset_baseline_changed', '已保存工程与当前 SoundCraft 工程不一致；请保存并重新连接', 409)
        sources = {row.get('id'): row for row in saved['sources'] if isinstance(row, dict)}
        live_sources = {row.get('id'): row for row in session.get('sources', []) if isinstance(row, dict)}
        tracks = {}
        for deck in ('deckA', 'deckB'):
            track_id = params[deck]
            row = next((item for item in saved['tracks'] if item['id'] == track_id), None)
            live = next(item for item in session['tracks'] if item['id'] == track_id)
            if not row or row.get('kind') != 'Audio' or not isinstance(row.get('playlists'), list):
                raise BridgeError('reset_baseline_unsupported', '已保存工程的 A/B 音轨结构无法安全重置', 409)
            index = row.get('active_playlist')
            if type(index) is not int or not 0 <= index < len(row['playlists']):
                raise BridgeError('reset_baseline_unsupported', '已保存工程的原始曲目列表无效', 409)
            playlist = row['playlists'][index]
            clips = playlist.get('clips') if isinstance(playlist, dict) else None
            if (not isinstance(playlist.get('name'), str) or not playlist['name']
                    or sum(item.get('name') == playlist['name'] for item in row['playlists'] if isinstance(item, dict)) != 1
                    or not isinstance(clips, list) or len(clips) != 1 or not isinstance(clips[0], dict)):
                raise BridgeError('reset_baseline_unsupported', '一键重置要求已保存的 A/B 各有唯一原始曲目列表和单个音频片段', 409)
            clip = clips[0]
            audio = clip.get('content', {}).get('Audio', {})
            source = sources.get(audio.get('source')) if isinstance(audio, dict) else None
            current_source = live_sources.get(audio.get('source')) if isinstance(audio, dict) else None
            mixer = row.get('mixer', {})
            inserts = mixer.get('inserts') if isinstance(mixer, dict) else None
            if (not isinstance(source, dict) or not isinstance(current_source, dict)
                    or current_source.get('loaded') is not True
                    or any(source.get(key) != current_source.get(key) for key in ('name', 'path', 'frames'))
                    or not isinstance(inserts, list) or any(insert is not None for insert in inserts)
                    or not isinstance(mixer.get('volume_db'), (int, float))
                    or not -144 <= mixer['volume_db'] <= 12
                    or type(mixer.get('mute')) is not bool or type(mixer.get('solo')) is not bool
                    or clip.get('start') != 0 or type(clip.get('length')) is not int or clip['length'] <= 0
                    or audio.get('offset') != 0):
                raise BridgeError('reset_baseline_unsupported', '原始 WAV、片段或插件配置无法安全自动恢复；未更改 SoundCraft', 409)
            if live.get('inactive') or live.get('record_arm') or live.get('input_monitor'):
                raise BridgeError('reset_baseline_unsupported', 'A/B 音轨未处于可控的音频输出状态', 409)
            tracks[track_id] = {'name': playlist['name'], 'clip': copy.deepcopy(clip),
                                'volumeDb': mixer['volume_db'], 'mute': mixer['mute'], 'solo': mixer['solo']}
        tempos = saved.get('tempo', {}).get('tempos', [])
        if (not isinstance(tempos, list) or len(tempos) != 1 or tempos[0].get('tick') != 0
                or not valid_bpm(tempos[0].get('bpm'))):
            raise BridgeError('reset_baseline_unsupported', '已保存工程包含不支持的速度图，未更改 SoundCraft', 409)
        pin = copy.deepcopy(self.loop_pin)
        if pin and (pin['projectPath'] != identity['projectPath'] or pin['projectName'] != identity['projectName']
                    or pin['trackIds'] != identity['trackIds']):
            pin = None
        self._audio_reset_baseline = {'projectKey': self._rate_project_key(identity), 'epoch': model['epoch'],
                                      'sha256': hashlib.sha256(raw).hexdigest(), 'tracks': tracks,
                                      'tempoBpm': tempos[0]['bpm'], 'pin': pin}
        return {'ok': True, 'result': {'projectKey': self._audio_reset_baseline['projectKey'],
                                       'epoch': model['epoch'], 'trackIds': sorted(tracks),
                                       'pinned': pin is not None}}

    def _reset_audio(self, params):
        identity, session, model = self._audio_reset_session(params)
        baseline = self._audio_reset_baseline
        if (not baseline or baseline['projectKey'] != self._rate_project_key(identity)
                or baseline['epoch'] != model['epoch']
                or sorted(baseline['tracks']) != sorted((params['deckA'], params['deckB']))):
            raise BridgeError('reset_baseline_missing', '音频初始值尚未为本次 SoundCraft 会话记录；请重新连接并启用真实控制', 409)
        try:
            current_hash = hashlib.sha256(Path(identity['projectPath']).read_bytes()).hexdigest()
        except OSError as error:
            raise BridgeError('reset_baseline_unavailable', '无法再读取原工程文件，未重置音频', 409) from error
        if current_hash != baseline['sha256']:
            raise BridgeError('reset_baseline_changed', '工程文件在连接后重新保存；未覆盖新的保存内容。请重新连接以采用新的初始值', 409)
        if self._pin_error:
            raise BridgeError('loop_config_invalid', '固定循环配置无效，未重置音频；请先检查循环设置', 409)
        self._constant_tempo(session)
        self._rate_model(identity)
        for track_id, target in baseline['tracks'].items():
            live = next(row for row in session['tracks'] if row['id'] == track_id)
            if (live.get('inactive') or live.get('record_arm') or live.get('input_monitor')
                    or live.get('automation_mode') not in ('read', 'off')
                    or any(lane.get('points') not in (0, []) for lane in live.get('automation', []))
                    or not isinstance(live.get('inserts'), list)
                    or any(insert.get('plugin') not in TONE_PLUGINS for insert in live['inserts'])):
                raise BridgeError('reset_unsupported',
                                  'A/B 存在录音、自动化或非 GazeDeck 插件；未覆盖这些 SoundCraft 修改，未执行重置', 409)
        steps = []
        stage = '暂停播放'
        try:
            if session['transport']['playing']:
                self.call('engine.execute', {'command': 'transport.stop', 'params': {}})
                steps.append('停止播放')
                for attempt in range(12):
                    current, session, _ = self._session_identity('full')
                    if current != identity:
                        raise BridgeError('project_changed', '工程或轨道在暂停时变化', 409, True)
                    if not session['transport']['playing']:
                        break
                    time.sleep(.05)
                else:
                    raise BridgeError('reset_not_confirmed', 'SoundCraft 未确认播放已停止', 502, True)
            stage = '清除独立变速与循环'
            cleared = self._reset_runtime_loop_rates(identity)
            if cleared:
                steps.append('独立变速恢复 1×')
            # An externally changed loop selection can start after zero. Native
            # DeckSeek wraps in that selection, so suspend looping before cueing
            # either independent Deck and restore the captured policy at the end.
            stage = '暂时关闭工程循环'
            loop_reply = self.call('engine.execute', {'command': 'options.loop_playback',
                                                       'params': {'value': False}})
            if not isinstance(loop_reply.get('result'), dict) or loop_reply['result'].get('value') is not False:
                raise BridgeError('reset_loop_not_confirmed', 'SoundCraft 未确认循环已暂时关闭', 502, True)
            steps.append('暂时关闭工程循环')
            stage = '恢复 A/B 原始曲目'
            for track_id, target in baseline['tracks'].items():
                current, session, _ = self._session_identity('full')
                if current != identity or session['transport']['playing']:
                    raise BridgeError('project_changed', '工程或播放状态在恢复曲目时变化', 409, bool(steps))
                live = next(row for row in session['tracks'] if row['id'] == track_id)
                if live.get('playlist') != target['name'] or len(live.get('clips', [])) != 1 \
                        or not self._reset_clip_matches(live['clips'][0], target['clip']):
                    self.call('engine.execute', {'command': 'track.playlist_select',
                                                 'params': {'track': track_id, 'name': target['name']}})
                    steps.append(f'Deck {"A" if track_id == params["deckA"] else "B"} 选回原曲')
                    current, session, _ = self._session_identity('full')
                    live = next(row for row in session['tracks'] if row['id'] == track_id)
                    if (current != identity or live.get('playlist') != target['name']
                            or len(live.get('clips', [])) != 1
                            or not self._reset_clip_matches(live['clips'][0], target['clip'])):
                        raise BridgeError('reset_song_not_confirmed',
                                          '原播放列表的片段已被其他操作修改，无法自动恢复原 WAV 参数', 409, True)
            stage = '恢复 A/B 音色与音量'
            for track_id, target in baseline['tracks'].items():
                current, session, _ = self._session_identity('full')
                if current != identity or session['transport']['playing']:
                    raise BridgeError('project_changed', '工程或播放状态在恢复音色时变化', 409, bool(steps))
                live = next(row for row in session['tracks'] if row['id'] == track_id)
                for insert in live['inserts']:
                    if insert['plugin'] not in TONE_PLUGINS:
                        raise BridgeError('reset_unsupported', '新增非 GazeDeck 插件，未覆盖此插件', 409, bool(steps))
                    self.call('engine.execute', {'command': 'mix.insert_remove',
                                                 'params': {'track': track_id, 'slot': insert['slot']}})
                    steps.append(f'轨道 {track_id} 移除 GazeDeck 插件')
                for field, command, native_field, value in (
                        ('volume_db', 'mix.volume', 'db', target['volumeDb']),
                        ('mute', 'mix.mute', 'value', target['mute']),
                        ('solo', 'mix.solo', 'value', target['solo'])):
                    if live.get(field) != value:
                        self.call('engine.execute', {'command': command,
                                                     'params': {'tracks': [track_id], native_field: value}})
                        steps.append(f'轨道 {track_id} {field} 恢复')
            stage = '恢复工程 BPM'
            current, session, _ = self._session_identity('full')
            if current != identity or session['transport']['playing']:
                raise BridgeError('project_changed', '工程或播放状态在恢复 BPM 时变化', 409, bool(steps))
            bpm = self._constant_tempo(session)
            if bpm != baseline['tempoBpm']:
                self._set_tempo({**identity, 'expectedTempoMap': [[0, bpm]], 'bpm': baseline['tempoBpm']})
                steps.append('工程 BPM 恢复')
            stage = '重置播放位置与 A/B 暂停状态'
            self.call('engine.execute', {'command': 'transport.locate', 'params': {'at': 0}})
            steps.append('播放头归零')
            for attempt in range(12):
                current, session, _ = self._session_identity('full')
                if current != identity or session['transport']['playing']:
                    raise BridgeError('project_changed', '工程或播放状态在归零时变化', 409, True)
                if session['transport'].get('position') == 0:
                    break
                time.sleep(.05)
            else:
                raise BridgeError('reset_not_confirmed', 'SoundCraft 未确认播放头归零', 502, True)
            playback, _ = self._read_deck_playback(session)
            for track_id in baseline['tracks']:
                state = next(row for row in playback['tracks'] if row['track'] == track_id)
                if not state['paused']:
                    self.call('engine.execute', {'command': 'playback.deck.set', 'params': {
                        'epoch': playback['epoch'], 'track': track_id, 'paused': True,
                        'expected_paused': False, 'expected_playing': False}})
                    steps.append(f'轨道 {track_id} 暂停')
                for attempt in range(16):
                    playback, _ = self._read_deck_playback(session)
                    state = next(row for row in playback['tracks'] if row['track'] == track_id)
                    if state['paused'] and type(state['position']) is int:
                        break
                    time.sleep(.025)
                else:
                    raise BridgeError('reset_deck_not_confirmed',
                                      f'轨道 {track_id} 未返回已暂停的独立播放位置', 502, True)
            # The shared transport playhead and independent Deck material cursors
            # are different. Locate(0) alone cannot cue either Deck to its start.
            sample_rate = session.get('sample_rate')
            if type(sample_rate) not in (int, float) or not 1 <= sample_rate <= 768000:
                raise BridgeError('invalid_reply', 'SoundCraft 未返回有效采样率', 502, True)
            step_samples = int(sample_rate * 30)
            for track_id in baseline['tracks']:
                for _ in range(64):
                    playback, _ = self._read_deck_playback(session)
                    state = next(row for row in playback['tracks'] if row['track'] == track_id)
                    position = state['position']
                    if not state['paused'] or type(position) is not int or position < 0:
                        raise BridgeError('reset_deck_not_confirmed',
                                          f'轨道 {track_id} 的独立播放位置无效', 502, True)
                    if position == 0:
                        break
                    offset = -min(position, step_samples)
                    reply = self.call('engine.execute', {'command': 'playback.deck.seek', 'params': {
                        'epoch': playback['epoch'], 'track': track_id, 'offset_samples': offset}})
                    steps.append(f'轨道 {track_id} 独立播放头归零中')
                    ack = reply.get('result')
                    revision = ack.get('revision') if isinstance(ack, dict) else None
                    if type(revision) is not int or revision <= 0:
                        raise BridgeError('reset_deck_not_confirmed',
                                          f'轨道 {track_id} 独立定位回执无效', 502, True)
                    for attempt in range(16):
                        playback, _ = self._read_deck_playback(session)
                        receipt = playback.get('last_seek')
                        applied = next(row for row in playback['tracks'] if row['track'] == track_id)
                        if (isinstance(receipt, dict) and receipt.get('revision') == revision
                                and receipt.get('track') == track_id and receipt.get('before') == position
                                and receipt.get('after') == applied['position']
                                and type(applied['position']) is int
                                and 0 <= applied['position'] < position):
                            break
                        time.sleep(.025)
                    else:
                        raise BridgeError('reset_deck_not_confirmed',
                                          f'轨道 {track_id} 独立定位未得到音频回调确认', 502, True)
                else:
                    raise BridgeError('reset_deck_unsupported',
                                      f'轨道 {track_id} 独立播放位置过长，无法在一次重置中安全归零', 409, True)
            stage = '恢复固定循环设置'
            current, session, _ = self._session_identity('full')
            if current != identity or session['transport']['playing']:
                raise BridgeError('project_changed', '工程或播放状态在恢复循环时变化', 409, True)
            if baseline['pin']:
                pin = {**baseline['pin'], 'end': session.get('length_samples')}
                if not self._valid_pin(pin):
                    raise BridgeError('reset_loop_unsupported', '原曲目长度无法用于固定循环', 409, True)
                self._apply_loop(pin)
                self._save_pin(pin)
                steps.append('固定循环恢复')
            else:
                self.call('engine.execute', {'command': 'options.loop_playback', 'params': {'value': False}})
                if self.loop_pin and self.loop_pin['projectPath'] == identity['projectPath']:
                    self._save_pin(None)
                steps.append('循环关闭')
            stage = '最终回读'
            current, after, _ = self._session_identity('full')
            playback, _ = self._read_deck_playback(after)
            rate_model, _ = self._rate_model(identity)
            if (current != identity or after['transport']['playing'] or after['transport']['position'] != 0
                    or playback['playing'] or any(not row['paused'] or row['position'] != 0
                                                  for row in playback['tracks'])
                    or self._constant_tempo(after) != baseline['tempoBpm']
                    or any(row['rate'] != 1 or row['loop'] is not None for row in rate_model['tracks'])
                    or bool(self.loop_pin) != bool(baseline['pin'])):
                raise BridgeError('reset_not_confirmed', '播放、速度、位置或循环未达到原始状态', 502, True)
            for track_id, target in baseline['tracks'].items():
                live = next(row for row in after['tracks'] if row['id'] == track_id)
                if (live.get('playlist') != target['name'] or len(live.get('clips', [])) != 1
                        or not self._reset_clip_matches(live['clips'][0], target['clip'])
                        or live.get('inserts') != [] or live.get('volume_db') != target['volumeDb']
                        or live.get('mute') != target['mute'] or live.get('solo') != target['solo']):
                    raise BridgeError('reset_not_confirmed', f'轨道 {track_id} 曲目、音量或效果未达到原始状态', 502, True)
            baseline['epoch'] = playback['epoch']
            return {'ok': True, 'result': {'projectKey': baseline['projectKey'],
                                           'epoch': playback['epoch'], 'playing': False,
                                           'positionSamples': 0, 'tempoBpm': baseline['tempoBpm'],
                                           'pinned': bool(baseline['pin']),
                                           'tracks': [{'id': track_id, 'sourceId': target['clip']['content']['Audio']['source'],
                                                      'volumeDb': target['volumeDb'], 'muted': target['mute']}
                                                     for track_id, target in baseline['tracks'].items()]}}
        except BridgeError as error:
            if steps:
                error.may_have_executed = True
                error.args = (f'音频仅部分恢复：已完成{"、".join(steps)}；{stage}未确认（{error}）。请刷新 SoundCraft 核对，勿直接重按。',)
            raise

    def deck_playback(self):
        if not self._lock.acquire(timeout=.2):
            raise BridgeError('busy', 'SoundCraft 正在处理上一请求，请稍后重试', 503)
        try:
            identity, session, _ = self._session_identity()
            model, reply = self._read_deck_playback(session)
            return self._public_deck_playback(identity, model, reply)
        finally:
            self._lock.release()

    def _set_deck_playback(self, params):
        identity, session, _ = self._session_identity()
        if (identity['projectPath'] != params['projectPath'] or identity['projectName'] != params['projectName']
                or identity['trackIds'] != sorted(params['trackIds'])):
            raise BridgeError('project_changed', 'SoundCraft 工程或轨道已变化，请重新连接', 409)
        model, _ = self._read_deck_playback(session)
        rows = {row['track']: row for row in model['tracks']}
        track, peer = params['track'], params['peer']
        if track not in rows or peer not in rows:
            raise BridgeError('invalid_tracks', '请选择两条不同的 SoundCraft 音频轨道绑定 A/B', 409)
        if (model['epoch'] != params['epoch'] or model['playing'] != params['expectedPlaying']
                or rows[track]['paused'] != params['expectedPaused']):
            raise BridgeError('deck_playback_changed', '播放状态已变化，请读取当前状态后再操作', 409)
        status = self.call('ui.inspect')['result']
        if not isinstance(status, dict) or status.get('audio_ready') is not True:
            raise BridgeError('deck_audio_not_ready', 'SoundCraft 音频输出尚未就绪，请检查播放设备', 409)
        starting = not params['paused'] and not model['playing']
        if starting:
            self._prepare_transport_play({})
        reply = self.call('engine.execute', {'command': 'playback.deck.set', 'params': {
            'epoch': model['epoch'], 'track': track, 'peer': peer, 'paused': params['paused'],
            'expected_paused': params['expectedPaused'], 'expected_playing': params['expectedPlaying'],
        }})
        try:
            result = self._validate_deck_playback(reply.get('result'), session)
            expected = {id_: row['paused'] for id_, row in rows.items()}
            expected[track] = params['paused']
            if starting:
                expected[peer] = True
            expected_playing = starting or model['playing']
            if (result['epoch'] != model['epoch'] or result['playing'] != expected_playing
                    or {row['track']: row['paused'] for row in result['tracks']} != expected):
                raise BridgeError('deck_playback_not_confirmed', 'SoundCraft 未确认目标 Deck 状态，请刷新核对', 409)
            touched = {track, peer} if starting else {track}
            deadline = time.monotonic() + .8
            while True:
                result, reply = self._read_deck_playback(session)
                states = {row['track']: row['paused'] for row in result['tracks']}
                if result['epoch'] != model['epoch'] or states != expected:
                    raise BridgeError('deck_playback_changed', '单轨播放期间工程或播放状态已变化，请重新连接', 409)
                if result['playing'] == expected_playing and all(
                    row['position'] is not None for row in result['tracks'] if row['track'] in touched
                ):
                    break
                if time.monotonic() >= deadline:
                    raise BridgeError('deck_playback_not_confirmed', '未收到 SoundCraft 音频引擎确认，请刷新核对', 409)
                time.sleep(.04)
            current, _, _ = self._session_identity()
            if current != identity:
                raise BridgeError('project_changed', '确认单轨播放时 SoundCraft 工程已变化，请重新连接', 409)
        except BridgeError as error:
            error.may_have_executed = True
            raise
        return self._public_deck_playback(identity, result, reply)

    def _load_deck_song(self, params):
        identity, session, _ = self._session_identity('full')
        if (identity['projectPath'] != params['projectPath'] or identity['projectName'] != params['projectName']
                or identity['trackIds'] != sorted(params['trackIds'])):
            raise BridgeError('project_changed', 'SoundCraft 工程或轨道已变化，请重新连接', 409)
        track = params['track']
        target = next((row for row in session['tracks'] if row['id'] == track and row.get('kind') == 'audio'), None)
        if target is None:
            raise BridgeError('invalid_tracks', '换曲需要选择已绑定的单条音频轨道', 409)
        if session['transport'].get('recording') is True:
            raise BridgeError('recording_active', 'SoundCraft 正在录音，请先结束录音再换曲', 409)
        model, _ = self._read_deck_playback(session)
        if model.get('load_supported') is not True:
            raise BridgeError('deck_load_unsupported', '请用桌面的 SoundCraft 控制模式快捷方式重开新版，启用真实换曲', 409)
        if model['epoch'] != params['epoch']:
            raise BridgeError('project_changed', 'SoundCraft 工程会话已变化，请重新连接', 409)
        if model['playing'] != session['transport']['playing']:
            raise BridgeError('deck_playback_changed', 'SoundCraft 播放状态正在变化，请刷新后重试换曲', 409)
        before_paused = {row['track']: row['paused'] for row in model['tracks']}
        target_paused = not model['playing'] or before_paused[track]
        rate_model = session.get('playback_rates')
        rate_tracks = rate_model.get('tracks') if isinstance(rate_model, dict) else None
        if isinstance(rate_tracks, list) and any(
            isinstance(row, dict) and row.get('loop') is not None for row in rate_tracks
        ):
            raise BridgeError('deck_load_rate_active', '请在「曲库与设置」取消全音轨循环以清除独立变速，再换曲', 409)
        old_pin = self.loop_pin
        if self._pin_error:
            raise BridgeError('loop_config_invalid', '请先取消全音轨循环，再换曲', 409)
        if old_pin:
            current_pin = {**identity, 'start': 0, 'end': session.get('length_samples'),
                           'sampleRate': session.get('sample_rate')}
            if not self._same_pin(old_pin, current_pin):
                raise BridgeError('project_changed', '原有固定循环与此工程不一致，请先取消全音轨循环', 409)
        if 'sourceId' in params:
            sources = session.get('sources')
            source = next((row for row in sources
                           if isinstance(row, dict) and type(row.get('id')) is int
                           and row['id'] == params['sourceId']), None) if isinstance(sources, list) else None
            if (source is None or source.get('loaded') is not True
                    or not isinstance(source.get('name'), str) or not source['name']
                    or source.get('name') != params['sourceName']
                    or source.get('path') != params['sourcePath']):
                raise BridgeError('project_source_changed', '工程素材已变化，请重新打开选曲列表', 409)
            project = Path(identity['projectPath'])
            relative = Path(source['path'])
            if not project.is_absolute() or relative.is_absolute():
                raise BridgeError('project_source_unavailable', '工程素材路径无效，请在 SoundCraft 中检查素材', 409)
            try:
                root = project.parent.resolve(strict=True)
                path = (root / relative).resolve(strict=True)
                if root not in path.parents or not path.is_file():
                    raise ValueError('素材不在当前工程目录内')
            except (OSError, ValueError) as error:
                raise BridgeError('project_source_unavailable', '工程素材文件不可用，请在 SoundCraft 中检查素材', 409) from error
            song = {'id': f"project:{source['id']}", 'name': source['name']}
        else:
            song, path = self.song_library.lookup(params['songId'])
        try:
            reply = self.call('engine.execute', {'command': 'playback.deck.load', 'params': {
                'epoch': model['epoch'], 'track': track, 'path': str(path), 'name': song['name'],
            }}, timeout=45.0)
        except BridgeError as error:
            if error.code == 'engine_error' and 'unknown command' in str(error).lower():
                raise BridgeError('deck_load_unsupported', '当前 SoundCraft 不支持真实换曲，请重开控制模式新版', 409) from error
            raise
        try:
            ack = reply.get('result')
            if (not isinstance(ack, dict) or type(ack.get('track')) is not int or ack['track'] != track
                    or any(type(ack.get(key)) is not int or not 0 < ack[key] <= MAX_SAFE_INTEGER
                           for key in ('clip', 'source', 'frames'))):
                raise BridgeError('deck_load_not_confirmed', 'SoundCraft 换曲回执格式无效，请刷新核对', 502)
            current, after, _ = self._session_identity()
            loaded = next((row for row in after['tracks'] if row['id'] == track), None)
            clips = loaded.get('clips') if loaded else None
            if (current != identity or after['transport']['playing'] != model['playing']
                    or not isinstance(clips, list) or len(clips) != 1 or not isinstance(clips[0], dict)
                    or clips[0].get('id') != ack['clip'] or clips[0].get('source') != ack['source']
                    or clips[0].get('start') != 0 or clips[0].get('length') != ack['frames']):
                raise BridgeError('deck_load_not_confirmed', 'SoundCraft 未确认选中的 Deck 已装载此曲，请刷新核对', 409)
            rate = after.get('sample_rate')
            if type(rate) not in (int, float) or not 1 <= rate <= 768000:
                raise BridgeError('invalid_reply', 'SoundCraft 工程采样率无效', 502)
            if old_pin and after.get('length_samples') != old_pin['end']:
                new_pin = {**old_pin, 'end': after.get('length_samples')}
                if not self._valid_pin(new_pin):
                    raise BridgeError('loop_not_confirmed', '已换曲，但新工程长度无法用于固定循环', 409)
                self._apply_loop(new_pin, expected_playing=model['playing'])
                self._save_pin(new_pin)
            deadline = time.monotonic() + .8
            while True:
                latest, _ = self._read_deck_playback(after)
                latest_paused = {row['track']: row['paused'] for row in latest['tracks']}
                if (latest['epoch'] != model['epoch'] or latest['playing'] != model['playing']
                        or any(latest_paused.get(peer) != paused for peer, paused in before_paused.items()
                               if peer != track)):
                    raise BridgeError('deck_load_not_confirmed', '换曲后工程或另一轨播放状态已变化，请刷新核对', 409)
                # The native cue clears this Deck's old cursor. A fresh runtime
                # position proves the new playlist has reached the audio thread.
                if any(row['track'] == track and row['paused'] == target_paused
                       and row['position'] is not None
                       and (row['position'] == 0 if target_paused else
                            0 <= row['position'] <= round(rate * 1.5))
                       for row in latest['tracks']):
                    break
                if time.monotonic() >= deadline:
                    raise BridgeError('deck_load_not_confirmed', '已读取新曲目，但尚未确认 Deck 从开头按原播放状态运行，请刷新核对', 409)
                time.sleep(.04)
            return {**reply, 'result': {'track': track, 'song': song, 'clipId': ack['clip'],
                                        'durationSeconds': ack['frames'] / rate,
                                        'playing': model['playing'], 'paused': target_paused}}
        except BridgeError as error:
            error.may_have_executed = True
            raise

    def _seek_deck_relative(self, params):
        identity, session, _ = self._session_identity()
        if (identity['projectPath'] != params['projectPath'] or identity['projectName'] != params['projectName']
                or identity['trackIds'] != sorted(params['trackIds'])):
            raise BridgeError('project_changed', 'SoundCraft 工程或轨道已变化，请重新连接', 409)
        track = params['track']
        if not any(row['id'] == track and row.get('kind') == 'audio' for row in session['tracks']):
            raise BridgeError('invalid_tracks', '单轨定位需要已绑定的 SoundCraft 音频轨道', 409)
        if session['transport'].get('recording') is True:
            raise BridgeError('recording_active', 'SoundCraft 正在录音，请先结束录音再定位', 409)
        rate = session.get('sample_rate')
        if type(rate) not in (int, float) or not 1 <= rate <= 768000:
            raise BridgeError('invalid_reply', 'SoundCraft 工程采样率无效', 502)
        offset = round(params['offsetSeconds'] * rate)
        if not offset:
            raise BridgeError('invalid_params', '单轨定位偏移小于一个采样点')
        try:
            reply = self.call('engine.execute', {'command': 'playback.deck.seek', 'params': {
                'epoch': params['epoch'], 'track': track, 'offset_samples': offset,
            }})
        except BridgeError as error:
            if error.code == 'engine_error' and 'unknown command' in str(error).lower():
                raise BridgeError('deck_seek_unsupported', '请用桌面的 SoundCraft 控制模式快捷方式重开新版，启用单轨定位', 409) from error
            raise
        try:
            ack = reply.get('result')
            if (not isinstance(ack, dict) or ack.get('epoch') != params['epoch']
                    or type(ack.get('track')) is not int or ack['track'] != track
                    or type(ack.get('revision')) is not int or not 0 < ack['revision'] <= MAX_SAFE_INTEGER):
                raise BridgeError('deck_seek_not_confirmed', 'SoundCraft 单轨定位回执无效，请核对实际播放位置', 502)
            revision = ack['revision']
            deadline = time.monotonic() + .8
            while True:
                model, read_reply = self._read_deck_playback(session)
                if model['epoch'] != params['epoch']:
                    raise BridgeError('project_changed', '单轨定位时 SoundCraft 工程已变化，请重新连接', 409)
                applied = model.get('last_seek')
                if isinstance(applied, dict) and type(applied.get('revision')) is int and applied['revision'] >= revision:
                    break
                if time.monotonic() >= deadline:
                    raise BridgeError('deck_seek_not_confirmed', '未收到单轨定位的音频引擎回执，请核对实际位置', 409)
                time.sleep(.025)
            if (applied['revision'] != revision or type(applied.get('track')) is not int or applied['track'] != track
                    or any(type(applied.get(key)) is not int or not 0 <= applied[key] <= MAX_SAFE_INTEGER
                           for key in ('before', 'after'))
                    or type(applied.get('delta')) is not int
                    or not min(offset, 0) <= applied['delta'] <= max(offset, 0)):
                raise BridgeError('deck_seek_not_confirmed', 'SoundCraft 返回的定位结果与请求不一致，请核对实际位置', 409)
            result = self._public_deck_playback(identity, model, read_reply)
            result['result']['seek'] = {
                'track': track, 'beforeSeconds': applied['before'] / rate, 'afterSeconds': applied['after'] / rate,
                'deltaSeconds': applied['delta'] / rate,
            }
            return result
        except BridgeError as error:
            error.may_have_executed = True
            raise

    def _rate_model(self, identity, tracks=None):
        try:
            reply = self.call('engine.execute', {'command': 'playback.rate.inspect',
                                                'params': {'tracks': tracks} if tracks is not None else {}})
        except BridgeError as error:
            if error.code == 'engine_error' and 'unknown command' in str(error).lower():
                raise BridgeError('rate_unsupported', '当前 SoundCraft 未提供音轨变速接口，请用 GazeDeck 扩展版启动', 409) from error
            raise
        value = reply.get('result')
        if (not isinstance(value, dict) or value.get('version') != 1 or type(value.get('version')) is not int
                or value.get('policy') != RATE_POLICY or value.get('min_rate') != .5 or value.get('max_rate') != 2
                or not isinstance(value.get('epoch'), str) or not 0 < len(value['epoch']) <= 256
                or not isinstance(value.get('tracks'), list)):
            raise BridgeError('invalid_rate_reply', 'SoundCraft 变速接口版本或状态无效；不会退回片段拉伸接口', 502)
        seen = set()
        for entry in value['tracks']:
            if (not isinstance(entry, dict) or set(entry) != {'track', 'rate', 'revision', 'loop'}
                    or type(entry.get('track')) is not int or entry['track'] not in identity['trackIds']
                    or entry['track'] in seen or not valid_rate_state({k: entry.get(k) for k in ('rate', 'revision', 'loop')})):
                raise BridgeError('invalid_rate_reply', 'SoundCraft 音轨倍率或版本编号无效', 502)
            seen.add(entry['track'])
        if tracks is not None and seen != set(tracks):
            raise BridgeError('invalid_rate_reply', 'SoundCraft 未返回全部目标音轨的变速状态', 502)
        return value, reply

    @staticmethod
    def _rate_actual(status, identity):
        if not isinstance(status, dict) or not isinstance(status.get('track_rates'), list):
            raise BridgeError('rate_audio_unavailable', 'SoundCraft 音频回调尚未提供实际变速状态，请用扩展版启动并检查音频输出', 409)
        seen, out = set(), []
        for entry in status['track_rates']:
            if (not isinstance(entry, dict) or type(entry.get('track')) is not int
                    or entry['track'] not in identity['trackIds'] or entry['track'] in seen
                    or not isinstance(entry.get('epoch'), str) or not 0 < len(entry['epoch']) <= 256
                    or not valid_rate(entry.get('rate')) or type(entry.get('revision')) is not int
                    or not 0 <= entry['revision'] <= MAX_SAFE_INTEGER
                    or not valid_rate_loop({'start': entry.get('loop_start'), 'end': entry.get('loop_end')})
                    or type(entry.get('source_position')) not in (int, float)
                    or not math.isfinite(entry['source_position'])
                    or not entry['loop_start'] <= entry['source_position'] < entry['loop_end']):
                raise BridgeError('invalid_rate_reply', 'SoundCraft 实际变速或音源播放位置无效', 502)
            seen.add(entry['track'])
            out.append(copy.deepcopy(entry))
        return out

    def _reset_runtime_loop_rates(self, identity, target_loop=None):
        """Clear native independent wraps before changing the global loop policy.

        Only the explicit old-engine unsupported reply permits the legacy path.
        A clear is sent once; any callback delay is handled with read-only polls.
        """
        try:
            model, _ = self._rate_model(identity)
        except BridgeError as error:
            if error.code == 'rate_unsupported':
                return None
            raise
        configured = [entry for entry in model['tracks'] if entry['revision'] > 0]
        if not configured or target_loop is not None and all(entry['loop'] == target_loop for entry in configured):
            return None
        current, session, _ = self._session_identity('full')
        if current != identity:
            raise BridgeError('project_changed', '工程已变化，未清除其他工程的独立循环', 409)
        if session['transport']['playing'] or session['transport'].get('recording') is True:
            raise BridgeError('pause_required', '请先暂停并结束录音，再清除独立音源循环及恢复 1×', 409)
        status = self.call('ui.inspect')['result']
        self._rate_actual(status, identity)
        invariants, wrote = self._rate_invariants(session), False
        try:
            reply = self.call('engine.execute', {'command': 'playback.rate.clear', 'params': {'epoch': model['epoch']}})
            wrote = True
            ack = reply.get('result')
            if (not isinstance(ack, dict) or ack.get('version') != 1 or ack.get('policy') != RATE_POLICY
                    or ack.get('changed') is not True or not isinstance(ack.get('epoch'), str)
                    or not 0 < len(ack['epoch']) <= 256 or ack['epoch'] == model['epoch']):
                raise BridgeError('rate_clear_not_confirmed', '独立音源循环清除回执无效；未自动重发，请重新连接核对', 502, True)
            expected = [{'track': entry['track'], 'rate': 1, 'revision': 0, 'loop': None} for entry in model['tracks']]
            if (not isinstance(ack.get('tracks'), list) or any(not isinstance(entry, dict) for entry in ack['tracks'])
                    or sorted(ack['tracks'], key=lambda entry: entry.get('track', -1)) != sorted(expected, key=lambda entry: entry['track'])):
                raise BridgeError('rate_clear_not_confirmed', 'SoundCraft 未确认全部音轨恢复 1×；未自动重发', 502, True)
            for attempt in range(8):
                current, readback, _ = self._session_identity('full')
                after, _ = self._rate_model(identity)
                status = self.call('ui.inspect')['result']
                actual = self._rate_actual(status, identity)
                if (current != identity or after['epoch'] != ack['epoch']
                        or sorted(after['tracks'], key=lambda entry: entry['track']) != sorted(expected, key=lambda entry: entry['track'])
                        or self._rate_invariants(readback) != invariants):
                    raise BridgeError('rate_clear_not_confirmed', '清除独立循环时工程或参数发生变化，请重新连接核对', 409, True)
                if not actual and status.get('track_rates_epoch') == ack['epoch']:
                    return {'epoch': ack['epoch'], 'trackIds': [entry['track'] for entry in configured], 'rate': 1,
                            'independentLoopCleared': True}
                if attempt == 7:
                    raise BridgeError('rate_clear_not_applied', '音频回调尚未确认独立音源循环已清除；未自动重发，请重新连接核对', 502, True)
                time.sleep(.025)
        except BridgeError as error:
            error.may_have_executed = error.may_have_executed or wrote
            raise

    def rates(self):
        if not self._lock.acquire(timeout=.2):
            raise BridgeError('busy', 'SoundCraft 正在处理上一请求，请稍后重试', 503)
        try:
            identity, session, _ = self._session_identity()
            model, reply = self._rate_model(identity)
            status = self.call('ui.inspect')['result']
            actual = self._rate_actual(status, identity)
            current, _, _ = self._session_identity()
            if current != identity:
                raise BridgeError('project_changed', '读取变速状态时工程已变化，请重新连接', 409)
            latest, _ = self._rate_model(identity)
            if latest['epoch'] != model['epoch']:
                raise BridgeError('project_changed', '读取变速状态时工程已重新打开，请重新连接', 409)
            # A parameter update can legitimately arrive between these reads.
            # Return its desired state with the separately labelled callback
            # snapshot rather than falsely presenting the desired value as applied.
            model = latest
            return {**reply, 'result': self._public_rates(identity, model, status, actual, session)}
        finally:
            self._lock.release()

    def _public_rates(self, identity, model, status, actual, session):
        device = status.get('audio_device') if isinstance(status.get('audio_device'), str) else ''
        length, rate = session.get('length_samples'), session.get('sample_rate')
        source_loop, origin = None, 'project'
        if (self.loop_pin and all(self.loop_pin.get(key) == identity[key] for key in ('projectPath', 'projectName', 'trackIds'))
                and self.loop_pin.get('sampleRate') == rate and self.loop_pin.get('end') == length):
            source_loop, origin = {'start': self.loop_pin['start'], 'end': self.loop_pin['end']}, 'fixed_pin'
        selection = session.get('selection')
        if source_loop is None and isinstance(selection, dict):
            candidate = {key: selection.get(key) for key in ('start', 'end')}
            if valid_rate_loop(candidate) and type(length) is int and candidate['end'] <= length:
                source_loop, origin = candidate, 'selection'
        if source_loop is None and type(length) is int and 0 < length <= MAX_SAFE_INTEGER:
            source_loop = {'start': 0, 'end': length}
        return {**copy.deepcopy(model), **identity, 'projectKey': self._rate_project_key(identity),
                'applied': actual, 'engineAudioReady': status.get('audio_ready') is True, 'audioDevice': device,
                'sourceLoop': source_loop, 'sourceLoopOrigin': origin,
                'lengthSamples': length, 'sampleRate': rate}

    @staticmethod
    def _rate_invariants(session):
        tracks = copy.deepcopy(session['tracks'])
        for track in tracks:
            track.pop('playback_rate', None)
        transport = session['transport']
        return {'tracks': tracks, 'selection': session.get('selection'), 'tempo': session.get('tempo'),
                'sample_rate': session.get('sample_rate'), 'length_samples': session.get('length_samples'),
                'playing': transport['playing'], 'recording': transport.get('recording', False),
                'position': None if transport['playing'] else transport.get('position')}

    def _set_track_rate(self, params):
        identity, session, _ = self._session_identity('full')
        if any(params[key] != identity[key] for key in ('projectPath', 'projectName')) or sorted(params['trackIds']) != identity['trackIds']:
            raise BridgeError('project_changed', 'SoundCraft 工程或轨道已变化，请重新连接', 409)
        if session['transport'].get('recording') is True:
            raise BridgeError('recording_active', 'SoundCraft 正在录音，暂不修改播放倍率，请先结束录音', 409)
        length = session.get('length_samples')
        if type(length) is not int or not 0 < length <= MAX_SAFE_INTEGER or params['loop']['end'] > length:
            raise BridgeError('invalid_rate_loop', '独立音源循环范围超出当前工程内容范围', 409)
        model, _ = self._rate_model(identity)
        if model['epoch'] != params['epoch']:
            raise BridgeError('rate_changed', 'SoundCraft 工程已重新打开或变速会话已变化，请重新连接', 409)
        by_id = {entry['track']: entry for entry in model['tracks']}
        previous = []
        for update in params['updates']:
            before = by_id.get(update['track'])
            if before is None or {key: before[key] for key in ('rate', 'revision', 'loop')} != update['expected']:
                raise BridgeError('rate_changed', '音轨倍率或循环范围已在其他位置变化，请重新读取；未覆盖外部修改', 409)
            previous.append(copy.deepcopy(before))
            if before['revision'] == MAX_SAFE_INTEGER and (before['rate'] != update['rate'] or before['loop'] != params['loop']):
                raise BridgeError('rate_version_exhausted', '音轨变速版本编号已超出网页精确范围，请重新打开工程后再连接', 409)
        status = self.call('ui.inspect')['result']
        self._rate_actual(status, identity)  # Require the extended audio callback before any write.
        if status.get('audio_ready') is not True:
            raise BridgeError('rate_audio_unavailable', 'SoundCraft 尚无可用音频输出，未发送播放倍率修改；请检查音频设备', 409)
        invariants = self._rate_invariants(session)
        changed_expected = any(update['rate'] != update['expected']['rate'] or params['loop'] != update['expected']['loop']
                               for update in params['updates'])
        request = {'epoch': params['epoch'], 'loop': params['loop'], 'updates': params['updates']}
        wrote = False
        try:
            reply = self.call('engine.execute', {'command': 'playback.rate.set', 'params': request})
            wrote = True
            ack = reply.get('result')
            targets = [update['track'] for update in params['updates']]
            if (not isinstance(ack, dict) or type(ack.get('changed')) is not bool or ack['changed'] != changed_expected
                    or ack.get('epoch') != params['epoch'] or ack.get('version') != 1 or ack.get('policy') != RATE_POLICY
                    or not isinstance(ack.get('tracks'), list) or len(ack['tracks']) != len(targets)):
                raise BridgeError('rate_not_confirmed', 'SoundCraft 未确认音轨倍率请求；未自动重发，请重新连接核对', 502, True)
            expected = {}
            for update in params['updates']:
                before = update['expected']
                revision = before['revision'] + int(before['rate'] != update['rate'] or before['loop'] != params['loop'])
                expected[update['track']] = {'track': update['track'], 'rate': update['rate'], 'revision': revision, 'loop': params['loop']}
            if len({entry.get('track') for entry in ack['tracks'] if isinstance(entry, dict)}) != len(targets) or any(
                    not isinstance(entry, dict) or entry != expected.get(entry.get('track')) for entry in ack['tracks']):
                raise BridgeError('rate_not_confirmed', 'SoundCraft 倍率或版本回执不符；未自动重发', 502, True)
            for attempt in range(8):
                current, readback, _ = self._session_identity('full')
                after, _ = self._rate_model(identity)
                status = self.call('ui.inspect')['result']
                actual = self._rate_actual(status, identity)
                if (current != identity or after['epoch'] != params['epoch'] or self._rate_invariants(readback) != invariants):
                    raise BridgeError('rate_not_confirmed', '工程、播放或循环选区在变速时变化，请重新连接核对', 409, True)
                after_by_id = {entry['track']: entry for entry in after['tracks']}
                if any(after_by_id.get(track) != expected.get(track, entry) for track, entry in by_id.items()) or set(after_by_id) != set(by_id):
                    raise BridgeError('rate_not_confirmed', '实际音轨倍率已变化，请重新连接核对；未覆盖其他修改', 409, True)
                applied = {entry['track']: entry for entry in actual}
                if all(track in applied and applied[track]['epoch'] == params['epoch'] and applied[track]['revision'] == entry['revision']
                       and applied[track]['rate'] == entry['rate'] and applied[track]['loop_start'] == entry['loop']['start']
                       and applied[track]['loop_end'] == entry['loop']['end'] for track, entry in expected.items()):
                    result = self._public_rates(identity, after, status, actual, readback)
                    result.update(changed=ack['changed'], updated=targets, previous=previous)
                    return {**reply, 'result': result}
                if any(track in applied and applied[track]['epoch'] == params['epoch'] and applied[track]['revision'] > entry['revision'] for track, entry in expected.items()) or attempt == 7:
                    raise BridgeError('rate_not_applied', '音频回调尚未确认所请求的倍率版本，请重新连接核对；未自动重发', 502, True)
                time.sleep(.025)
        except BridgeError as error:
            error.may_have_executed = error.may_have_executed or wrote
            raise

    @staticmethod
    def _validate_effect_model(value, identity, session):
        invalid = lambda: BridgeError('invalid_effect_reply', 'SoundCraft 效果器接口版本、插槽或参数无效', 502)
        if (not isinstance(value, dict) or type(value.get('version')) is not int or value['version'] != 1
                or not isinstance(value.get('epoch'), str) or not 0 < len(value['epoch']) <= 256
                or not isinstance(value.get('definitions'), list) or len(value['definitions']) != 3
                or not isinstance(value.get('tracks'), list)):
            raise invalid()
        definitions = {}
        for definition in value['definitions']:
            if (not isinstance(definition, dict)
                    or set(definition) != {'effect', 'plugin', 'param', 'defaultAmount', 'min', 'max'}
                    or not isinstance(definition.get('effect'), str) or definition['effect'] not in EFFECT_PLUGINS
                    or definition['effect'] in definitions or definition['plugin'] != EFFECT_PLUGINS[definition['effect']]
                    or definition['param'] != 'mix' or not valid_effect_amount(definition['defaultAmount'])
                    or type(definition['min']) not in (int, float) or definition['min'] != 0
                    or type(definition['max']) not in (int, float) or definition['max'] != 1):
                raise invalid()
            definitions[definition['effect']] = definition
        seen = set()
        for entry in value['tracks']:
            if (not isinstance(entry, dict) or set(entry) != {'track', 'effects'}
                    or type(entry.get('track')) is not int or entry['track'] not in identity['trackIds']
                    or entry['track'] in seen or not isinstance(entry.get('effects'), list) or len(entry['effects']) != 3):
                raise invalid()
            seen.add(entry['track'])
            effects = set()
            for row in entry['effects']:
                if (not isinstance(row, dict) or set(row) != {'effect', 'slot', 'insert', 'enabled', 'amount', 'available', 'reason'}
                        or not isinstance(row.get('effect'), str) or row['effect'] not in definitions or row['effect'] in effects
                        or type(row['enabled']) is not bool or type(row['available']) is not bool
                        or not valid_effect_amount(row['amount']) or not isinstance(row['reason'], str) or len(row['reason']) > 1024
                        or row['available'] and (row['reason'] != '' or row['slot'] is None)
                        or not row['available'] and row['reason'] == ''
                        or (row['slot'] is not None and (type(row['slot']) is not int or not 0 <= row['slot'] <= 9))
                        or (row['insert'] is not None and (row['slot'] is None
                            or not valid_effect_insert(row['insert'], row['effect'], read_only=not row['available'])))):
                    raise invalid()
                effects.add(row['effect'])
                insert = row['insert']
                amount = insert['params'].get('mix', definitions[row['effect']]['defaultAmount'] * 100) / 100 if insert else definitions[row['effect']]['defaultAmount']
                amount = max(0, min(1, amount))
                if (row['available'] and row['enabled'] != (insert is not None and not insert['bypass'])
                        or row['enabled'] and (insert is None or insert['bypass']) or abs(row['amount'] - amount) > 1e-7):
                    raise invalid()
        audio_ids = {track['id'] for track in session['tracks'] if track.get('kind') == 'audio'}
        if seen != audio_ids:
            raise invalid()
        return value

    def _effect_model(self, identity, session):
        try:
            reply = self.call('engine.execute', {'command': 'mix.effects.inspect', 'params': {}})
        except BridgeError as error:
            if error.code == 'engine_error' and 'unknown command' in str(error).lower():
                raise BridgeError('effects_unsupported', '当前 SoundCraft 未提供真实效果器事务接口，请用 GazeDeck 扩展版启动', 409) from error
            raise
        return self._validate_effect_model(reply.get('result'), identity, session), reply

    def _public_effects(self, identity, model, status):
        if not isinstance(status, dict):
            raise BridgeError('invalid_effect_reply', 'SoundCraft 音频输出状态无效', 502)
        return {**copy.deepcopy(model), **identity, 'projectKey': self._rate_project_key(identity),
                'engineAudioReady': status.get('audio_ready') is True,
                'audioDevice': status.get('audio_device') if isinstance(status.get('audio_device'), str) else ''}

    def effects(self):
        if not self._lock.acquire(timeout=.2):
            raise BridgeError('busy', 'SoundCraft 正在处理上一请求，请稍后重试', 503)
        try:
            identity, session, _ = self._session_identity('full')
            model, reply = self._effect_model(identity, session)
            status = self.call('ui.inspect')['result']
            current, latest_session, _ = self._session_identity('full')
            if current != identity:
                raise BridgeError('project_changed', '读取效果器时工程已变化，请重新连接', 409)
            latest, _ = self._effect_model(identity, latest_session)
            if latest['epoch'] != model['epoch']:
                raise BridgeError('project_changed', '读取效果器时工程已重新打开，请重新连接', 409)
            return {**reply, 'result': self._public_effects(identity, latest, status)}
        finally:
            self._lock.release()

    @staticmethod
    def _effect_rows(model):
        return {(entry['track'], row['effect']): row for entry in model['tracks'] for row in entry['effects']}

    @staticmethod
    def _effect_invariants(session, updates):
        # Inspect exposes undo bookkeeping. Everything else, including unknown
        # future document fields, remains protected except natural playing time.
        snapshot = copy.deepcopy(session)
        for key in ('dirty', 'undo', 'redo'):
            snapshot.pop(key, None)
        slots = {(update['track'], update['slot']) for update in updates}
        for track in snapshot['tracks']:
            if any(track['id'] == track_id for track_id, _ in slots):
                track['inserts'] = [insert for insert in track['inserts'] if (track['id'], insert['slot']) not in slots]
        if snapshot['transport']['playing']:
            snapshot['transport'].pop('position', None)
        return snapshot

    @staticmethod
    def _effect_insert_equal(actual, expected, wet_epsilon=False, restore_f32=False):
        if actual is None or expected is None:
            return actual is expected
        if (actual['plugin'] != expected['plugin'] or actual['bypass'] != expected['bypass']
                or set(actual['params']) != set(expected['params'])):
            return False
        for key, number in expected['params'].items():
            value = actual['params'][key]
            if wet_epsilon and key == 'mix':
                if abs(value - number) > 1e-5:
                    return False
            elif restore_f32:
                if struct.pack('f', value) != struct.pack('f', number):
                    return False
            elif value != number:
                return False
        return True

    @staticmethod
    def _effect_insert_metadata(track, slot):
        insert = next((item for item in track['inserts'] if item['slot'] == slot), None)
        return {key: copy.deepcopy(value) for key, value in insert.items() if key not in {'plugin', 'bypass', 'params'}} if insert else None

    def _edit_effect(self, params, restore=False):
        identity, session, _ = self._session_identity('full')
        if any(params[key] != identity[key] for key in ('projectPath', 'projectName')) or sorted(params['trackIds']) != identity['trackIds']:
            raise BridgeError('project_changed', 'SoundCraft 工程或轨道已变化，请重新连接', 409)
        if session['transport'].get('recording') is True:
            raise BridgeError('recording_active', 'SoundCraft 正在录音，暂不修改效果器，请先结束录音', 409)
        effect, updates = params['effect'], params['updates']
        model, _ = self._effect_model(identity, session)
        if model['epoch'] != params['epoch']:
            raise BridgeError('effect_changed', 'SoundCraft 工程已重新打开或效果器会话已变化，请重新读取', 409)
        rows, tracks = self._effect_rows(model), {track['id']: track for track in session['tracks']}
        for update in updates:
            row = rows.get((update['track'], effect))
            if (not row or not row['available'] or row['slot'] != update['slot'] or row['insert'] != update['expectedInsert']
                    or self._eq_slot(tracks[update['track']], update['slot']) != update['expectedInsert']):
                raise BridgeError('effect_changed', '效果器插槽不可用或已在其他位置变化，请重新读取；未覆盖外部修改', 409)
        rates, _ = self._rate_model(identity)
        status = self.call('ui.inspect')['result']
        if not isinstance(status, dict) or status.get('audio_ready') is not True:
            raise BridgeError('effects_audio_unavailable', 'SoundCraft 尚无可用音频输出，未发送效果器修改；请检查音频设备', 409)
        invariants = self._effect_invariants(session, updates)
        current, preflight, _ = self._session_identity('full')
        current_model, _ = self._effect_model(identity, preflight)
        if (current != identity or current_model != model or self._effect_invariants(preflight, updates) != invariants
                or any(self._eq_slot(next(track for track in preflight['tracks'] if track['id'] == update['track']), update['slot'])
                       != update['expectedInsert'] for update in updates)):
            raise BridgeError('effect_changed', '工程或效果器参数在提交前变化，请重新读取；未覆盖外部修改', 409)
        request = {'epoch': params['epoch'], 'effect': effect, 'updates': updates}
        wrote = False
        try:
            reply = self.call('engine.execute', {'command': 'mix.effects.restore' if restore else 'mix.effects.set', 'params': request})
            wrote = True
            ack = self._validate_effect_model(reply.get('result'), identity, preflight)
            if (ack.get('epoch') != params['epoch'] or ack.get('definitions') != model['definitions']
                    or ack.get('effect') != effect or type(ack.get('changed')) is not bool
                    or not isinstance(ack.get('updated'), list) or any(type(track) is not int for track in ack['updated'])
                    or len(set(ack['updated'])) != len(ack['updated'])):
                raise BridgeError('effect_not_confirmed', 'SoundCraft 未确认效果器事务；未自动重发，请重新连接核对', 502, True)
            snapshots = {}
            for name in ('previous', 'after'):
                items = ack.get(name)
                if not isinstance(items, list):
                    raise BridgeError('effect_not_confirmed', 'SoundCraft 效果器回执缺少完整前后参数', 502, True)
                found = {}
                for item in items:
                    if (not isinstance(item, dict) or set(item) != {'track', 'slot', 'insert'}
                            or type(item.get('track')) is not int or item['track'] in found
                            or type(item.get('slot')) is not int or not 0 <= item['slot'] <= 9
                            or (item['insert'] is not None and not valid_effect_insert(item['insert'], effect))):
                        raise BridgeError('effect_not_confirmed', 'SoundCraft 效果器回执插槽或参数无效', 502, True)
                    found[item['track']] = item
                snapshots[name] = found
            desired, changed = {}, set()
            f32 = lambda number: struct.unpack('f', struct.pack('f', number))[0]
            for update in updates:
                before = update['expectedInsert']
                if restore:
                    target = copy.deepcopy(update['restoreInsert'])
                    if target is not None:
                        target['params'] = {key: f32(number) for key, number in target['params'].items()}
                elif before is not None:
                    target = copy.deepcopy(before)
                    target['bypass'] = not update['enabled']
                    default_amount = next(item['defaultAmount'] for item in model['definitions'] if item['effect'] == effect)
                    wet = f32(update['amount'] * 100)
                    if f32(before['params'].get('mix', default_amount * 100)) != wet:
                        target['params']['mix'] = wet
                elif update['enabled']:
                    target = snapshots['after'].get(update['track'], {}).get('insert')
                    if (not valid_effect_insert(target, effect) or target['bypass'] is not False
                            or 'mix' not in target['params'] or abs(target['params']['mix'] - update['amount'] * 100) > 1e-5):
                        raise BridgeError('effect_not_confirmed', 'SoundCraft 未确认所请求的效果量与启用状态', 502, True)
                else:
                    target = None  # Turning off an absent effect never creates an insert.
                desired[update['track']] = {'track': update['track'], 'slot': update['slot'], 'insert': target}
                if not self._effect_insert_equal(before, target, restore_f32=restore):
                    changed.add(update['track'])
            expected_previous = {update['track']: {'track': update['track'], 'slot': update['slot'], 'insert': update['expectedInsert']}
                                 for update in updates if update['track'] in changed}
            if (ack['changed'] != bool(changed) or set(ack['updated']) != changed or snapshots['previous'] != expected_previous
                    or set(snapshots['after']) != changed
                    or any(snapshots['after'][track]['slot'] != desired[track]['slot']
                           or not self._effect_insert_equal(snapshots['after'][track]['insert'], desired[track]['insert'],
                                                            wet_epsilon=not restore, restore_f32=restore) for track in changed)):
                raise BridgeError('effect_not_confirmed', 'SoundCraft 效果器前后状态或变更列表不符；未自动重发', 502, True)
            ack_model = {key: copy.deepcopy(ack[key]) for key in ('version', 'epoch', 'definitions', 'tracks')}
            for attempt in range(3):
                current, readback, _ = self._session_identity('full')
                after, _ = self._effect_model(identity, readback)
                after_rates, _ = self._rate_model(identity)
                status = self.call('ui.inspect')['result']
                if (current != identity or after['epoch'] != params['epoch'] or after_rates != rates
                        or self._effect_invariants(readback, updates) != invariants
                        or not isinstance(status, dict) or status.get('audio_ready') is not True):
                    raise BridgeError('effect_not_confirmed', '工程、轨道、播放、循环或倍率在修改效果器时变化，请重新连接核对', 409, True)
                after_rows = self._effect_rows(after)
                # New first-empty slots can move after inserting/removing a plugin.
                # Other effects' semantic insert state remains protected.
                for key, before_row in rows.items():
                    if key[0] in desired and key[1] == effect:
                        continue
                    actual_row = after_rows.get(key)
                    if actual_row is None or any(actual_row[field] != before_row[field] for field in ('effect', 'insert', 'enabled', 'amount')):
                        raise BridgeError('effect_not_confirmed', '其他音轨或效果器参数在修改时变化，请重新连接核对', 409, True)
                confirmed = after == ack_model
                for update in updates:
                    track = next(track for track in readback['tracks'] if track['id'] == update['track'])
                    actual = self._eq_slot(track, update['slot'])
                    if update['expectedInsert'] is not None and desired[update['track']]['insert'] is not None:
                        if self._effect_insert_metadata(track, update['slot']) != self._effect_insert_metadata(tracks[update['track']], update['slot']):
                            raise BridgeError('effect_not_confirmed', '目标效果器的受保护元数据在修改时变化，请重新连接核对', 409, True)
                    confirmed = confirmed and self._effect_insert_equal(actual, desired[update['track']]['insert'],
                                                                       wet_epsilon=not restore, restore_f32=restore)
                if confirmed:
                    result = self._public_effects(identity, after, status)
                    result.update(effect=effect, changed=ack['changed'], updated=ack['updated'], previous=ack['previous'], after=ack['after'])
                    return {**reply, 'result': result}
                if attempt == 2:
                    raise BridgeError('effect_not_confirmed', 'SoundCraft 实际效果量尚未确认或已变化，请重新连接；未自动重发', 502, True)
                time.sleep(.025)
        except BridgeError as error:
            error.may_have_executed = error.may_have_executed or wrote
            raise

    @staticmethod
    def _tone_insert_list(track):
        inserts = track.get('inserts')
        if not isinstance(inserts, list):
            raise BridgeError('invalid_tone_reply', 'SoundCraft 未返回完整插件插槽', 502)
        try:
            values = [{key: copy.deepcopy(row[key]) for key in ('slot', 'plugin', 'bypass', 'params')} for row in inserts]
        except (TypeError, KeyError) as error:
            raise BridgeError('invalid_tone_reply', 'SoundCraft 插槽结构无效', 502) from error
        if not valid_tone_inserts(values):
            raise BridgeError('invalid_tone_reply', 'SoundCraft 插槽参数无效', 502)
        return sorted(values, key=lambda row: row['slot'])

    @staticmethod
    def _tone_close(actual, desired, inserts):
        # Absent disabled plugins carry no hidden value. Their displayed parameters
        # stay at native defaults, even if a portable preset has other disabled values.
        by_plugin = {row['plugin']: row for row in inserts}
        eq = by_plugin.get('eq_7band')
        if actual['eq']['enabled'] != desired['eq']['enabled']:
            return False
        if eq and any(abs(actual['eq'][band] - desired['eq'][band]) > 1e-5 for band in EQ_BANDS):
            return False
        for effect, plugin in EFFECT_PLUGINS.items():
            if actual['effects'][effect]['enabled'] != desired['effects'][effect]['enabled']:
                return False
            if plugin in by_plugin and abs(actual['effects'][effect]['amount'] - desired['effects'][effect]['amount']) > 1e-7:
                return False
        return True

    @classmethod
    def _validate_tone_model(cls, value, identity, session):
        invalid = lambda: BridgeError('invalid_tone_reply', 'SoundCraft 音色预设接口版本、音轨或参数无效', 502)
        if (not isinstance(value, dict) or type(value.get('version')) is not int or value['version'] != 1
                or not isinstance(value.get('epoch'), str) or not 0 < len(value['epoch']) <= 256
                or not isinstance(value.get('tracks'), list)):
            raise invalid()
        audio = {track['id']: track for track in session['tracks'] if track.get('kind') == 'audio'}
        seen = set()
        for row in value['tracks']:
            if (not isinstance(row, dict) or set(row) != {'track', 'available', 'reason', 'tone', 'inserts'}
                    or type(row.get('track')) is not int or row['track'] not in audio or row['track'] in seen
                    or type(row.get('available')) is not bool or not isinstance(row.get('reason'), str)
                    or len(row['reason']) > 1024 or row['available'] != (row['reason'] == '')
                    or not valid_tone(row.get('tone')) or not valid_tone_inserts(row.get('inserts'))):
                raise invalid()
            seen.add(row['track'])
            actual_inserts = cls._tone_insert_list(audio[row['track']])
            if sorted(row['inserts'], key=lambda item: item['slot']) != actual_inserts:
                raise invalid()
            if not row['available']:
                continue
            by_plugin = {plugin: [item for item in actual_inserts if item['plugin'] == plugin] for plugin in TONE_PLUGINS}
            if any(len(items) > 1 for items in by_plugin.values()):
                raise invalid()
            eq = next(iter(by_plugin['eq_7band']), None)
            expected = {'eq': {'enabled': eq is not None and not eq['bypass'],
                                **{band: eq['params'].get(param, 0) if eq else 0 for band, param in EQ_BANDS.items()}},
                        'effects': {}}
            for effect, plugin in EFFECT_PLUGINS.items():
                item = next(iter(by_plugin[plugin]), None)
                expected['effects'][effect] = {'enabled': item is not None and not item['bypass'],
                    'amount': item['params'].get('mix', TONE_DEFAULT_AMOUNTS[effect] * 100) / 100 if item else TONE_DEFAULT_AMOUNTS[effect]}
            if (not valid_tone(expected) or row['tone']['eq']['enabled'] != expected['eq']['enabled']
                    or any(abs(row['tone']['eq'][band] - expected['eq'][band]) > 1e-5 for band in EQ_BANDS)
                    or any(row['tone']['effects'][effect]['enabled'] != expected['effects'][effect]['enabled']
                           or abs(row['tone']['effects'][effect]['amount'] - expected['effects'][effect]['amount']) > 1e-7
                           for effect in EFFECT_PLUGINS)):
                raise invalid()
        if seen != set(audio):
            raise invalid()
        return value

    def _tone_model(self, identity, session):
        try:
            reply = self.call('engine.execute', {'command': 'mix.tone.inspect', 'params': {}})
        except BridgeError as error:
            if error.code == 'engine_error' and 'unknown command' in str(error).lower():
                raise BridgeError('tone_unsupported', '当前 SoundCraft 未提供原子音色预设接口，请用最新 GazeDeck 控制模式启动', 409) from error
            raise
        return self._validate_tone_model(reply.get('result'), identity, session), reply

    def _public_tone(self, identity, model, status):
        if not isinstance(status, dict):
            raise BridgeError('invalid_tone_reply', 'SoundCraft 音频输出状态无效', 502)
        return {**copy.deepcopy(model), **identity, 'projectKey': self._rate_project_key(identity),
                'engineAudioReady': status.get('audio_ready') is True,
                'audioDevice': status.get('audio_device') if isinstance(status.get('audio_device'), str) else ''}

    def tone(self):
        if not self._lock.acquire(timeout=.2):
            raise BridgeError('busy', 'SoundCraft 正在处理上一请求，请稍后重试', 503)
        try:
            identity, session, _ = self._session_identity('full')
            model, reply = self._tone_model(identity, session)
            status = self.call('ui.inspect')['result']
            current, session, _ = self._session_identity('full')
            latest, _ = self._tone_model(current, session)
            if current != identity or model['epoch'] != latest['epoch']:
                raise BridgeError('project_changed', '读取音色时工程或会话已变化，请重新连接', 409)
            return {**reply, 'result': self._public_tone(identity, latest, status)}
        finally:
            self._lock.release()

    @staticmethod
    def _tone_invariants(session, slots):
        snapshot = copy.deepcopy(session)
        for key in ('dirty', 'undo', 'redo'):
            snapshot.pop(key, None)
        for track in snapshot['tracks']:
            track['inserts'] = [row for row in track['inserts'] if (track['id'], row['slot']) not in slots]
        if snapshot['transport']['playing']:
            snapshot['transport'].pop('position', None)
        return snapshot

    @staticmethod
    def _tone_changes(before_session, after_session):
        def slots(session):
            return {(track['id'], insert['slot']): copy.deepcopy(insert)
                    for track in session['tracks'] for insert in track['inserts']}
        before, after = slots(before_session), slots(after_session)
        return {key: {'before': before.get(key), 'after': after.get(key)}
                for key in before.keys() | after.keys() if before.get(key) != after.get(key)}

    @staticmethod
    def _check_tone_insert_change(before, after):
        if after is None:
            return False  # Applying a preset never removes an existing insert.
        if before is None:
            return after['plugin'] in TONE_PLUGINS
        if before['plugin'] != after['plugin'] or before['slot'] != after['slot']:
            return False
        allowed = set(EQ_BANDS.values()) if before['plugin'] == 'eq_7band' else {'mix'}
        if before['plugin'] not in TONE_PLUGINS:
            return False
        def protected(insert):
            value = copy.deepcopy(insert)
            value.pop('bypass', None)
            value['params'] = {key: number for key, number in value['params'].items() if key not in allowed}
            return value
        return protected(before) == protected(after)

    def _edit_tone(self, params, restore=False):
        identity, session, _ = self._session_identity('full')
        if any(params[key] != identity[key] for key in ('projectPath', 'projectName')) or sorted(params['trackIds']) != identity['trackIds']:
            raise BridgeError('project_changed', 'SoundCraft 工程或音轨已变化，请重新连接', 409)
        if session['transport'].get('recording') is True:
            raise BridgeError('recording_active', 'SoundCraft 正在录音，暂不应用音色预设', 409)
        model, _ = self._tone_model(identity, session)
        if model['epoch'] != params['epoch']:
            raise BridgeError('tone_changed', 'SoundCraft 工程已重新打开，请重新读取音色', 409)
        rows = {row['track']: row for row in model['tracks']}
        stored = self._tone_receipts.get(params.get('receipt')) if restore else None
        if restore:
            if not stored or stored['identity'] != identity or stored['epoch'] != model['epoch']:
                raise BridgeError('tone_changed', '预设撤回凭据已失效，请重新读取；不会恢复未知历史状态', 409)
            raw = {(track['id'], row['slot']): row for track in session['tracks'] for row in track['inserts']}
            if any(raw.get(key) != change['after'] for key, change in stored['changes'].items()):
                raise BridgeError('tone_changed', '本次预设修改的插件已被外部修改，未覆盖外部参数', 409)
            targets = set(stored['targets'])
        else:
            targets = {update['track'] for update in params['updates']}
            for update in params['updates']:
                row = rows.get(update['track'])
                if not row or not row['available'] or sorted(update['expectedInserts'], key=lambda item: item['slot']) != sorted(row['inserts'], key=lambda item: item['slot']):
                    raise BridgeError('tone_changed', '目标音轨不可用或插件参数已变化，请重新预览', 409)
        if any(not rows.get(track, {}).get('available') for track in targets):
            raise BridgeError('tone_changed', '目标音轨当前不允许修改音色', 409)
        rates, _ = self._rate_model(identity)
        if rates['epoch'] != model['epoch']:
            raise BridgeError('tone_changed', '音色与播放会话标识不一致，请重新连接', 409)
        status = self.call('ui.inspect')['result']
        if not isinstance(status, dict) or status.get('audio_ready') is not True:
            raise BridgeError('tone_audio_unavailable', 'SoundCraft 尚无可用音频输出，未应用预设', 409)
        current, preflight, _ = self._session_identity('full')
        current_model, _ = self._tone_model(current, preflight)
        # Only natural elapsed playing time and bookkeeping may change during reads.
        if (current != identity or current_model != model
                or self._tone_invariants(preflight, set()) != self._tone_invariants(session, set())):
            raise BridgeError('tone_changed', '预览后工程或插件已变化，请重新预览；未发送修改', 409)
        request = {'epoch': params['epoch'], 'receipt': params['receipt']} if restore else {'epoch': params['epoch'], 'updates': params['updates']}
        wrote = False
        try:
            reply = self.call('engine.execute', {'command': 'mix.tone.restore' if restore else 'mix.tone.apply', 'params': request})
            wrote = True
            ack = reply.get('result')
            if (not isinstance(ack, dict) or not {'version', 'epoch', 'tracks', 'changed', 'updated', 'receipt'} <= set(ack)
                    or type(ack.get('changed')) is not bool
                    or not isinstance(ack.get('updated'), list) or any(type(track) is not int or track not in targets for track in ack['updated'])
                    or len(set(ack['updated'])) != len(ack['updated']) or ack['changed'] != bool(ack['updated'])
                    or (ack.get('receipt') is not None if restore or not ack['changed']
                        else not isinstance(ack.get('receipt'), str) or not 0 < len(ack['receipt']) <= 256)):
                raise BridgeError('tone_not_confirmed', 'SoundCraft 音色事务回执无效，未自动重发', 502, True)
            current, readback, _ = self._session_identity('full')
            after, _ = self._tone_model(current, readback)
            after_rates, _ = self._rate_model(current)
            status = self.call('ui.inspect')['result']
            if (current != identity or after['epoch'] != params['epoch'] or rates != after_rates
                    or not isinstance(status, dict) or status.get('audio_ready') is not True):
                raise BridgeError('tone_not_confirmed', '应用音色时工程、倍率或音频输出已变化，请重新连接核对', 409, True)
            validated_ack = self._validate_tone_model(ack, identity, readback)
            if {key: validated_ack[key] for key in ('version', 'epoch', 'tracks')} != after:
                raise BridgeError('tone_not_confirmed', 'SoundCraft 音色回执与实际回读不符，未自动重发', 502, True)
            changes = self._tone_changes(preflight, readback)
            if (set(ack['updated']) != {track for track, _ in changes}
                    or any(track not in targets for track, _ in changes)
                    or self._tone_invariants(preflight, set(changes)) != self._tone_invariants(readback, set(changes))):
                raise BridgeError('tone_not_confirmed', '音色修改影响了受保护状态，请重新连接核对', 409, True)
            if restore:
                if (set(changes) != set(stored['changes'])
                        or any(change['before'] != stored['changes'][key]['after'] or change['after'] != stored['changes'][key]['before']
                               for key, change in changes.items())):
                    raise BridgeError('tone_not_confirmed', '预设撤回未恢复本次修改的精确原值，请核对', 409, True)
                self._tone_receipts.pop(params['receipt'], None)
            else:
                if any(not self._check_tone_insert_change(change['before'], change['after']) for change in changes.values()):
                    raise BridgeError('tone_not_confirmed', '预设修改了频率、效果其他参数或插件元数据，请核对', 409, True)
                after_rows = {row['track']: row for row in after['tracks']}
                if any(not self._tone_close(after_rows[update['track']]['tone'], update['tone'], after_rows[update['track']]['inserts']) for update in params['updates']):
                    raise BridgeError('tone_not_confirmed', 'SoundCraft 未确认请求的预设参数，请核对', 502, True)
                if ack['changed']:
                    self._tone_receipts[ack['receipt']] = {'identity': copy.deepcopy(identity), 'epoch': params['epoch'],
                                                        'targets': sorted(targets), 'changes': changes}
                    while len(self._tone_receipts) > 64:
                        self._tone_receipts.pop(next(iter(self._tone_receipts)))
            result = self._public_tone(identity, after, status)
            result.update(changed=ack['changed'], updated=ack['updated'], receipt=ack.get('receipt'))
            return {**reply, 'result': result}
        except BridgeError as error:
            error.may_have_executed = error.may_have_executed or wrote
            raise

    @staticmethod
    def _validate_level_model(value, identity, session):
        invalid = lambda: BridgeError('invalid_levels_reply', 'SoundCraft 联动音量接口版本、音轨或数值无效', 502)
        if (not isinstance(value, dict) or type(value.get('version')) is not int or value['version'] != 1
                or not isinstance(value.get('epoch'), str) or not 0 < len(value['epoch']) <= 256
                or not isinstance(value.get('tracks'), list)):
            raise invalid()
        audio = {track['id']: track for track in session['tracks'] if track.get('kind') == 'audio'}
        seen = set()
        for row in value['tracks']:
            if (not isinstance(row, dict) or set(row) != {'track', 'db', 'available', 'reason'}
                    or type(row.get('track')) is not int or row['track'] not in audio or row['track'] in seen
                    or not valid_level_db(row.get('db')) or type(row.get('available')) is not bool
                    or not isinstance(row.get('reason'), str) or len(row['reason']) > 1024
                    or row['available'] != (row['reason'] == '')
                    or not valid_level_db(audio[row['track']].get('volume_db'))
                    or abs(row['db'] - audio[row['track']]['volume_db']) > 1e-5):
                raise invalid()
            seen.add(row['track'])
        if seen != set(audio):
            raise invalid()
        return value

    def _level_model(self, identity, session):
        try:
            reply = self.call('engine.execute', {'command': 'mix.level.inspect', 'params': {}})
        except BridgeError as error:
            if error.code == 'engine_error' and 'unknown command' in str(error).lower():
                raise BridgeError('levels_unsupported', '当前 SoundCraft 未提供原子联动音量接口，请使用最新 GazeDeck 控制程序', 409) from error
            raise
        return self._validate_level_model(reply.get('result'), identity, session), reply

    def _public_levels(self, identity, model, status):
        if not isinstance(status, dict):
            raise BridgeError('invalid_levels_reply', 'SoundCraft 音频输出状态无效', 502)
        return {**copy.deepcopy(model), **identity, 'projectKey': self._rate_project_key(identity),
                'engineAudioReady': status.get('audio_ready') is True,
                'audioDevice': status.get('audio_device') if isinstance(status.get('audio_device'), str) else ''}

    def levels(self):
        if not self._lock.acquire(timeout=.2):
            raise BridgeError('busy', 'SoundCraft 正在处理上一请求，请稍后重试', 503)
        try:
            identity, session, _ = self._session_identity('full')
            model, reply = self._level_model(identity, session)
            status = self.call('ui.inspect')['result']
            current, session, _ = self._session_identity('full')
            latest, _ = self._level_model(current, session)
            if current != identity or latest['epoch'] != model['epoch']:
                raise BridgeError('project_changed', '读取联动音量时工程或会话已变化，请重新连接', 409)
            return {**reply, 'result': self._public_levels(identity, latest, status)}
        finally:
            self._lock.release()

    @staticmethod
    def _waveform_context(identity, session, tracks):
        """Only source-envelope dependencies, never fader/FX or advancing time."""
        epoch = session.get('playback_rates', {}).get('epoch') if isinstance(session.get('playback_rates'), dict) else None
        sample_rate, length = session.get('sample_rate'), session.get('length_samples')
        if (not isinstance(epoch, str) or not 0 < len(epoch) <= 256
                or type(sample_rate) is not int or not 0 < sample_rate <= 768000
                or type(length) is not int or not 0 <= length <= MAX_SAFE_INTEGER):
            raise BridgeError('waveforms_unsupported', '当前 SoundCraft 未提供有效波形会话，请使用最新 GazeDeck 控制程序', 409)
        selected = []
        for track_id in tracks:
            track = next((row for row in session['tracks'] if row['id'] == track_id), None)
            if track is None or track.get('kind') != 'audio':
                raise BridgeError('invalid_waveform_track', '波形查询需要当前工程中明确的音频轨道 ID', 409)
            if not isinstance(track.get('name'), str) or len(track['name']) > 4096 or not isinstance(track.get('clips'), list):
                raise BridgeError('invalid_waveforms_reply', 'SoundCraft 轨道或片段元数据无效', 502)
            selected.append({key: copy.deepcopy(track.get(key)) for key in
                             ('id', 'name', 'kind', 'inactive', 'frozen', 'playlist', 'playlists')})
            selected[-1]['clips'] = [{key: copy.deepcopy(clip.get(key)) for key in
                                     ('id', 'name', 'start', 'length', 'source', 'offset', 'stretch', 'muted')}
                                    if isinstance(clip, dict) else None for clip in track['clips']]
        # Source identity and loaded status are dependencies; their private paths
        # are compared in-memory but never included in the public waveform model.
        sources = session.get('sources')
        if not isinstance(sources, list):
            raise BridgeError('invalid_waveforms_reply', 'SoundCraft 音频素材元数据无效', 502)
        used = {clip['source'] for track in selected for clip in track['clips']
                if isinstance(clip, dict) and type(clip.get('source')) is int}
        relevant = [copy.deepcopy(source) for source in sources
                    if isinstance(source, dict) and type(source.get('id')) is int and source['id'] in used]
        return {**identity, 'epoch': epoch, 'sampleRate': sample_rate, 'lengthSamples': length,
                'tracks': selected, 'sources': relevant}

    @staticmethod
    def _validate_waveform_model(value, context, tracks, bins):
        invalid = lambda: BridgeError('invalid_waveforms_reply', 'SoundCraft 波形版本、范围或片段数据无效', 502)
        fields = {'version', 'epoch', 'sampleRate', 'lengthSamples', 'bins', 'kind', 'tracks'}
        if (not isinstance(value, dict) or set(value) != fields
                or type(value.get('version')) is not int or value['version'] != 1
                or value.get('kind') != 'source_envelope_pre_fader'
                or value.get('epoch') != context['epoch']
                or type(value.get('sampleRate')) is not int or value['sampleRate'] != context['sampleRate']
                or type(value.get('lengthSamples')) is not int or value['lengthSamples'] != context['lengthSamples']
                or type(value.get('bins')) is not int or value['bins'] != bins
                or not isinstance(value.get('tracks'), list) or len(value['tracks']) != len(tracks)):
            raise invalid()
        seen = set()
        expected = {row['id']: row for row in context['tracks']}
        for row in value['tracks']:
            if (not isinstance(row, dict) or set(row) != {'track', 'name', 'available', 'reason', 'clips', 'peaks'}
                    or type(row.get('track')) is not int or row['track'] not in expected or row['track'] in seen
                    or row.get('name') != expected[row['track']]['name']
                    or type(row.get('available')) is not bool or not isinstance(row.get('reason'), str)
                    or len(row['reason']) > 1024 or row['available'] != (row['reason'] == '')
                    or not isinstance(row.get('clips'), list) or len(row['clips']) > 64
                    or not isinstance(row.get('peaks'), list) or len(row['peaks']) != bins):
                raise invalid()
            seen.add(row['track'])
            clip_ids = set()
            for clip in row['clips']:
                if (not isinstance(clip, dict) or set(clip) != {'id', 'name', 'start', 'length', 'source', 'offset', 'stretch', 'muted'}
                        or any(type(clip.get(key)) is not int or not 0 < clip[key] <= MAX_SAFE_INTEGER for key in ('id', 'source', 'length'))
                        or any(type(clip.get(key)) is not int or not -MAX_SAFE_INTEGER <= clip[key] <= MAX_SAFE_INTEGER for key in ('start', 'offset'))
                        or clip['id'] in clip_ids or not isinstance(clip.get('name'), str) or len(clip['name']) > 4096
                        or type(clip.get('muted')) is not bool or type(clip.get('stretch')) not in (int, float)
                        or not 0 < clip['stretch'] <= 1.7976931348623157e308 or not math.isfinite(clip['stretch'])):
                    raise invalid()
                clip_ids.add(clip['id'])
            if row['clips'] and row['clips'] != expected[row['track']]['clips']:
                raise invalid()
            if row['available'] and (not row['clips'] or row['clips'] != expected[row['track']]['clips']):
                raise invalid()
            for peak in row['peaks']:
                if peak is None:
                    continue
                if (not row['available'] or not isinstance(peak, list) or len(peak) != 2
                        or any(type(number) not in (int, float) or not -3.4028236e38 <= number <= 3.4028236e38
                               or not math.isfinite(number) for number in peak)
                        or peak[0] > peak[1]):
                    raise invalid()
        if seen != set(tracks):
            raise invalid()
        return value

    def waveforms(self, tracks, bins=256):
        if not valid_waveform_request(tracks, bins):
            raise BridgeError('invalid_params', '波形查询最多两条不同音频轨道，bins 范围为 32–1024')
        if not self._lock.acquire(timeout=.2):
            raise BridgeError('busy', 'SoundCraft 正在处理上一请求，请稍后重试', 503)
        try:
            identity, session, _ = self._session_identity('full')
            context = self._waveform_context(identity, session, tracks)
            try:
                reply = self.call('engine.execute', {'command': 'session.waveform.inspect', 'params': {'tracks': tracks, 'bins': bins}})
            except BridgeError as error:
                if error.code == 'engine_error' and 'unknown command' in str(error).lower():
                    raise BridgeError('waveforms_unsupported', '当前 SoundCraft 未提供真实波形接口，请使用最新 GazeDeck 控制程序', 409) from error
                raise
            model = self._validate_waveform_model(reply.get('result'), context, tracks, bins)
            current, session, _ = self._session_identity('full')
            if current != identity or self._waveform_context(current, session, tracks) != context:
                raise BridgeError('waveforms_changed', '读取波形时工程、片段或音频素材已变化，请重新刷新', 409)
            return {**reply, 'result': {**copy.deepcopy(model), **identity, 'projectKey': self._rate_project_key(identity)}}
        finally:
            self._lock.release()

    @staticmethod
    def _level_invariants(session, targets):
        value = copy.deepcopy(session)
        for key in ('dirty', 'undo', 'redo'):
            value.pop(key, None)
        for track in value['tracks']:
            if track['id'] in targets:
                track.pop('volume_db', None)
        if value['transport']['playing']:
            value['transport'].pop('position', None)
        return value

    def _edit_levels(self, params, restore=False):
        identity, session, _ = self._session_identity('full')
        if any(params[key] != identity[key] for key in ('projectPath', 'projectName')) or sorted(params['trackIds']) != identity['trackIds']:
            raise BridgeError('project_changed', 'SoundCraft 工程或音轨已变化，请重新连接', 409)
        if session['transport'].get('recording') is True:
            raise BridgeError('recording_active', 'SoundCraft 正在录音，暂不调节联动音量', 409)
        model, _ = self._level_model(identity, session)
        if model['epoch'] != params['epoch']:
            raise BridgeError('levels_changed', 'SoundCraft 工程会话已变化，请重新读取联动音量', 409)
        rows = {row['track']: row for row in model['tracks']}
        receipt = params.get('receipt')
        stored = self._level_receipts.get(receipt) if receipt is not None else None
        if receipt is not None and (not stored or stored['identity'] != identity or stored['epoch'] != model['epoch']):
            raise BridgeError('levels_changed', '本次联动音量凭据已失效，不恢复或续写未知历史状态', 409)
        if restore:
            targets = set(stored['before'])
            desired = stored['before']
        else:
            targets = {update['track'] for update in params['updates']}
            desired = {update['track']: update['db'] for update in params['updates']}
            for update in params['updates']:
                row = rows.get(update['track'])
                if not row or abs(row['db'] - update['expectedDb']) > 1e-5:
                    raise BridgeError('levels_changed', '预期音量已过期，整批未发送，请重新读取', 409)
            if stored and targets != set(stored['before']):
                raise BridgeError('levels_changed', '联动目标与本次凭据不一致，未修改音量', 409)
        if any(not rows.get(track, {}).get('available') for track in targets):
            raise BridgeError('levels_changed', '所选音轨当前不允许修改音量，整批未发送', 409)
        if stored and any(abs(rows[track]['db'] - stored['after'][track]) > 1e-5 for track in targets):
            raise BridgeError('levels_changed', '本次调节后的音量已被外部修改，未覆盖外部数值', 409)
        rates, _ = self._rate_model(identity)
        if rates['epoch'] != model['epoch']:
            raise BridgeError('levels_changed', '音量与播放会话标识不一致，请重新连接', 409)
        status = self.call('ui.inspect')['result']
        if not isinstance(status, dict) or status.get('audio_ready') is not True:
            raise BridgeError('levels_audio_unavailable', 'SoundCraft 音频输出未就绪，未发送音量修改', 409)
        current, preflight, _ = self._session_identity('full')
        current_model, _ = self._level_model(current, preflight)
        if (current != identity or current_model != model
                or self._level_invariants(preflight, set()) != self._level_invariants(session, set())):
            raise BridgeError('levels_changed', '联动音量预检期间工程或参数已变化，未发送修改', 409)
        request = {'epoch':params['epoch'], 'receipt':receipt} if restore else {'epoch':params['epoch'], 'updates':params['updates']}
        if not restore and receipt is not None:
            request['receipt'] = receipt
        wrote = False
        try:
            reply = self.call('engine.execute', {'command':'mix.level.restore' if restore else 'mix.level.set', 'params':request})
            wrote = True
            ack = reply.get('result')
            if (not isinstance(ack, dict) or not {'version','epoch','tracks','changed','updated','receipt'} <= set(ack)
                    or type(ack.get('changed')) is not bool or not isinstance(ack.get('updated'), list)
                    or any(type(track) is not int or track not in targets for track in ack['updated'])
                    or len(set(ack['updated'])) != len(ack['updated']) or ack['changed'] != bool(ack['updated'])):
                raise BridgeError('levels_not_confirmed', '联动音量回执格式无效，未重发', 502, True)
            returned = ack.get('receipt')
            if ((restore or not ack['changed'] and receipt is None) and returned is not None
                    or not restore and receipt is not None and returned != receipt
                    or not restore and ack['changed'] and (not isinstance(returned,str) or not 0 < len(returned) <= 256)):
                raise BridgeError('levels_not_confirmed', '联动音量凭据回执不一致，未重发', 502, True)
            current, readback, _ = self._session_identity('full')
            after, _ = self._level_model(current, readback)
            after_rates, _ = self._rate_model(current)
            status = self.call('ui.inspect')['result']
            if (current != identity or after['epoch'] != params['epoch'] or rates != after_rates
                    or not isinstance(status, dict) or status.get('audio_ready') is not True):
                raise BridgeError('levels_not_confirmed', '调节时工程、倍率或音频输出已变化，请重新连接核对', 409, True)
            validated = self._validate_level_model(ack, identity, readback)
            if {key:validated[key] for key in ('version','epoch','tracks')} != after:
                raise BridgeError('levels_not_confirmed', '音量回执与实际回读不同，未重发', 502, True)
            after_rows = {row['track']:row for row in after['tracks']}
            changed = {track for track in rows if rows[track]['db'] != after_rows[track]['db']}
            if (set(ack['updated']) != changed or not changed <= targets
                    or self._level_invariants(preflight,targets) != self._level_invariants(readback,targets)
                    or any(abs(after_rows[track]['db'] - desired[track]) > 1e-5 for track in targets)):
                raise BridgeError('levels_not_confirmed', '音量事务未确认精确目标或影响了受保护状态，请核对', 409, True)
            if restore:
                self._level_receipts.pop(receipt,None)
            elif returned is not None:
                if stored is None and returned in self._level_receipts:
                    raise BridgeError('levels_not_confirmed', '原生凭据重复，请重新连接核对', 502, True)
                self._level_receipts[returned] = {'identity':copy.deepcopy(identity),'epoch':params['epoch'],
                    'before':copy.deepcopy(stored['before']) if stored else {track:rows[track]['db'] for track in targets},
                    'after':{track:after_rows[track]['db'] for track in targets}}
                while len(self._level_receipts) > 64:
                    self._level_receipts.pop(next(iter(self._level_receipts)))
            result = self._public_levels(identity,after,status)
            result.update(changed=ack['changed'],updated=ack['updated'],receipt=returned)
            return {**reply,'result':result}
        except BridgeError as error:
            error.may_have_executed = error.may_have_executed or wrote
            raise

    @staticmethod
    def _eq_slot(track, slot):
        inserts = track.get('inserts')
        if not isinstance(inserts, list):
            raise BridgeError('invalid_eq_reply', 'SoundCraft 没有返回有效的完整插入效果器数据', 502)
        seen, chosen = set(), None
        for insert in inserts:
            if (not isinstance(insert, dict) or type(insert.get('slot')) is not int
                    or not 0 <= insert['slot'] <= 9 or insert['slot'] in seen):
                raise BridgeError('invalid_eq_reply', 'SoundCraft 效果器插槽编号无效', 502)
            seen.add(insert['slot'])
            if insert['slot'] == slot:
                chosen = {key: copy.deepcopy(insert.get(key)) for key in ('plugin', 'bypass', 'params')}
        return chosen

    @staticmethod
    def _eq_invariants(session, track_id, slot):
        # Exclude only the one insert being changed and the naturally advancing
        # playing position. No transport, loop, selection, clip or mixer write.
        tracks = copy.deepcopy(session['tracks'])
        for track in tracks:
            if track['id'] == track_id:
                track['inserts'] = [insert for insert in track['inserts'] if insert['slot'] != slot]
        transport = session['transport']
        return {'tracks': tracks, 'selection': session.get('selection'), 'tempo': session.get('tempo'),
                'sample_rate': session.get('sample_rate'), 'length_samples': session.get('length_samples'),
                'playing': transport['playing'], 'recording': transport.get('recording', False),
                'position': None if transport['playing'] else transport.get('position')}

    def _eq_defaults(self):
        # Query the running engine's definitions instead of assuming that a
        # plugin with the same name has identical defaults in another version.
        reply = self.call('engine.execute', {'command': 'engine.plugins', 'params': {}})
        plugins = reply.get('result')
        plugin = next((item for item in plugins if isinstance(item, dict) and item.get('id') == 'eq_7band'), None) if isinstance(plugins, list) else None
        definitions = plugin.get('params') if plugin else None
        if not isinstance(definitions, list) or not definitions:
            raise BridgeError('unsupported_eq', '当前 SoundCraft 没有返回内置 EQ 7-Band 参数定义', 409)
        defaults = {}
        for definition in definitions:
            if not isinstance(definition, dict) or not isinstance(definition.get('id'), str) or definition['id'] in defaults:
                raise BridgeError('unsupported_eq', 'SoundCraft EQ 参数定义无效', 502)
            defaults[definition['id']] = definition.get('default')
        result = {'plugin': 'eq_7band', 'bypass': False, 'params': defaults}
        if not valid_eq_insert(result):
            raise BridgeError('unsupported_eq', '当前 SoundCraft EQ 参数范围不受支持', 409)
        return result

    def _edit_eq(self, params):
        identity, session, before_reply = self._session_identity('full')
        if (params['projectPath'] != identity['projectPath'] or params['projectName'] != identity['projectName']
                or sorted(params['trackIds']) != identity['trackIds']):
            raise BridgeError('project_changed', 'SoundCraft 工程或轨道已变化，请重新连接', 409)
        if session['transport'].get('recording') is True:
            raise BridgeError('recording_active', 'SoundCraft 正在录音，暂不修改 EQ，请先结束录音', 409)
        track_id, slot = params['trackId'], params['slot']
        track = next((item for item in session['tracks'] if item['id'] == track_id), None)
        if not track or track.get('kind') != 'audio' or track.get('inactive') is not False:
            raise BridgeError('invalid_eq_track', '请选择启用的真实音频轨道', 409)
        automation = track.get('automation')
        mode = track.get('automation_mode')
        if not isinstance(automation, list) or automation or not isinstance(mode, str) or mode not in {'read', 'off'}:
            raise BridgeError('eq_automation_active', '目标轨道含自动化或自动化状态不可读，暂不覆盖其 EQ 参数', 409)
        before = self._eq_slot(track, slot)
        if before != params['expectedInsert']:
            raise BridgeError('eq_changed', 'EQ 插槽或参数已在其他位置变化，请重新打开；未覆盖外部修改', 409)
        if before is not None and not valid_eq_insert(before):
            raise BridgeError('unsupported_eq', '目标插槽不是启用的内置 EQ 7-Band；不会覆盖或开启其他插件', 409)
        project_key = json.dumps([identity['projectPath'], identity['projectName'], identity['trackIds']],
                                 ensure_ascii=False, separators=(',', ':'))
        band, target = params['band'], params['db']
        key = EQ_BANDS[band]
        original = before['params'][key] if before is not None else 0
        changed = original != target
        public = {'projectKey': project_key, 'trackId': track_id, 'slot': slot, 'band': band,
                  'beforeDb': original, 'afterDb': target, 'created': before is None and changed,
                  'changed': changed, 'insert': before}
        if not changed:
            return {**before_reply, 'result': {'eq': public}}
        expected_after = copy.deepcopy(before) if before is not None else self._eq_defaults()
        expected_after['params'][key] = target
        if before is None:
            occupied = {insert['slot'] for insert in track['inserts']}
            first_free = next((index for index in range(10) if index not in occupied), None)
            if slot != first_free:
                raise BridgeError('eq_changed', '可用 EQ 插槽已变化，请重新打开；未覆盖其他插件', 409)
            # Let the engine select its first empty slot atomically. An explicit
            # slot would replace a plugin added in the native UI after preflight.
            command = {'command': 'mix.insert', 'params': {'track': track_id,
                       'plugin': 'eq_7band', 'params': {key: target}}}
        else:
            command = {'command': 'mix.insert_param', 'params': {'track': track_id, 'slot': slot, 'param': key, 'value': target}}
        invariants = self._eq_invariants(session, track_id, slot)
        # Plugin discovery adds a read round trip for first use. Recheck the
        # protected snapshot immediately before the single modifying command.
        current, preflight, _ = self._session_identity('full')
        current_track = next((item for item in preflight['tracks'] if item['id'] == track_id), None)
        if (current != identity or current_track is None or self._eq_slot(current_track, slot) != before
                or self._eq_invariants(preflight, track_id, slot) != invariants):
            raise BridgeError('eq_changed', '工程或 EQ 参数在提交前变化，请重新打开；未覆盖外部修改', 409)
        wrote = False
        try:
            reply = self.call('engine.execute', command)
            wrote = True
            ack = reply.get('result')
            if (not isinstance(ack, dict) or before is None and ack != {'track': track_id, 'slot': slot, 'plugin': 'eq_7band'}
                    or before is not None and (type(ack.get('value')) not in (int, float)
                                              or not math.isfinite(ack['value']) or abs(ack['value'] - target) > .00001)):
                raise BridgeError('eq_not_confirmed', 'SoundCraft 未确认 EQ 修改，请重新连接核对；未自动重发', 502, True)
            for attempt in range(3):
                current, readback, _ = self._session_identity('full')
                current_track = next((item for item in readback['tracks'] if item['id'] == track_id), None)
                actual = self._eq_slot(current_track, slot) if current_track else None
                if current != identity or current_track is None or self._eq_invariants(readback, track_id, slot) != invariants:
                    raise BridgeError('eq_not_confirmed', '工程、轨道、播放或循环选区在修改 EQ 时变化，请重新连接核对', 409, True)
                confirmed = self._eq_equal(actual, expected_after, key)
                if confirmed:
                    break
                if actual != before or attempt == 2:
                    raise BridgeError('eq_not_confirmed', 'SoundCraft 实际 EQ 参数尚未确认或已变化，请重新连接；未自动重发', 502, True)
                time.sleep(.05)
            public['insert'] = actual
            public['afterDb'] = actual['params'][key]
            return {**reply, 'result': {'eq': public}}
        except BridgeError as error:
            error.may_have_executed = error.may_have_executed or wrote
            raise

    @staticmethod
    def _eq_equal(actual, expected, changed_key):
        # SoundCraft stores plugin parameters as f32; only the requested dB can
        # gain float32 rounding. All other defaults/parameters remain identical.
        if not valid_eq_insert(actual) or set(actual['params']) != set(expected['params']):
            return False
        return (actual['plugin'] == expected['plugin'] and actual['bypass'] == expected['bypass']
                and all(abs(actual['params'][key] - value) <= .00001 if key == changed_key
                        else actual['params'][key] == value for key, value in expected['params'].items()))

    @staticmethod
    def _constant_tempo(session):
        tempo = session.get('tempo')
        if (not isinstance(tempo, list) or len(tempo) != 1 or not isinstance(tempo[0], dict)
                or type(tempo[0].get('tick')) is not int or tempo[0]['tick'] != 0
                or not valid_bpm(tempo[0].get('bpm'))):
            raise BridgeError('unsupported_tempo_map', '当前仅支持起点单一速度、20–300 BPM 的工程；不会覆盖已有多段速度图', 409)
        return tempo[0]['bpm']

    def _set_tempo(self, params):
        # event.tempo changes only the project tempo map. It does not conform,
        # stretch or render audio clips, and is not per-Deck playback speed.
        identity, session, before_reply = self._session_identity()
        if (params['projectPath'] != identity['projectPath'] or params['projectName'] != identity['projectName']
                or sorted(params['trackIds']) != identity['trackIds']):
            raise BridgeError('project_changed', 'SoundCraft 工程或轨道已变化，请重新连接', 409)
        if session['transport'].get('recording') is True:
            raise BridgeError('recording_active', 'SoundCraft 正在录音，暂不支持网页修改工程 BPM，请先结束录音', 409)
        before = self._constant_tempo(session)
        if params['expectedTempoMap'] != [[0, before]]:
            raise BridgeError('tempo_changed', '工程 BPM 已在其他位置变化，请刷新后重新打开；未覆盖外部修改', 409)
        target = params['bpm']
        public = {'projectKey': json.dumps([identity['projectPath'], identity['projectName'], identity['trackIds']],
                                           ensure_ascii=False, separators=(',', ':')),
                  'beforeBpm': before, 'afterBpm': target, 'changed': target != before}
        if target == before:
            return {**before_reply, 'result': {'tempo': public}}
        wrote = False
        try:
            reply = self.call('engine.execute', {'command': 'event.tempo', 'params': {'bpm': target, 'at': 0}})
            wrote = True
            ack = reply.get('result')
            if (not isinstance(ack, dict) or type(ack.get('tick')) is not int or ack['tick'] != 0
                    or not valid_bpm(ack.get('bpm')) or ack['bpm'] != target):
                raise BridgeError('tempo_not_confirmed', 'SoundCraft 未确认工程 BPM，请核对后重新连接；未自动重发', 502, True)
            for attempt in range(3):
                current, readback, _ = self._session_identity()
                transport, original = readback['transport'], session['transport']
                if (current != identity or transport['playing'] != original['playing']
                        or transport.get('recording', False) != original.get('recording', False)
                        or readback.get('selection') != session.get('selection')
                        or readback.get('sample_rate') != session.get('sample_rate')
                        or readback.get('length_samples') != session.get('length_samples')
                        or not original['playing'] and transport.get('position') != original.get('position')):
                    raise BridgeError('tempo_not_confirmed', '工程、播放位置或选区在修改 BPM 时发生变化，请重新连接核对', 409, True)
                actual = self._constant_tempo(readback)
                if actual == target:
                    break
                if actual != before or attempt == 2:
                    raise BridgeError('tempo_not_confirmed', 'SoundCraft 实际 BPM 与请求不符，请重新连接核对；未自动重发', 502, True)
                # Only repeat reads to accommodate a delayed UI state; never resend.
                time.sleep(0.05)
            return {**reply, 'result': {'tempo': public}}
        except BridgeError as error:
            error.may_have_executed = error.may_have_executed or wrote
            raise

    def _seek_relative(self, params):
        # SoundCraft's relative transport commands use selection.start when paused.
        # Read the actual transport position and issue exactly one absolute Locate.
        pin, session, before_reply = self._session_pin()
        if (params['projectPath'] != pin['projectPath'] or params['projectName'] != pin['projectName']
                or sorted(params['trackIds']) != pin['trackIds']
                or params['sampleRate'] != pin['sampleRate'] or params['lengthSamples'] != pin['end']):
            raise BridgeError('project_changed', 'SoundCraft 工程、轨道或时间范围已变化，请重新连接', 409)
        before = session['transport'].get('position')
        if type(before) is not int or not 0 <= before <= MAX_SAFE_INTEGER:
            raise BridgeError('invalid_reply', 'SoundCraft 没有返回有效的实际播放头位置', 502)
        if session['transport'].get('recording') is True:
            raise BridgeError('recording_active', 'SoundCraft 正在录音，暂不支持网页快进／快退，请先结束录音', 409)
        length, rate = pin['end'], pin['sampleRate']
        if length > MAX_SAFE_INTEGER:
            raise BridgeError('invalid_reply', 'SoundCraft 工程长度超出网页精确定位范围', 502)
        start, end = 0, length
        selection = session.get('selection')
        preserve_selection = (isinstance(selection, dict) and type(selection.get('start')) is int
                              and type(selection.get('end')) is int and selection['end'] > selection['start'])
        if preserve_selection:
            # Locate outside a nonempty selection collapses it, which can erase Loop.
            start, end = max(start, selection['start']), min(end, selection['end'])
            if end <= start:
                raise BridgeError('invalid_range', '当前选区不在工程有效范围内，请先在 SoundCraft 中调整选区', 409)
        requested = params['deltaSeconds']
        if requested == 0:
            after = before
        else:
            at_project_end = start == 0 and end == length and before == length and requested < 0
            if not start <= before < end and not at_project_end:
                raise BridgeError('position_outside_range', '实际播放头不在当前有效定位范围内，请先在 SoundCraft 中移动播放头或调整选区', 409)
            # JS Math.round-compatible rounding for the final nonnegative sample target.
            after = max(start, min(end - 1, math.floor(before + requested * rate + 0.5)))
        public = {'projectKey': self._public_pin(pin)['projectKey'], 'beforeSamples': before,
                  'afterSamples': after, 'deltaSeconds': (after - before) / rate,
                  'requestedDeltaSeconds': requested, 'sampleRate': rate, 'lengthSamples': length,
                  'rangeStart': start, 'rangeEnd': end}
        if after == before:
            return {**before_reply, 'result': {'seek': public}}
        wrote = False
        try:
            reply = self.call('engine.execute', {'command': 'transport.locate', 'params': {'at': after}})
            wrote = True
            ack = reply.get('result')
            if not isinstance(ack, dict) or type(ack.get('at')) is not int or ack['at'] != after:
                raise BridgeError('seek_not_confirmed', 'SoundCraft 未确认定位位置；请核对播放头后重新连接', 502, True)
            for attempt in range(3):
                current, readback, _ = self._session_pin()
                if (not self._same_pin(pin, current) or readback['transport']['playing'] != session['transport']['playing']
                        or readback['transport'].get('recording', False) != session['transport'].get('recording', False)
                        or (preserve_selection and readback.get('selection') != selection)):
                    raise BridgeError('seek_not_confirmed', '工程、播放状态或选区在定位时发生变化，请重新连接核对', 409, True)
                if readback['transport']['playing'] or readback['transport'].get('position') == after:
                    break
                if attempt == 2:
                    raise BridgeError('seek_not_confirmed', 'SoundCraft 已接受定位，但暂停播放头尚未确认，请重新连接核对', 502, True)
                # The UI queues Locate before its transport pass. Repeat reads only.
                time.sleep(0.05)
            # During playback, the precise Locate ACK is authoritative: later readback
            # naturally advances or wraps inside Loop, and must never trigger a resend.
            return {**reply, 'result': {'seek': public}}
        except BridgeError as error:
            error.may_have_executed = error.may_have_executed or wrote
            raise

    def call(self, method, params=None, *, timeout=None):
        # Serialize commands. Reject overload instead of accumulating stale slider values.
        if not self._lock.acquire(timeout=0.2):
            raise BridgeError('busy', 'SoundCraft 正在处理上一请求，请稍后重试', 503)
        writing = False
        # Definitions and rate inspection are read-only even though dispatched
        # through engine.execute. A lost inspection reply must not imply a write.
        mutating = method == 'engine.execute' and (params or {}).get('command') not in {
            'engine.plugins', 'playback.rate.inspect', 'playback.deck.inspect',
            'mix.effects.inspect', 'mix.tone.inspect', 'mix.level.inspect', 'session.waveform.inspect',
        }
        try:
            request_id = next(self._ids)
            packet = json.dumps({'id': request_id, 'method': method, 'params': params or {}},
                                ensure_ascii=False, allow_nan=False).encode('utf-8') + b'\n'
            deadline = self.timeout if timeout is None else timeout
            with socket.create_connection(('127.0.0.1', self.port), timeout=deadline) as connection:
                connection.settimeout(deadline)
                writing = True
                connection.sendall(packet)
                with connection.makefile('rb') as stream:
                    line = stream.readline(MAX_REPLY + 1)
            if not line or len(line) > MAX_REPLY or not line.endswith(b'\n'):
                raise ValueError('缺少完整回执，或回执超过大小限制')
            reply = json.loads(line)
            json.dumps(reply, allow_nan=False)
            if not isinstance(reply, dict) or type(reply.get('id')) is not int or reply.get('id') != request_id or type(reply.get('ok')) is not bool:
                raise ValueError('回执编号或格式不正确')
            if not reply['ok']:
                raise BridgeError('engine_error', str(reply.get('error', 'SoundCraft 拒绝此操作')), 422)
            return {'ok': True, 'connected': True, 'target': self.target,
                    'requestId': request_id, 'result': reply.get('result')}
        except BridgeError:
            raise
        except (TimeoutError, OSError) as error:
            uncertain = writing and mutating
            message = ('SoundCraft 请求已发送，但未取得可靠回执；可能已执行，请先读取状态再决定是否重试'
                       if uncertain else '无法连接或读取 SoundCraft；请使用“SoundCraft 控制模式”快捷方式启动并检查端口')
            timed_out = isinstance(error, TimeoutError)
            raise BridgeError('timeout' if timed_out else 'unavailable', message,
                              504 if timed_out else 503, uncertain) from error
        except (ValueError, UnicodeError, RecursionError) as error:
            raise BridgeError('invalid_reply', f'SoundCraft 回执无效：{error}；未自动重发',
                              502, writing and mutating) from error
        finally:
            self._lock.release()


def validate_command(command, params):
    if not isinstance(command, str) or command not in TRANSPORT_PARAMS and command not in MIX_COMMANDS:
        raise BridgeError('invalid_command', '此 SoundCraft 命令未开放')
    if not isinstance(params, dict):
        raise BridgeError('invalid_params', 'params 必须是 JSON 对象')
    try:
        json.dumps(params, allow_nan=False)
    except (ValueError, TypeError):
        raise BridgeError('invalid_params', '参数必须是有效的有限数值或 JSON 数据')
    if command in TRANSPORT_PARAMS:
        if set(params) - TRANSPORT_PARAMS[command]:
            raise BridgeError('invalid_params', '播放、暂停和定位作用于整个 SoundCraft 工程，不支持指定 Deck 或轨道')
    else:
        if 'deck' in params:
            raise BridgeError('invalid_params', '请用 track 或 tracks 指定 SoundCraft 轨道 ID 或名称')
        if ('track' in params) == ('tracks' in params):
            raise BridgeError('invalid_params', '必须明确指定 track 或 tracks，且不能同时使用两者')
        tracks = params['tracks'] if 'tracks' in params else [params['track']]
        if not isinstance(tracks, list) or not tracks or len(tracks) > 64:
            raise BridgeError('invalid_params', 'tracks 必须是非空轨道列表，最多 64 条')
        if any(not (type(track) is int and track > 0 or isinstance(track, str) and 0 < len(track.strip()) <= 256)
               for track in tracks):
            raise BridgeError('invalid_params', '轨道必须是正整数 ID 或非空名称')
    if command == 'mix.volume':
        if ('db' in params) == ('delta_db' in params):
            raise BridgeError('invalid_params', '音量必须指定 db 或 delta_db 中的一项')
        key = 'db' if 'db' in params else 'delta_db'
        value = params[key]
        if type(value) not in (int, float) or not math.isfinite(value) or not -144 <= value <= (12 if key == 'db' else 144):
            raise BridgeError('invalid_params', '音量 db 范围为 -144 至 12，delta_db 范围为 -144 至 144；不接受百分比或字符串')
    return {'command': command, 'params': params}


def control_request(body):
    if not isinstance(body, dict) or set(body) - {'action', 'params'}:
        raise BridgeError('invalid_request', '请求格式为 {action, params}')
    action, params = body.get('action'), body.get('params', {})
    if not isinstance(params, dict):
        raise BridgeError('invalid_params', 'params 必须是 JSON 对象')
    if action in {'CAPTURE_AUDIO_BASELINE', 'RESET_AUDIO'}:
        expected = {'projectPath', 'projectName', 'trackIds', 'epoch', 'deckA', 'deckB'}
        if (set(params) != expected
                or not isinstance(params.get('projectPath'), str) or not 0 < len(params['projectPath']) <= 4096
                or not isinstance(params.get('projectName'), str) or not 0 < len(params['projectName']) <= 4096
                or not valid_track_ids(params.get('trackIds')) or len(params['trackIds']) > 4096
                or not isinstance(params.get('epoch'), str) or not 0 < len(params['epoch']) <= 256
                or any(type(params.get(key)) is not int or params[key] not in params['trackIds']
                       for key in ('deckA', 'deckB')) or params['deckA'] == params['deckB']):
            raise BridgeError('invalid_params', '音频重置需要当前工程、播放会话与两条不同的 A/B 音频轨道')
        return {'command': 'gazedeck.capture_audio_baseline' if action == 'CAPTURE_AUDIO_BASELINE'
                else 'gazedeck.reset_audio', 'params': params}
    if action == 'REMOVE_LIBRARY_SONG':
        if set(params) != {'id'} or not valid_song_id(params['id']):
            raise BridgeError('invalid_params', '需要有效的曲目编号')
        return {'command': 'gazedeck.remove_library_song', 'params': params}
    if action == 'LOAD_DECK_SONG':
        fields = {'projectPath', 'projectName', 'trackIds', 'epoch', 'track'}
        library_song = set(params) == fields | {'songId'} and valid_song_id(params.get('songId'))
        project_source = (set(params) == fields | {'sourceId', 'sourceName', 'sourcePath'}
                          and type(params.get('sourceId')) is int and 0 < params['sourceId'] <= MAX_SAFE_INTEGER
                          and isinstance(params.get('sourceName'), str) and 0 < len(params['sourceName']) <= 255
                          and isinstance(params.get('sourcePath'), str) and 0 < len(params['sourcePath']) <= 4096)
        if (not (library_song or project_source)
                or not isinstance(params.get('projectPath'), str) or not 0 < len(params['projectPath']) <= 4096
                or not isinstance(params.get('projectName'), str) or len(params['projectName']) > 4096
                or not isinstance(params.get('epoch'), str) or not 0 < len(params['epoch']) <= 256
                or not valid_track_ids(params.get('trackIds')) or len(params['trackIds']) > 4096
                or any(track > MAX_SAFE_INTEGER for track in params['trackIds'])
                or type(params.get('track')) is not int or params['track'] not in params['trackIds']):
            raise BridgeError('invalid_params', '需要有效工程、目标 Deck 及曲库曲目或工程素材')
        return {'command': 'gazedeck.load_deck_song', 'params': params}
    if action == 'SEEK_DECK_RELATIVE':
        fields = {'projectPath', 'projectName', 'trackIds', 'epoch', 'track', 'offsetSeconds'}
        offset = params.get('offsetSeconds')
        if (set(params) != fields
                or not isinstance(params.get('projectPath'), str) or not 0 < len(params['projectPath']) <= 4096
                or not isinstance(params.get('projectName'), str) or len(params['projectName']) > 4096
                or not isinstance(params.get('epoch'), str) or not 0 < len(params['epoch']) <= 256
                or not valid_track_ids(params.get('trackIds')) or len(params['trackIds']) > 4096
                or any(track > MAX_SAFE_INTEGER for track in params['trackIds'])
                or type(params.get('track')) is not int or params['track'] not in params['trackIds']
                or type(offset) not in (int, float) or not 0 < abs(offset) <= 30):
            raise BridgeError('invalid_params', '单轨定位需要有效工程、目标轨道和正负 30 秒内的非零偏移')
        return {'command': 'gazedeck.seek_deck_relative', 'params': params}
    if action == 'SET_DECK_PLAYBACK':
        fields = {'projectPath', 'projectName', 'trackIds', 'epoch', 'track', 'peer',
                  'paused', 'expectedPaused', 'expectedPlaying'}
        if (set(params) != fields
                or not isinstance(params.get('projectPath'), str) or not 0 < len(params['projectPath']) <= 4096
                or not isinstance(params.get('projectName'), str) or len(params['projectName']) > 4096
                or not isinstance(params.get('epoch'), str) or not 0 < len(params['epoch']) <= 256
                or not valid_track_ids(params.get('trackIds')) or len(params['trackIds']) > 4096
                or any(track > MAX_SAFE_INTEGER for track in params['trackIds'])
                or any(type(params.get(key)) is not int or params[key] not in params['trackIds']
                       for key in ('track', 'peer')) or params['track'] == params['peer']
                or any(type(params.get(key)) is not bool for key in ('paused', 'expectedPaused', 'expectedPlaying'))):
            raise BridgeError('invalid_params', '单轨播放需要有效工程、两条不同的已绑定音轨和预期播放状态')
        return {'command': 'gazedeck.set_deck_playback', 'params': params}
    if isinstance(action,str) and action in {'SET_LEVELS','RESTORE_LEVELS'}:
        fields = {'projectPath','projectName','trackIds','epoch'} | ({'receipt'} if action == 'RESTORE_LEVELS' else {'updates'})
        allowed = fields if action == 'RESTORE_LEVELS' else fields | {'receipt'}
        if (not fields <= set(params) or not set(params) <= allowed
                or not isinstance(params.get('projectPath'),str) or not 0 < len(params['projectPath']) <= 4096
                or not isinstance(params.get('projectName'),str) or len(params['projectName']) > 4096
                or not valid_track_ids(params.get('trackIds')) or len(params['trackIds']) > 4096
                or any(track > MAX_SAFE_INTEGER for track in params['trackIds'])
                or not isinstance(params.get('epoch'),str) or not 0 < len(params['epoch']) <= 256
                or 'receipt' in params and (not isinstance(params['receipt'],str) or not 0 < len(params['receipt']) <= 256)):
            raise BridgeError('invalid_params', f'{action} 需要有效工程、完整轨道列表、会话与可选原生凭据')
        if action == 'SET_LEVELS' and (not isinstance(params.get('updates'),list) or not 1 <= len(params['updates']) <= 2
                or any(not valid_level_update(update) for update in params['updates'])
                or len({update['track'] for update in params['updates']}) != len(params['updates'])
                or any(update['track'] not in params['trackIds'] for update in params['updates'])):
            raise BridgeError('invalid_params','SET_LEVELS 需要 1–2 条不同真实轨道、预期音量与 -144 至 +12 dB 目标')
        return {'command':'gazedeck.restore_levels' if action == 'RESTORE_LEVELS' else 'gazedeck.set_levels','params':params}
    if isinstance(action, str) and action in {'APPLY_TONE', 'RESTORE_TONE'}:
        fields = {'projectPath', 'projectName', 'trackIds', 'epoch'} | ({'receipt'} if action == 'RESTORE_TONE' else {'updates'})
        if (set(params) != fields or not isinstance(params.get('projectPath'), str) or not 0 < len(params['projectPath']) <= 4096
                or not isinstance(params.get('projectName'), str) or len(params['projectName']) > 4096
                or not valid_track_ids(params.get('trackIds')) or len(params['trackIds']) > 4096
                or any(track > MAX_SAFE_INTEGER for track in params['trackIds'])
                or not isinstance(params.get('epoch'), str) or not 0 < len(params['epoch']) <= 256):
            raise BridgeError('invalid_params', f'{action} 需要有效的工程、完整轨道列表与音色会话标识')
        if action == 'RESTORE_TONE':
            if not isinstance(params.get('receipt'), str) or not 0 < len(params['receipt']) <= 256:
                raise BridgeError('invalid_params', 'RESTORE_TONE 需要本次已确认修改的撤回凭据')
        elif (not isinstance(params.get('updates'), list) or not 1 <= len(params['updates']) <= 2
                or any(not valid_tone_update(update) for update in params['updates'])
                or len({update['track'] for update in params['updates']}) != len(params['updates'])
                or any(update['track'] not in params['trackIds'] for update in params['updates'])):
            raise BridgeError('invalid_params', 'APPLY_TONE 需要 1–2 条真实轨道、完整预期插件及 EQ/效果器音色数值')
        return {'command': 'gazedeck.restore_tone' if action == 'RESTORE_TONE' else 'gazedeck.apply_tone', 'params': params}
    if isinstance(action, str) and action in {'SET_EFFECT', 'RESTORE_EFFECT'}:
        expected = {'projectPath', 'projectName', 'trackIds', 'epoch', 'effect', 'updates'}
        effect = params.get('effect')
        if (set(params) != expected or not isinstance(params.get('projectPath'), str)
                or not 0 < len(params['projectPath']) <= 4096 or not isinstance(params.get('projectName'), str)
                or len(params['projectName']) > 4096 or not valid_track_ids(params.get('trackIds'))
                or any(track > MAX_SAFE_INTEGER for track in params['trackIds'])
                or not isinstance(params.get('epoch'), str) or not 0 < len(params['epoch']) <= 256
                or not isinstance(effect, str) or effect not in EFFECT_PLUGINS
                or not isinstance(params.get('updates'), list) or not 1 <= len(params['updates']) <= 2
                or any(not valid_effect_update(update, effect, action == 'RESTORE_EFFECT') for update in params['updates'])
                or len({update['track'] for update in params['updates']}) != len(params['updates'])
                or any(update['track'] not in params['trackIds'] for update in params['updates'])):
            raise BridgeError('invalid_params', f'{action} 需要当前工程、效果器会话及 1–2 条带预期完整插槽的真实音轨；效果量范围 0–1')
        return {'command': 'gazedeck.restore_effect' if action == 'RESTORE_EFFECT' else 'gazedeck.set_effect', 'params': params}
    if action == 'SET_TRACK_RATE':
        expected = {'projectPath', 'projectName', 'trackIds', 'epoch', 'loop', 'updates'}
        if (set(params) != expected or not isinstance(params.get('projectPath'), str) or not 0 < len(params['projectPath']) <= 4096
                or not isinstance(params.get('projectName'), str) or len(params['projectName']) > 4096
                or not valid_track_ids(params.get('trackIds'))
                or not isinstance(params.get('epoch'), str) or not 0 < len(params['epoch']) <= 256
                or not valid_rate_loop(params.get('loop')) or not isinstance(params.get('updates'), list)
                or not 1 <= len(params['updates']) <= 2 or any(not valid_rate_update(update) for update in params['updates'])
                or len({update['track'] for update in params['updates']}) != len(params['updates'])
                or any(update['track'] not in params['trackIds'] for update in params['updates'])):
            raise BridgeError('invalid_params', 'SET_TRACK_RATE 需要当前工程、变速会话、固定循环范围及 1–2 条带预期版本的音轨倍率（0.5–2.0）')
        return {'command': 'gazedeck.set_track_rate', 'params': params}
    if action == 'SET_EQ':
        expected = {'projectPath', 'projectName', 'trackIds', 'trackId', 'slot', 'expectedInsert', 'band', 'db'}
        if (set(params) != expected or not isinstance(params.get('projectPath'), str) or not params['projectPath']
                or len(params['projectPath']) > 4096 or not isinstance(params.get('projectName'), str)
                or len(params['projectName']) > 4096 or not valid_track_ids(params.get('trackIds'))
                or type(params.get('trackId')) is not int or params['trackId'] not in params['trackIds']
                or type(params.get('slot')) is not int or not 0 <= params['slot'] <= 9
                or not (valid_eq_insert(params.get('expectedInsert')) or params.get('expectedInsert') is None)
                or not isinstance(params.get('band'), str) or params['band'] not in EQ_BANDS or not valid_eq_db(params.get('db'))):
            raise BridgeError('invalid_params', 'SET_EQ 需要当前工程、明确的 EQ 插槽与预期完整参数；增益范围 -24 至 +24 dB')
        return {'command': 'gazedeck.set_eq', 'params': params}
    if action == 'SET_TEMPO':
        if (set(params) != {'projectPath', 'projectName', 'trackIds', 'expectedTempoMap', 'bpm'}
                or not isinstance(params.get('projectPath'), str) or not params['projectPath']
                or len(params['projectPath']) > 4096 or not isinstance(params.get('projectName'), str)
                or len(params['projectName']) > 4096 or not valid_track_ids(params.get('trackIds'))
                or not valid_expected_tempo(params.get('expectedTempoMap')) or not valid_bpm(params.get('bpm'))):
            raise BridgeError('invalid_params', 'SET_TEMPO 需要当前工程、预期单一速度图及 20–300 BPM 的有限数值')
        return {'command': 'gazedeck.set_tempo', 'params': params}
    if isinstance(action, str) and action in {'ENABLE_FULL_LOOP', 'DISABLE_FULL_LOOP'}:
        if (set(params) != {'projectPath', 'trackIds'} or not isinstance(params['projectPath'], str) or not params['projectPath']
                or len(params['projectPath']) > 4096
                or not (valid_track_ids(params['trackIds']) or action == 'DISABLE_FULL_LOOP' and params['trackIds'] == [])):
            raise BridgeError('invalid_params', f'{action} 需要当前工程 projectPath 与有效 trackIds 列表')
        command = 'gazedeck.enable_full_loop' if action == 'ENABLE_FULL_LOOP' else 'gazedeck.disable_full_loop'
        return {'command': command, 'params': params}
    if action == 'SEEK_RELATIVE':
        expected = {'projectPath', 'projectName', 'trackIds', 'sampleRate', 'lengthSamples', 'deltaSeconds'}
        if (set(params) != expected or not isinstance(params['projectPath'], str) or not params['projectPath']
                or len(params['projectPath']) > 4096 or not isinstance(params['projectName'], str)
                or len(params['projectName']) > 4096 or not valid_track_ids(params['trackIds'])
                or type(params['sampleRate']) not in (int, float) or not math.isfinite(params['sampleRate'])
                or params['sampleRate'] <= 0 or type(params['lengthSamples']) is not int
                or not 0 < params['lengthSamples'] <= MAX_SAFE_INTEGER
                or type(params['deltaSeconds']) not in (int, float) or not math.isfinite(params['deltaSeconds'])
                or abs(params['deltaSeconds']) > 30):
            raise BridgeError('invalid_params', 'SEEK_RELATIVE 需要当前工程时间信息及 -30 至 +30 秒的相对偏移')
        return {'command': 'gazedeck.seek_relative', 'params': params}
    actions = {'PLAY': 'transport.play', 'PAUSE': 'transport.pause', 'STOP': 'transport.stop',
               'SET_VOLUME': 'mix.volume'}
    if isinstance(action, str) and action in actions:
        if action == 'SET_VOLUME' and ('db' not in params or 'delta_db' in params):
            raise BridgeError('invalid_params', 'SET_VOLUME 需要 db 数值及明确的 track 或 tracks')
        return validate_command(actions[action], params)
    if action == 'EXECUTE' and not set(params) - {'command', 'params'}:
        return validate_command(params.get('command'), params.get('params', {}))
    raise BridgeError('invalid_action', '不支持此 SoundCraft 控制动作；请重启更新后的 serve.py')


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map,
                      '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm'}

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, fmt, *args):
        if len(args) > 1 and str(args[1])[:1] in '45':
            super().log_message(fmt, *args)

    def api_json(self, status, body):
        data = json.dumps(body, ensure_ascii=False, allow_nan=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        self.wfile.write(data)

    def check_origin(self):
        def local_origin(value):
            try:
                url = urlsplit(value)
                return (url.scheme == 'http' and url.hostname in {'127.0.0.1', 'localhost'}
                        and url.port == self.server.server_port and not url.username and not url.password
                        and url.path in {'', '/'} and not url.query and not url.fragment)
            except ValueError:
                return False
        if not local_origin('http://' + self.headers.get('Host', '')):
            raise BridgeError('forbidden_origin', '仅允许从本机 GazeDeck 地址访问此接口', 403)
        origin = self.headers.get('Origin')
        if origin is not None and not local_origin(origin):
            raise BridgeError('forbidden_origin', '不允许其他网站调用本机 SoundCraft 接口', 403)

    def api_error(self, error):
        self.api_json(error.status, {'ok': False, 'target': self.server.soundcraft.target,
                      'error': {'code': error.code, 'message': str(error),
                                'mayHaveExecuted': error.may_have_executed}})

    def do_GET(self):
        url = urlsplit(self.path)
        if not (url.path == '/api/soundcraft' or url.path.startswith('/api/soundcraft/')):
            return super().do_GET()
        try:
            self.check_origin()
            query = parse_qs(url.query)
            if url.path in {'/api/soundcraft', '/api/soundcraft/status'}:
                result = self.server.soundcraft.call('ui.inspect')
            elif url.path == '/api/soundcraft/session':
                detail = query.get('detail', ['summary'])[0]
                if detail not in {'summary', 'full'}:
                    raise BridgeError('invalid_params', 'detail 必须是 summary 或 full')
                result = self.server.soundcraft.call('session.inspect', {'detail': detail})
            elif url.path == '/api/soundcraft/rates':
                if query:
                    raise BridgeError('invalid_params', '音轨倍率查询不接受额外参数')
                result = self.server.soundcraft.rates()
            elif url.path == '/api/soundcraft/deck-playback':
                if url.query:
                    raise BridgeError('invalid_params', '单轨播放状态查询不接受额外参数')
                result = self.server.soundcraft.deck_playback()
            elif url.path == '/api/soundcraft/library':
                if url.query:
                    raise BridgeError('invalid_params', '曲库查询不接受额外参数')
                result = {'ok': True, 'result': {'songs': self.server.soundcraft.song_library.list()}}
            elif url.path == '/api/soundcraft/effects':
                if url.query:
                    raise BridgeError('invalid_params', '效果器查询不接受额外参数')
                result = self.server.soundcraft.effects()
            elif url.path == '/api/soundcraft/tone':
                if url.query:
                    raise BridgeError('invalid_params', '音色查询不接受额外参数')
                result = self.server.soundcraft.tone()
            elif url.path == '/api/soundcraft/levels':
                if url.query:
                    raise BridgeError('invalid_params','联动音量查询不接受额外参数')
                result = self.server.soundcraft.levels()
            elif url.path == '/api/soundcraft/waveforms':
                tracks, bins = waveform_query(url.query)
                result = self.server.soundcraft.waveforms(tracks, bins)
            elif url.path == '/api/soundcraft/commands':
                prefix = query.get('filter', [''])[0]
                if len(prefix) > 100:
                    raise BridgeError('invalid_params', '命令筛选条件过长')
                result = self.server.soundcraft.call('engine.commands', {'filter': prefix} if prefix else {})
            else:
                raise BridgeError('not_found', '没有此 SoundCraft 接口', 404)
            self.api_json(200, result)
        except BridgeError as error:
            self.api_error(error)

    def do_POST(self):
        url = urlsplit(self.path)
        if url.path == '/api/soundcraft/library':
            return self.upload_song(url)
        consumed = 0
        if url.path != '/api/soundcraft':
            self.discard_small_rejected_body(consumed)
            return self.api_json(404, {'ok': False, 'error': {'code': 'not_found', 'message': '没有此接口'}})
        try:
            self.check_origin()
            if self.headers.get('Content-Type', '').split(';')[0].strip().lower() != 'application/json':
                raise BridgeError('invalid_content_type', '请发送 application/json', 415)
            length = self.headers.get('Content-Length', '')
            if len(length) > 10 or not length.isascii() or not length.isdigit() or int(length) <= 0:
                raise BridgeError('invalid_request', '需要有效的 Content-Length')
            if int(length) > MAX_BODY:
                raise BridgeError('request_too_large', 'JSON 请求不能超过 64 KiB', 413)
            try:
                raw_body = self.rfile.read(int(length))
                consumed = len(raw_body)
                body = json.loads(raw_body.decode('utf-8'))
                command = control_request(body)
            except (ValueError, UnicodeError, RecursionError) as error:
                raise BridgeError('invalid_json', '请求不是有效的 UTF-8 JSON') from error
            result = self.server.soundcraft.execute(command)
            self.api_json(200, result)
        except BridgeError as error:
            self.discard_small_rejected_body(consumed)
            self.api_error(error)

    def upload_song(self, url):
        started = False
        try:
            self.check_origin()
            if url.query or self.headers.get('Content-Type', '') != 'application/octet-stream':
                raise BridgeError('invalid_content_type', '曲库导入需要直接发送音频文件', 415)
            length = self.headers.get('Content-Length', '')
            if len(length) > 10 or not length.isascii() or not length.isdigit() or int(length) <= 0:
                raise BridgeError('invalid_request', '请选择非空音频文件')
            length = int(length)
            if length > MAX_SONG_BYTES:
                raise BridgeError('request_too_large', '单首音频不能超过 128 MiB', 413)
            encoded = self.headers.get('X-GazeDeck-Filename', '')
            try:
                name = unquote(encoded, encoding='utf-8', errors='strict') if len(encoded) <= 2400 else ''
            except UnicodeError:
                name = ''
            if not valid_song_name(name):
                raise BridgeError('invalid_song_name', '请选择 WAV、MP3、FLAC、AIFF、M4A、AAC、OGG 或 CAF 音频')
            started = True
            self.connection.settimeout(15)
            songs, song = self.server.soundcraft.song_library.add(name, self.rfile, length)
            self.api_json(200, {'ok': True, 'result': {'songs': songs, 'song': song}})
        except BridgeError as error:
            if not started:
                self.discard_small_rejected_body(0)
            self.api_error(error)
        finally:
            self.close_connection = True

    def discard_small_rejected_body(self, consumed):
        # Closing with an unread POST body may reset the Windows socket before
        # its 4xx JSON reply reaches the browser. Drain only small declared bodies,
        # with a total deadline; never wait for an unbounded or trickling upload.
        length = self.headers.get('Content-Length', '')
        if len(length) > 10 or not length.isascii() or not length.isdigit():
            return
        length = int(length)
        remaining = length - consumed
        if length > MAX_BODY + 4096 or remaining <= 0:
            return
        original_timeout = self.connection.gettimeout()
        deadline = time.monotonic() + 0.15
        try:
            while remaining > 0:
                wait = deadline - time.monotonic()
                if wait <= 0:
                    break
                self.connection.settimeout(wait)
                chunk = self.rfile.read1(min(remaining, 8192))
                if not chunk:
                    break
                remaining -= len(chunk)
        except (OSError, ValueError):
            pass
        finally:
            try:
                self.connection.settimeout(original_timeout)
            except OSError:
                pass


class Server(ThreadingHTTPServer):
    request_queue_size = 128
    daemon_threads = True
    allow_reuse_address = False

    def __init__(self, *args, soundcraft_port=SOUNDCRAFT_PORT, loop_pin_path=None, library_path=None, **kwargs):
        self.soundcraft = SoundCraftBridge(soundcraft_port, pin_path=loop_pin_path, library_path=library_path)
        super().__init__(*args, **kwargs)

    def server_bind(self):
        if sys.platform == 'win32' and hasattr(socket, 'SO_EXCLUSIVEADDRUSE'):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('port', nargs='?', type=int, default=PORT)
    parser.add_argument('--soundcraft-port', type=int, default=SOUNDCRAFT_PORT)
    parser.add_argument('--no-browser', action='store_true', help='不自动打开浏览器')
    args = parser.parse_args()
    if not all(1 <= value <= 65535 for value in (args.port, args.soundcraft_port)):
        parser.error('端口范围必须为 1–65535')
    if not (APP_ROOT / 'index.html').is_file():
        print(f'找不到项目网页：{APP_ROOT / "index.html"}', flush=True)
        if sys.stdin.isatty():
            input('按 Enter 关闭窗口…')
        raise SystemExit(1)
    try:
        httpd = Server(('127.0.0.1', args.port), partial(Handler, directory=str(APP_ROOT)),
                       soundcraft_port=args.soundcraft_port)
    except OSError as error:
        print(f'无法启动：端口 {args.port} 可能仍被旧服务占用。请先关闭旧服务窗口。\n{error}', flush=True)
        if sys.stdin.isatty():
            input('按 Enter 关闭窗口…')
        raise SystemExit(1)
    url = f'http://localhost:{args.port}/index.html'
    print(f'服务目录：{APP_ROOT}\n已启动：{url}\n保持此窗口开启；关闭窗口即可停止服务。', flush=True)
    print(f'SoundCraft 控制目标：127.0.0.1:{args.soundcraft_port}\n只读连接检查：http://localhost:{args.port}/api/soundcraft/status', flush=True)
    if not args.no_browser:
        webbrowser.open(url)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()

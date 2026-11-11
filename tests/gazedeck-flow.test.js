import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GazeDeckFlow, DECK_CONTROLS, DECK_PAGES } from '../src/gazedeck-flow.js';

function home() { const f = new GazeDeckFlow(); f.dispatch('右看'); f.completeSetup(true); return f; }

test('startup settings and helper calibration do not skip setup', () => {
  const f = new GazeDeckFlow();
  assert.equal(f.dispatch('上看').executed, false);
  f.dispatch('左看'); assert.equal(f.state.page, 'settings');
  f.dispatch('上看'); f.dispatch('右看'); assert.equal(f.state.page, 'setup');
  f.dispatch('右看'); assert.equal(f.state.page, 'setup');
  assert.ok(f.completeSetup()); assert.equal(f.state.page, 'home');
});

test('four main directions match advanced diagram and return paths', () => {
  for (const [gesture, page] of [['上看', 'tracks'], ['下看', 'playback'], ['左看', 'sound'], ['右看', 'speed']]) {
    const f = home(); const result = f.dispatch(gesture);
    assert.equal(f.state.page, page); assert.equal(result.to, DECK_PAGES[page]);
    f.dispatch('上看'); assert.equal(f.state.page, 'home');
  }
  assert.deepEqual(Object.keys(DECK_CONTROLS).sort(), Object.keys(DECK_PAGES).sort());
});

test('track picker uses fixed bands, restores on up and closes with the selected track on down', () => {
  const f = home(); f.dispatch('上看'); f.dispatch('右看'); f.dispatch('下看');
  assert.equal(f.state.deck, 'B');
  for (const [value, expected] of [[1, 0], [20, 0], [21, 1], [40, 1], [41, 2], [60, 2], [61, 3], [80, 3], [81, 4], [100, 4]]) assert.equal(f.trackIndex(value), expected);
  f.setPopupValue(85); assert.equal(f.deck.track, 0);
  f.dispatch('上看'); assert.equal(f.state.popup.value, 10); assert.equal(f.deck.track, 0);
  f.setPopupValue(85); f.dispatch('下看'); assert.equal(f.deck.track, 4); assert.equal(f.state.decks.A.track, 0); assert.equal(f.state.popup, null);
  f.dispatch('双眨'); assert.equal(f.deck.track, 0); assert.equal(f.state.popup, null);
});

test('cancelled volume popup never changes committed volume, undo saved change does not reopen popup', () => {
  const f = home(); f.dispatch('左看'); f.dispatch('右看');
  f.setPopupValue(14); f.dispatch('双眨'); assert.equal(f.deck.volume, 70);
  f.dispatch('右看'); f.setPopupValue(35); f.dispatch('下看'); assert.equal(f.deck.volume, 35);
  f.dispatch('双眨'); assert.equal(f.deck.volume, 70); assert.equal(f.state.popup, null);
});

test('long blink observation freezes navigation, popup movement, save and undo', () => {
  const f = home(); f.dispatch('左看'); f.dispatch('右看'); f.dispatch('长眨');
  const frozen = structuredClone(f.state);
  for (const g of ['左看', '右看', '上看', '下看', '双眨']) assert.equal(f.dispatch(g).executed, false);
  f.setPopupValue(0); assert.deepEqual(f.state, frozen);
  f.dispatch('长眨'); f.dispatch('左看'); assert.equal(f.state.popup.value, 65);
});

test('playback toggles, seek saves, deck switch and one-step undo', () => {
  const f = home(); f.tracks[0].duration = 240;
  f.dispatch('下看'); f.dispatch('左看'); assert.equal(f.deck.playing, true);
  f.dispatch('右看'); f.setPopupValue(90); f.dispatch('下看'); assert.equal(f.deck.position, 90);
  f.dispatch('下看'); assert.equal(f.state.deck, 'B'); assert.equal(f.deck.playing, false);
  f.dispatch('双眨'); assert.equal(f.state.deck, 'A'); assert.equal(f.deck.playing, true);
});

test('speed reset uses original track BPM and supports undo', () => {
  const f = home(); f.tracks[0].bpm = 110; f.dispatch('右看'); f.dispatch('右看');
  f.setPopupValue(140); f.dispatch('下看'); assert.equal(f.deck.bpm, 140);
  f.dispatch('左看'); assert.equal(f.deck.bpm, 110);
  f.dispatch('双眨'); assert.equal(f.deck.bpm, 140);
});

test('EQ subpage direction mapping and effects cycle match diagram', () => {
  const f = home(); f.dispatch('左看'); f.dispatch('左看'); assert.equal(f.state.page, 'eq');
  for (const [gesture, key] of [['下看', 'low'], ['左看', 'mid'], ['右看', 'high']]) {
    f.dispatch(gesture); assert.equal(f.state.popup.kind, key); f.setPopupValue(5); f.dispatch('下看'); assert.equal(f.deck[key], 5);
  }
  f.dispatch('上看'); f.dispatch('下看'); assert.equal(f.state.page, 'effects');
  f.dispatch('下看'); assert.equal(f.deck.effectOn, true);
  for (const type of [1, 2, 0]) { f.dispatch('右看'); assert.equal(f.deck.effectType, type); }
  f.dispatch('左看'); assert.equal(f.state.popup.kind, 'effect');
  f.dispatch('双眨'); f.dispatch('上看'); assert.equal(f.state.page, 'sound');
});

test('parameter clamps and changing library clears unsafe undo snapshots', () => {
  const f = home(); f.dispatch('上看'); f.dispatch('下看'); f.setPopupValue(-900); assert.equal(f.state.popup.value, 1);
  f.setPopupValue(10000); assert.equal(f.state.popup.value, 100);
  f.setTracks([{ name: 'New', bpm: 105, duration: 90 }]);
  assert.equal(f.state.popup, null); assert.equal(f.history.length, 0); assert.equal(f.deck.bpm, 105);
  f.dispatch('下看'); assert.equal(f.state.popup.max, 20);
});

test('independent flows never share users, decks or history', () => {
  const a = home(), b = new GazeDeckFlow();
  a.deck.volume = 10; a.dispatch('上看');
  assert.equal(b.state.page, 'boot'); assert.equal(b.deck.volume, 70); assert.equal(b.history.length, 0);
});

test('navigation return and undo preserve advancing playheads, parameters and both playback states', () => {
  const f = home(); f.deck.playing = true; f.deck.position = 30;
  f.state.decks.B.position = 10; f.state.decks.B.playing = true;
  f.dispatch('左看'); f.deck.position = 45; f.state.decks.B.position = 25;
  f.dispatch('双眨'); assert.equal(f.state.page, 'home');
  assert.equal(f.deck.position, 45); assert.equal(f.state.decks.B.position, 25);
  assert.ok(f.deck.playing && f.state.decks.B.playing);
  f.dispatch('左看'); f.deck.volume = 15; f.deck.position = 60;
  const beforeReturn = structuredClone(f.state.decks);
  f.dispatch('上看'); assert.deepEqual(f.state.decks, beforeReturn);
  f.dispatch('双眨'); assert.deepEqual(f.state.decks, beforeReturn);
});

test('parameter undo targets only the recorded deck and field, never the selected deck or elapsed time', () => {
  const f = home(); f.dispatch('左看'); f.dispatch('右看');
  f.setPopupValue(25); f.dispatch('下看');
  f.deck.position = 90; f.deck.playing = true; f.deck.bpm = 132;
  f.state.decks.B.position = 55; f.state.decks.B.volume = 42; f.state.deck = 'B';
  f.dispatch('双眨');
  assert.equal(f.state.deck, 'B'); assert.equal(f.state.decks.A.volume, 70);
  assert.equal(f.state.decks.A.position, 90); assert.equal(f.state.decks.A.bpm, 132);
  assert.ok(f.state.decks.A.playing); assert.equal(f.deck.position, 55); assert.equal(f.deck.volume, 42);
});

test('every popup restores its opening value on up without closing or changing that original anchor', () => {
  for (const kind of ['track', 'seek', 'volume', 'bpm', 'low', 'mid', 'high', 'effect']) {
    const f = home(); f.open(kind); const opening = f.state.popup.initialValue;
    const changed = opening === f.state.popup.max ? f.state.popup.min : f.state.popup.max;
    f.setPopupValue(changed); f.dispatch('上看'); assert.equal(f.state.popup.value, opening, kind);
    f.setPopupValue(changed); f.dispatch('上看'); assert.equal(f.state.popup.value, opening, kind);
    f.dispatch('下看'); assert.equal(f.state.popup, null, kind);
  }
});

test('untouched/restored seek popup never seeks backward; explicit seek undo keeps subsequently elapsed time', () => {
  const f = home(); f.tracks[0].duration = 240; f.deck.position = 30; f.deck.playing = true;
  f.open('seek'); f.deck.position = 40; f.dispatch('下看'); assert.equal(f.deck.position, 40);
  f.open('seek'); f.setPopupValue(90); f.deck.position = 50; f.dispatch('上看'); f.dispatch('下看'); assert.equal(f.deck.position, 50);
  f.open('seek'); f.setPopupValue(90); f.dispatch('下看');
  f.deck.position = 97; f.state.decks.B.position = 100; f.dispatch('双眨');
  assert.equal(f.deck.position, 57); assert.equal(f.state.decks.B.position, 100); assert.ok(f.deck.playing);
});

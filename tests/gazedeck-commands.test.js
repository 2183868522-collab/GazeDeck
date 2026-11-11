import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDeckCommand } from '../src/gazedeck-commands.js';
import { DECK_GESTURES } from '../src/gazedeck-flow.js';

test('typed directions, blinks and explicit aliases resolve to the six allowed commands', () => {
  for (const gesture of DECK_GESTURES) assert.equal(parseDeckCommand(` ${gesture} `), gesture);
  for (const [input, command] of [['UP', '上看'], ['Down', '下看'], ['left', '左看'], ['right', '右看'], ['↑', '上看'], ['↓', '下看'], ['←', '左看'], ['→', '右看'], ['observe', '长眨'], ['undo', '双眨'], ['观察', '长眨'], ['撤回', '双眨']]) assert.equal(parseDeckCommand(input), command);
});

test('unknown input, code and prototype property names are not commands', () => {
  for (const input of ['', null, undefined, 'constructor', '__proto__', 'toString', 'alert(1)', '右看;右看', '删除用户', '<script>']) assert.equal(parseDeckCommand(input), null);
});

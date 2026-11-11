import { DECK_GESTURES } from './gazedeck-flow.js';

// A small allowlist, not executable code or a free-form command evaluator.
export function parseDeckCommand(text) {
  const value = String(text ?? '').trim().toLowerCase().replace(/\s+/g, '');
  if (DECK_GESTURES.includes(value)) return value;
  const aliases = { up: '上看', down: '下看', left: '左看', right: '右看',
    '↑': '上看', '↓': '下看', '←': '左看', '→': '右看',
    observe: '长眨', undo: '双眨', '观察': '长眨', '撤回': '双眨' };
  return Object.hasOwn(aliases, value) ? aliases[value] : null;
}

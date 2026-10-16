import assert from 'node:assert/strict';
import { test } from 'node:test';
import { kitAction, slotOf } from '../src/battle/input.ts';
import { resolveGlyph } from '../src/ui/glyphs.ts';

test('shortcut slots come from 1-4 on the top row, the numpad, with Shift, and from the gamepad chord', () => {
  assert.equal(slotOf('1', 'Digit1'), 0);
  assert.equal(slotOf('!', 'Digit1'), 0); // Shift + 1 (US)
  assert.equal(slotOf('"', 'Digit2'), 1); // Shift + 2 (German layout)
  assert.equal(slotOf('4', 'Numpad4'), 3);
  assert.equal(slotOf('3', ''), 2); // gamepad L1 + ✕ arrives as a bare key
  assert.equal(slotOf('5', 'Digit5'), null);
  assert.equal(slotOf('f', 'KeyF'), null);
});

test('battle actions draw the kit glyphs of the battle layout', () => {
  const pad = (a: Parameters<typeof kitAction>[0]) => resolveGlyph(kitAction(a), 'ps').map((p) => ('atlas' in p ? p.atlas : p.key));
  const kb = (a: Parameters<typeof kitAction>[0]) => resolveGlyph(kitAction(a), 'kb').map((p) => ('atlas' in p ? p.atlas : p.key));
  assert.deepEqual(kb('attack'), ['F']);
  assert.deepEqual(kb('commands'), ['Space']);
  assert.deepEqual(kb('guard'), ['G']);
  assert.deepEqual(kb('escape'), ['Q', 'R']);
  assert.deepEqual(pad('attack'), ['ps-square']);
  assert.deepEqual(pad('commands'), ['ps-cross']);
  assert.deepEqual(pad('guard'), ['ps-r1']);
  assert.deepEqual(pad('shortcuts'), ['ps-l1']);
  // the palette diamond: △ top, ○ right, ✕ bottom, □ left
  assert.deepEqual(
    ['slot1', 'slot2', 'slot3', 'slot4'].map((s) => pad(s as 'slot1')[0]),
    ['ps-triangle', 'ps-circle', 'ps-cross', 'ps-square'],
  );
  assert.deepEqual(pad('assign')[0], 'ps-l1');
});

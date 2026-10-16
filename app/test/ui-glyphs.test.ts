import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PAD_INDEX, padFamily, padGlyph, pickDevice, resolveGlyph } from '../src/ui/glyphs.ts';

test('pad make: Sony pads get PlayStation glyphs, everything else Xbox-style ones', () => {
  assert.equal(padFamily('DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)'), 'ps');
  assert.equal(padFamily('Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)'), 'ps');
  assert.equal(padFamily('Xbox 360 Controller (XInput STANDARD GAMEPAD)'), 'xbox');
  assert.equal(padFamily('8BitDo Pro 2 (Vendor: 2dc8 Product: 6006)'), 'xbox');
  assert.equal(padFamily(''), 'xbox');
});

test('Auto follows the last device; a fixed choice wins', () => {
  assert.equal(pickDevice('auto', 'kb', 'Xbox 360 Controller'), 'kb');
  assert.equal(pickDevice('auto', 'pad', 'DualSense (Vendor: 054c)'), 'ps');
  assert.equal(pickDevice('auto', 'pad', null), 'xbox');
  assert.equal(pickDevice('ps', 'kb', null), 'ps');
  assert.equal(pickDevice('kb', 'pad', 'DualSense'), 'kb');
});

test('actions resolve to the same physical button on both pad families', () => {
  assert.deepEqual(resolveGlyph('confirm', 'ps'), [{ atlas: 'ps-cross' }]);
  assert.deepEqual(resolveGlyph('confirm', 'xbox'), [{ atlas: 'xb-a' }]);
  assert.deepEqual(resolveGlyph('back', 'ps'), [{ atlas: 'ps-circle' }]);
  assert.deepEqual(resolveGlyph('attack', 'xbox'), [{ atlas: 'xb-x' }]); // west, as gamepad.ts's battle layout
  assert.deepEqual(resolveGlyph('guard', 'ps'), [{ atlas: 'ps-r1' }]);
  assert.deepEqual(resolveGlyph('escape', 'xbox'), [{ atlas: 'xb-lt' }, { atlas: 'xb-rt' }]);
  assert.equal(padGlyph('start', 'ps'), 'ps-options');
  assert.equal(padGlyph('start', 'xbox'), 'xb-menu');
  assert.equal(padGlyph('dpad-ud', 'ps'), 'dpad-ud');
});

test('keyboard: fixed keys, mouse glyphs, and rebindable keys from the caller', () => {
  assert.deepEqual(resolveGlyph('confirm', 'kb'), [{ key: 'Enter' }]);
  assert.deepEqual(resolveGlyph('look', 'kb'), [{ atlas: 'mouse-move' }]);
  const bound = (a: string) => (a === 'interact' ? ['F'] : null);
  assert.deepEqual(resolveGlyph('interact', 'kb', bound), [{ key: 'F' }]);
  assert.deepEqual(resolveGlyph('back', 'kb', bound), [{ key: 'Esc' }]);
});

test('rebound pad buttons replace the default glyph', () => {
  assert.deepEqual(resolveGlyph('run', 'xbox'), [{ atlas: 'xb-rt' }]);
  assert.deepEqual(resolveGlyph('run', 'xbox', undefined, (a) => (a === 'run' ? [PAD_INDEX[2]] : null)), [{ atlas: 'xb-x' }]);
  assert.deepEqual(resolveGlyph('confirm', 'ps', undefined, () => null), [{ atlas: 'ps-cross' }]);
  assert.equal(PAD_INDEX[11], 'r3');
});

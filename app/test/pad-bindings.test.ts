import assert from 'node:assert/strict';
import { test } from 'node:test';
import { settings } from '../src/game/settings.ts';

test('gamepad bindings: defaults, rebinding, a button does one thing, reset', () => {
  settings.resetPad();
  assert.deepEqual(settings.padButtons('run'), [5, 7]);
  assert.deepEqual(settings.padButtons('menu'), [3]);
  // X / □ runs now; nothing else had it
  settings.bindPad('run', 2);
  assert.deepEqual(settings.padButtons('run'), [2]);
  // Y / △ (the menu's button) for running: the menu loses it and has nothing left
  settings.bindPad('run', 3);
  assert.deepEqual(settings.padButtons('run'), [3]);
  assert.deepEqual(settings.padButtons('menu'), []);
  // the menu gets X / □; binding back to the default drops the override
  settings.bindPad('menu', 2);
  assert.deepEqual(settings.padButtons('menu'), [2]);
  settings.bindPad('menu', 3);
  assert.deepEqual(settings.padButtons('menu'), [3]);
  assert.equal(settings.s.controls.pad.menu, undefined);
  assert.deepEqual(settings.padButtons('run'), [5, 7]);
  settings.resetPad();
  assert.deepEqual(settings.s.controls.pad, {});
});

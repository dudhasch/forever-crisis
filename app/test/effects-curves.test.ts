import assert from 'node:assert/strict';
import { test } from 'node:test';
import { curve, curveMax, gradient, rng } from '../src/effects/curves.ts';

test('MinMaxCurve forms: constant, random between constants, sampled curve, random between curves', () => {
  assert.equal(curve(2.5, 0.3), 2.5);
  assert.equal(curve([1, 3], 0, 0), 1);
  assert.equal(curve([1, 3], 0, 1), 3);
  assert.equal(curve([1, 3], 0, 0.5), 2);
  const ramp = { c: [0, 1, 2, 3, 4] };
  assert.equal(curve(ramp, 0), 0);
  assert.equal(curve(ramp, 1), 4);
  assert.equal(curve(ramp, 0.5), 2);
  assert.equal(curve(ramp, 0.625), 2.5); // linear between samples
  assert.equal(curve(ramp, 2), 4); // clamped
  assert.equal(curve({ c: [2, 2], d: [0, 0] }, 0.4, 0.25), 0.5);
  assert.equal(curve(undefined, 0.5, 0.5, 7), 7);
  assert.equal(curveMax({ c: [0, 5, 1], d: [6, 0, 0] }), 6);
});

test('MinMaxGradient forms: constant, two colours, sampled gradient, random colour', () => {
  const out = [0, 0, 0, 0];
  gradient([0.1, 0.2, 0.3, 0.4], 0.9, 0.5, out);
  assert.deepEqual(out, [0.1, 0.2, 0.3, 0.4]);
  gradient({ a: [0, 0, 0, 0], b: [1, 1, 1, 1] }, 0, 0.25, out);
  assert.deepEqual(out, [0.25, 0.25, 0.25, 0.25]);
  const g = { g: [0, 0, 0, 1, 1, 1, 1, 0] }; // black opaque -> white transparent
  gradient(g, 0.5, 0, out);
  assert.deepEqual(out, [0.5, 0.5, 0.5, 0.5]);
  gradient({ g: g.g, rand: 1 }, 0, 1, out); // random colour picks along the gradient by r
  assert.deepEqual(out, [1, 1, 1, 0]);
  gradient(undefined, 0, 0, out);
  assert.deepEqual(out, [1, 1, 1, 1]);
});

test('seeded random is repeatable and in 0..1', () => {
  const a = rng(42), b = rng(42);
  for (let i = 0; i < 100; i++) {
    const x = a();
    assert.equal(x, b());
    assert.ok(x >= 0 && x < 1);
  }
});

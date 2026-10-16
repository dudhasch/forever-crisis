import type { Curve, Gradient } from './types';

/** Sampled curve (evenly spaced over 0..1) at t, linear between samples. */
function sampleAt(s: number[], t: number) {
  const n = s.length - 1;
  if (n <= 0) return s[0] ?? 0;
  const x = Math.min(1, Math.max(0, t)) * n;
  const i = Math.min(n - 1, Math.floor(x));
  const f = x - i;
  return s[i] + (s[i + 1] - s[i]) * f;
}

/**
 * MinMaxCurve value at normalised time t; r (0..1) picks between the two bounds of the random modes, so a particle
 * keeps its own value by passing the same r every frame.
 */
export function curve(c: Curve | undefined, t: number, r = 0.5, fallback = 0): number {
  if (c === undefined) return fallback;
  if (typeof c === 'number') return c;
  if (Array.isArray(c)) return c[0] + (c[1] - c[0]) * r;
  const a = sampleAt(c.c, t);
  return c.d ? sampleAt(c.d, t) + (a - sampleAt(c.d, t)) * r : a;
}

/** Largest value a curve can take (durations, lifetimes). */
export function curveMax(c: Curve | undefined, fallback = 0): number {
  if (c === undefined) return fallback;
  if (typeof c === 'number') return c;
  if (Array.isArray(c)) return Math.max(c[0], c[1]);
  return Math.max(...c.c, ...(c.d ?? []));
}

export function isConstant(c: Curve | undefined) {
  return c === undefined || typeof c === 'number';
}

function gradAt(s: number[], t: number, out: Float32Array | number[], o: number) {
  const n = s.length / 4 - 1;
  if (n <= 0) {
    out[o] = s[0];
    out[o + 1] = s[1];
    out[o + 2] = s[2];
    out[o + 3] = s[3];
    return;
  }
  const x = Math.min(1, Math.max(0, t)) * n;
  const i = Math.min(n - 1, Math.floor(x));
  const f = x - i;
  for (let k = 0; k < 4; k++) out[o + k] = s[i * 4 + k] + (s[i * 4 + 4 + k] - s[i * 4 + k]) * f;
}

/** MinMaxGradient colour at t into out[o..o+3]; r picks between the random bounds. */
export function gradient(g: Gradient | undefined, t: number, r: number, out: Float32Array | number[], o = 0) {
  if (!g) {
    out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 1;
    return;
  }
  if (Array.isArray(g)) {
    out[o] = g[0];
    out[o + 1] = g[1];
    out[o + 2] = g[2];
    out[o + 3] = g[3];
    return;
  }
  if ('a' in g) {
    for (let k = 0; k < 4; k++) out[o + k] = g.a[k] + (g.b[k] - g.a[k]) * r;
    return;
  }
  if (g.rand) {
    gradAt(g.g, r, out, o);
    return;
  }
  gradAt(g.g, t, out, o);
  if (g.h) {
    const tmp = [0, 0, 0, 0];
    gradAt(g.h, t, tmp, 0);
    for (let k = 0; k < 4; k++) out[o + k] = tmp[k] + (out[o + k] - tmp[k]) * r;
  }
}

/** Small fast seeded random (mulberry32). */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

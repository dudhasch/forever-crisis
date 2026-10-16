/** Easing curves named like the scripts' EASE_* constants (DOTween naming). */
const PI = Math.PI;
const out = (f: (t: number) => number) => (t: number) => 1 - f(1 - t);
const inOut = (f: (t: number) => number) => (t: number) => (t < 0.5 ? f(t * 2) / 2 : 1 - f((1 - t) * 2) / 2);

const IN: Record<string, (t: number) => number> = {
  SINE: (t) => 1 - Math.cos((t * PI) / 2),
  QUAD: (t) => t * t,
  CUBIC: (t) => t * t * t,
  QUART: (t) => t ** 4,
  QUINT: (t) => t ** 5,
  EXPO: (t) => (t === 0 ? 0 : 2 ** (10 * t - 10)),
  CIRC: (t) => 1 - Math.sqrt(1 - t * t),
  BACK: (t) => 2.70158 * t * t * t - 1.70158 * t * t,
};

/** "EASE_IN_OUT_SINE" -> easing function; unknown names are linear. */
export function easing(name: unknown): (t: number) => number {
  const m = typeof name === 'string' ? /^EASE_(IN_OUT|IN|OUT)_([A-Z]+)$/.exec(name) : null;
  const f = m ? IN[m[2]] : undefined;
  if (!m || !f) return (t) => t;
  return m[1] === 'IN' ? f : m[1] === 'OUT' ? out(f) : inOut(f);
}

/** A value animated over time by the story director. */
export class Tween<T> {
  private t = 0;
  constructor(
    readonly from: T,
    readonly to: T,
    readonly duration: number,
    readonly ease: (t: number) => number,
    readonly lerp: (a: T, b: T, k: number) => T,
  ) {}

  get done() {
    return this.t >= this.duration;
  }

  step(dt: number): T {
    this.t = Math.min(this.duration, this.t + dt);
    const k = this.duration > 0 ? this.ease(this.t / this.duration) : 1;
    return this.lerp(this.from, this.to, k);
  }
}

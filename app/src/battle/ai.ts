import type { BrainDef, BrainNode, Condition } from './data';

/**
 * Ever Crisis enemy behaviour trees, played turn by turn.
 *
 * In EC the tree runs in real time (SleepNodes wait between skills). Here an enemy asks its tree once per full
 * ATB gauge: the walk skips sleeps and turn markers and stops at the first skill it reaches. Sequences keep
 * their position between turns, so rotations (attack, attack, special) play out like in the game.
 * Conditions whose property is known are evaluated; unknown ones count as false, which picks the tree's
 * default branch.
 */

export interface BrainContext {
  /** Own HP in percent. */
  hpPercent: number;
  /** Own actions so far. */
  turns: number;
  /** Living members of the enemy's own side. */
  allies: number;
  /** Living party members. */
  opponents: number;
  enemyId: number;
}

// NumericOperators from the client metadata.
function compare(op: number, a: number, b: number) {
  switch (op) {
    case 0:
      return a === b;
    case 1:
      return a !== b;
    case 2:
      return a >= b;
    case 3:
      return a > b;
    case 4:
      return a <= b;
    case 5:
      return a < b;
  }
  return false;
}

function value(c: Condition, ctx: BrainContext): number | null {
  if (c.c === 'Float') {
    // HP rate checks (0..1) on self or the target.
    if (c.property === 0) return ctx.hpPercent / 100;
    return null;
  }
  switch (c.property) {
    case 15:
      return ctx.hpPercent;
    case 11:
    case 12:
    case 13:
      return ctx.turns;
    case 16:
      return ctx.turns % 3;
    case 18:
      return ctx.allies;
    case 19:
      return ctx.enemyId;
    case 0:
      return ctx.opponents;
  }
  return null;
}

function check(c: Condition, ctx: BrainContext) {
  if (c.c === 'Boolean') return false;
  const v = value(c, ctx);
  if (v === null || c.useConst === 0) return false;
  return compare(c.calcOperator ?? 0, v, c.constValue ?? 0);
}

export class Brain {
  private cursor = new Map<number, number>();
  private executed = new Map<number, number>();

  constructor(private readonly tree: BrainDef) {}

  /** The m_skill_enemy id to use this turn, or null to let the caller pick one. */
  next(ctx: BrainContext): number | null {
    for (let pass = 0; pass < 6; pass++) {
      const s = this.run(this.tree.root, ctx, 0);
      if (s !== null) return s;
    }
    return null;
  }

  private run(id: number | null, ctx: BrainContext, depth: number): number | null {
    if (id === null || depth > 40) return null;
    const n: BrainNode | undefined = this.tree.nodes[id];
    if (!n) return null;
    switch (n.t) {
      case 'EnemySkill':
      case 'PhaseSkill': {
        if (!n.skill) return null;
        const count = this.executed.get(id) ?? 0;
        if (n.max && count >= n.max) return null;
        this.executed.set(id, count + 1);
        return n.skill;
      }
      case 'Sequence': {
        const paths = n.p ?? [];
        if (!paths.length) return null;
        let at = this.cursor.get(id) ?? 0;
        for (let i = 0; i < paths.length; i++) {
          const p = paths[at % paths.length];
          at = (at + 1) % paths.length;
          if (p.c.every((c) => check(c, ctx))) {
            const s = this.run(p.n, ctx, depth + 1);
            if (s !== null) {
              this.cursor.set(id, at);
              return s;
            }
          }
        }
        this.cursor.set(id, at);
        return null;
      }
      default: {
        // Root, Priority, Selector-likes: first path whose conditions hold.
        for (const p of n.p ?? []) {
          if (p.c.every((c) => check(c, ctx))) return this.run(p.n, ctx, depth + 1);
        }
        return null;
      }
    }
  }
}

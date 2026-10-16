import * as THREE from 'three';
import './fieldhud.css';
import { h } from '../ui';
import { enter, glyphEl, motionReduced } from '../ui/kit';
import type { StoryMarker } from '../story/director';
import type { CollisionWorld } from './collision';
import { Minimap, type MapMarker } from './minimap';

/**
 * The walking HUD in the style of FF7 Remake / Rebirth, on the UI kit: the round minimap in the top-right corner
 * (with the area name under it) and the interaction prompt — the interact button's glyph and a verb ("Talk",
 * "Examine", "Climb") floating next to the thing it acts on. Dialogue boxes are not part of this.
 */

/** What the HUD reads from the app every frame (main.ts's App fits it). */
export interface FieldHudHost {
  readonly map: { readonly entry: { title: string }; readonly collision: CollisionWorld | null; readonly gimmicks: { position: THREE.Vector3 }[] } | null;
  readonly rig: { readonly camera: THREE.PerspectiveCamera };
  readonly controller: { readonly position: THREE.Vector3 };
  readonly heading: number;
  readonly npcs: { character: { root: THREE.Object3D; height?: number } }[];
  readonly exits: { position: THREE.Vector3 }[];
  readonly boxes: { closedPositions(): THREE.Vector3[] } | null;
  readonly transports: { position: [number, number, number]; auto: boolean }[];
  readonly story: { markers(): StoryMarker[] } | null;
  readonly focus: FocusLike | null;
}

/** main.ts's Interactable, as far as the prompt needs it. */
interface FocusLike {
  kind: string;
  label: string;
  npc?: { entry: { name: string }; character: { root: THREE.Object3D } };
  exit?: { position: THREE.Vector3 };
  gimmick?: { position: THREE.Vector3 };
  def?: { position: [number, number, number] };
  prompt?: { position?: THREE.Vector3 };
  id?: number;
}

const MARKER_SECONDS = 0.5;

export class FieldHud {
  readonly root = h('div', { class: 'rm fh' });
  private mapBox = h('div', { class: 'fh-map' });
  private minimap = new Minimap();
  private arrow = h('div', { class: 'fh-map__arrow' });
  private area = h('div', { class: 'fh-map__area' });
  private dist = h('div', { class: 'fh-map__dist' });
  private prompt = h('div', { class: 'fh-prompt' });
  private promptVerb = h('span', { class: 'fh-prompt__verb' });
  private promptName = h('span', { class: 'fh-prompt__name' });
  private promptKey = '';
  private world: CollisionWorld | null | undefined = undefined;
  private markers: MapMarker[] = [];
  private markerAge = MARKER_SECONDS;
  private shown = false;
  private v = new THREE.Vector3();

  constructor(
    parent: HTMLElement,
    private readonly host: FieldHudHost,
  ) {
    this.mapBox.append(h('div', { class: 'fh-map__base' }), this.minimap.canvas, this.arrow, h('div', { class: 'fh-map__ring' }), this.dist);
    this.prompt.append(glyphEl('interact'), this.promptVerb, this.promptName);
    this.root.append(h('div', { class: 'fh-corner' }, this.mapBox, this.area), this.prompt);
    this.root.hidden = true;
    this.prompt.hidden = true;
    parent.append(this.root);
  }

  /** Every frame. `free` = the player walks around (no menu, battle, cutscene, dialogue or loading). */
  update(dt: number, free: boolean) {
    const host = this.host;
    const map = host.map;
    if (map?.collision !== this.world) {
      this.world = map?.collision;
      this.minimap.setWorld(this.world ?? null);
      this.markerAge = MARKER_SECONDS;
    }
    const visible = free && !!map;
    if (visible !== this.shown) {
      this.shown = visible;
      this.root.hidden = !visible;
      if (visible) void enter(this.mapBox.parentElement as HTMLElement, 'fade');
    }
    if (!visible || !map) return;
    this.area.textContent = map.entry.title;
    this.mapBox.hidden = !this.minimap.hasMap;
    if (this.minimap.hasMap) {
      this.markerAge += dt;
      if (this.markerAge >= MARKER_SECONDS) {
        this.markerAge = 0;
        this.markers = this.collectMarkers();
      }
      const size = this.minimap.canvas.clientWidth || 256;
      const r = this.minimap.draw(dt, size, host.rig.camera, host.controller.position, host.heading, this.markers, motionReduced());
      this.arrow.style.transform = `rotate(${r.arrow}rad)`;
      this.dist.textContent = r.objective !== null && r.objective > 3 ? `${Math.round(r.objective)}m` : '';
    }
    this.updatePrompt();
  }

  private collectMarkers(): MapMarker[] {
    const host = this.host;
    const out: MapMarker[] = [];
    for (const m of host.story?.markers() ?? []) out.push(m);
    if (!host.story) {
      for (const n of host.npcs) out.push({ kind: 'npc', position: n.character.root.position });
      for (const x of host.exits) out.push({ kind: 'exit', position: x.position });
      for (const p of host.boxes?.closedPositions() ?? []) out.push({ kind: 'treasure', position: p });
    }
    for (const t of host.transports) if (!t.auto) out.push({ kind: 'ladder', position: new THREE.Vector3().fromArray(t.position) });
    return out;
  }

  /** Where the focused thing is (a little above it), or null when the HUD cannot tell. */
  private focusPoint(f: FocusLike): THREE.Vector3 | null {
    if (f.npc) return this.v.copy(f.npc.character.root.position).add(UP_HEAD);
    // ladders and exits: the player stands on the spot, so the prompt goes over their head
    if (f.def && f.kind === 'transport') return this.v.fromArray(f.def.position).add(UP_HEAD);
    const p = f.exit?.position ?? f.gimmick?.position ?? f.prompt?.position ?? (f.def ? this.v.fromArray(f.def.position) : null);
    if (p) return this.v.copy(p).add(UP);
    if (f.kind === 'treasure' && this.host.boxes) {
      // the closed box nearest the player
      const me = this.host.controller.position;
      let best: THREE.Vector3 | null = null;
      for (const b of this.host.boxes.closedPositions()) if (!best || b.distanceToSquared(me) < best.distanceToSquared(me)) best = b;
      if (best) return this.v.copy(best).add(UP);
    }
    return null;
  }

  private updatePrompt() {
    const f = this.host.focus;
    if (!f) {
      this.prompt.hidden = true;
      this.promptKey = '';
      return;
    }
    const { verb, name } = splitLabel(f.label);
    const key = `${f.kind}|${verb}|${name}`;
    if (key !== this.promptKey) {
      this.promptKey = key;
      this.promptVerb.textContent = verb;
      this.promptName.textContent = name;
      this.prompt.hidden = false;
      void enter(this.prompt, 'up');
    }
    // float next to the thing; in the lower middle of the screen when it is behind the camera or off screen
    const p = this.focusPoint(f);
    const cam = this.host.rig.camera;
    const W = this.root.clientWidth || innerWidth;
    const H = this.root.clientHeight || innerHeight;
    let x = W / 2;
    let y = H * 0.72;
    let anchored = false;
    if (p) {
      const v = p.clone().project(cam);
      const inFront = v.z > -1 && v.z < 1;
      const sx = (v.x * 0.5 + 0.5) * W;
      const sy = (-v.y * 0.5 + 0.5) * H;
      if (inFront && sx > 0 && sx < W && sy > 0 && sy < H) {
        x = Math.min(W - 140, Math.max(140, sx));
        y = Math.min(H - 60, Math.max(60, sy));
        anchored = true;
      }
    }
    this.prompt.classList.toggle('is-anchored', anchored);
    this.prompt.style.left = `${Math.round(x)}px`;
    this.prompt.style.top = `${Math.round(y)}px`;
  }

  dispose() {
    this.root.remove();
  }
}

const UP = new THREE.Vector3(0, 1.1, 0);
const UP_HEAD = new THREE.Vector3(0, 1.95, 0);

/** "Talk to <b>Wedge</b>" -> verb "Talk", name "Wedge"; "Climb <b>up</b>" -> "Climb", "up". */
export function splitLabel(html: string): { verb: string; name: string } {
  const m = /^(.*?)<b>(.*?)<\/b>(.*)$/.exec(html);
  const text = (s: string) => s.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
  if (!m) return { verb: text(html), name: '' };
  let verb = text(m[1]);
  // "Talk to Wedge": Remake shows the verb alone over the person
  verb = verb.replace(/^Talk to$/i, 'Talk');
  return { verb: verb || text(m[2]), name: verb ? text(m[2] + m[3]) : '' };
}

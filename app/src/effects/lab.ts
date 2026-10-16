import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { loadGLTF } from '../assets';
import { EffectPlayer, effectLibrary, playStageAmbience, type EffectInstance } from './player';

/**
 * Dev-only effects lab (fxlab.html): plays one converted EC effect at a time around a battle model, optionally on
 * a battle stage with its ambience. Its module graph is just three + src/effects, so edits elsewhere in the app
 * do not reload it. Scriptable from the console as `window.lab`.
 */

const canvas = document.getElementById('lab') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x151b24);
const camera = new THREE.PerspectiveCamera(40, 1, 0.05, 2000);
camera.position.set(4.5, 2.6, 6);
const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 1, 0);
scene.add(new THREE.HemisphereLight(0xd8e4ff, 0x30281e, 2.2));
const sun = new THREE.DirectionalLight(0xffffff, 1.5);
sun.position.set(3, 6, 4);
scene.add(sun);
const grid = new THREE.GridHelper(20, 20, 0x3a4658, 0x252d3a);
scene.add(grid);

const player = new EffectPlayer();
scene.add(player.group);
let speed = 1;
let stage: THREE.Object3D | null = null;

/** Battle model standing in for the actor (faces +z); the target stands 4 m in front. */
const actor = new THREE.Group();
const target = new THREE.Group();
target.position.set(0, 0, 4);
target.rotation.y = Math.PI;
scene.add(actor, target);
async function model(url: string, into: THREE.Group) {
  const g = await loadGLTF(url).catch(() => null);
  if (!g) return;
  into.clear();
  into.add(g.scene.clone(true));
}
void model('/lib/unity/character/001/model/001/model.glb', actor);
void model('/lib/unity/monster/001/model/001/model.glb', target);

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

const info = document.getElementById('info')!;
let last = performance.now();
let frames = 0, fpsT = 0, fps = 0;
/** Advance effects by dt seconds and draw one frame. */
function step(dt: number) {
  player.update(dt, camera);
  controls.update();
  renderer.render(scene, camera);
}
function loop(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  frames++;
  fpsT += dt;
  if (fpsT > 0.5) {
    fps = Math.round(frames / fpsT);
    frames = 0;
    fpsT = 0;
    info.textContent = `${fps} fps · ${player.stats.instances} effects · ${renderer.info.render.calls} draws`;
  }
  step(dt * speed);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

async function play(key: string, opts: { at?: 'actor' | 'target'; offset?: number[]; angles?: number[]; scale?: number[] } = {}): Promise<EffectInstance | null> {
  const on = opts.at === 'target' ? target : actor;
  return player.spawn(key, { position: on.position.clone(), quaternion: on.quaternion.clone(), offset: opts.offset, angles: opts.angles, scale: opts.scale });
}

async function loadStage(env: number) {
  if (stage) stage.removeFromParent();
  const g = await loadGLTF(`/lib/unity/scenes/environment_${String(env).padStart(4, '0')}/model.glb`).catch(() => null);
  if (g) {
    stage = g.scene;
    scene.add(stage);
    grid.visible = false;
  }
  return playStageAmbience(player, env);
}

const keyIn = document.getElementById('key') as HTMLInputElement;
document.getElementById('play')!.onclick = () => void play(keyIn.value.trim());
keyIn.onkeydown = (e) => {
  if (e.key === 'Enter') void play(keyIn.value.trim());
};
(document.getElementById('speed') as HTMLInputElement).oninput = (e) => (speed = Number((e.target as HTMLInputElement).value));
document.getElementById('loadStage')!.onclick = () => void loadStage(Number((document.getElementById('stage') as HTMLInputElement).value));
void effectLibrary.entries().then((all) => {
  const list = document.getElementById('keys')!;
  for (const k of Object.keys(all).filter((k) => k.startsWith('battle/common')).slice(0, 400)) {
    const o = document.createElement('option');
    o.value = k;
    list.append(o);
  }
});

const lab = {
  THREE,
  scene,
  camera,
  controls,
  player,
  actor,
  target,
  play,
  loadStage,
  /** Freeze (speed 0) and step manually for screenshots. */
  setSpeed: (s: number) => (speed = s),
  step: (dt: number, n = 1) => {
    for (let i = 0; i < n; i++) step(dt);
  },
  clear: () => player.stopAll(),
  model,
};
(window as unknown as { lab: typeof lab }).lab = lab;

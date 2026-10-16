import { assetUrl } from '../platform/source';
import { h } from '../ui';

/** Game markup (`<c_color=…>`, ruby tags) is dropped; line breaks stay. */
export function plainText(s: string) {
  return s.replace(/<[^>]*>/g, '').replace(/\\n/g, '\n');
}

const COLORS: Record<string, string> = { Black: '#000', White: '#fff', Red: '#8a0000' };
export function cssColor(c: unknown) {
  return (typeof c === 'string' && COLORS[c]) || '#000';
}

/**
 * Screen-space pieces of a cutscene. Layer order, bottom to top: world fade (FADE_3D), background still,
 * speech bubbles, talk window, narration, location name, choices, card, UI fade (FADE_UI), movie.
 */
export class StoryOverlay {
  readonly root = h('div', { class: 'story' });
  private envFade = h('div', { class: 'story-fade' });
  private uiFade = h('div', { class: 'story-fade top' });
  private still = h('img', { class: 'story-still hidden', alt: '' }) as HTMLImageElement;
  private bubbleLayer = h('div', { class: 'story-bubbles' });
  private talkEl = h('div', { class: 'story-talk hidden' });
  private narrationEl = h('div', { class: 'story-narration hidden' });
  private locationEl = h('div', { class: 'story-location hidden' });
  private choicesEl = h('div', { class: 'story-choices hidden' });
  private cardEl = h('div', { class: 'story-card hidden' });
  private barEl = h('div', { class: 'story-bar hidden' });
  private bubbles = new Map<string, HTMLElement>();
  private video: HTMLVideoElement | null = null;
  private locationTimer = 0;
  private choiceResolve: ((i: number) => void) | null = null;

  constructor(parent: HTMLElement) {
    this.root.append(
      this.envFade,
      this.still,
      this.bubbleLayer,
      this.talkEl,
      this.narrationEl,
      this.locationEl,
      this.choicesEl,
      this.cardEl,
      this.barEl,
      this.uiFade,
    );
    parent.prepend(this.root);
  }

  /** 0 = clear, 1 = covered. `ui` covers everything; otherwise only the world (talk stays readable). */
  setFade(ui: boolean, amount: number, color = '#000') {
    const el = ui ? this.uiFade : this.envFade;
    el.style.background = color;
    el.style.opacity = String(Math.max(0, Math.min(1, amount)));
  }

  showStill(url: string | null) {
    this.still.classList.toggle('hidden', !url);
    if (url) this.still.src = assetUrl(url);
    else this.still.removeAttribute('src');
  }

  /** A speech bubble owned by `key` (character + slot); place it each frame with placeBubble(). */
  bubble(key: string, speaker: string, text: string) {
    let el = this.bubbles.get(key);
    if (!el) {
      el = h('div', { class: 'story-bubble' });
      this.bubbles.set(key, el);
      this.bubbleLayer.append(el);
    }
    el.replaceChildren(speaker ? h('div', { class: 'speaker' }, speaker) : '', h('div', { class: 'line' }, plainText(text)));
    return el;
  }

  closeBubble(key: string) {
    this.bubbles.get(key)?.remove();
    this.bubbles.delete(key);
  }

  /** Remove the bubbles whose key starts with `prefix` (all of a character's slots). */
  closeBubbles(prefix = '') {
    for (const k of [...this.bubbles.keys()]) if (k.startsWith(prefix)) this.closeBubble(k);
  }

  get bubbleKeys() {
    return [...this.bubbles.keys()];
  }

  /** Anchor a bubble at screen point (x, y) using the game's pivot names (TL … BR = which corner sits on the point). */
  placeBubble(key: string, x: number, y: number, pivot: string, visible: boolean) {
    const el = this.bubbles.get(key);
    if (!el) return;
    const px = pivot[1] === 'L' ? 0 : pivot[1] === 'R' ? -100 : -50;
    const py = pivot[0] === 'T' ? 0 : pivot[0] === 'B' ? -100 : -50;
    el.style.transform = `translate(${x}px, ${y}px) translate(${px}%, ${py}%)`;
    el.style.visibility = visible ? 'visible' : 'hidden';
  }

  showTalk(speaker: string, text: string) {
    this.talkEl.classList.remove('hidden');
    this.talkEl.replaceChildren(speaker ? h('div', { class: 'speaker' }, speaker) : '', h('div', { class: 'line' }, plainText(text)));
  }

  hideTalk() {
    this.talkEl.classList.add('hidden');
  }

  /** The ▼ marker on whatever text is waiting for E. */
  setWaiting(on: boolean) {
    this.root.classList.toggle('waiting', on);
  }

  showNarration(speaker: string, text: string) {
    this.narrationEl.classList.remove('hidden');
    this.narrationEl.replaceChildren(speaker ? h('div', { class: 'speaker' }, speaker) : '', h('div', { class: 'line' }, plainText(text)));
  }

  hideNarration() {
    this.narrationEl.classList.add('hidden');
  }

  showLocation(text: string, seconds = 3) {
    this.locationEl.textContent = plainText(text);
    this.locationEl.classList.remove('hidden');
    clearTimeout(this.locationTimer);
    this.locationTimer = window.setTimeout(() => this.locationEl.classList.add('hidden'), seconds * 1000);
  }

  hideLocation() {
    this.locationEl.classList.add('hidden');
  }

  /** Choice window; resolves with the 0-based index. Arrow keys / W S move, E picks. */
  choose(options: string[]): Promise<number> {
    this.cancelChoice();
    let sel = 0;
    const buttons = options.map((o, i) =>
      h('button', { class: 'choice', onclick: () => this.pickChoice(i), onmouseenter: () => mark(i) }, plainText(o)),
    );
    const mark = (i: number) => {
      sel = i;
      buttons.forEach((b, j) => b.classList.toggle('active', j === i));
    };
    mark(0);
    this.choicesEl.replaceChildren(...buttons);
    this.choicesEl.classList.remove('hidden');
    this.choiceMove = (d: number) => mark((sel + d + options.length) % options.length);
    this.choicePick = () => this.pickChoice(sel);
    return new Promise((r) => (this.choiceResolve = r));
  }
  choiceMove: ((d: number) => void) | null = null;
  choicePick: (() => void) | null = null;

  get choosing() {
    return !!this.choiceResolve;
  }

  private pickChoice(i: number) {
    const r = this.choiceResolve;
    this.choiceResolve = null;
    this.choiceMove = this.choicePick = null;
    this.choicesEl.classList.add('hidden');
    r?.(i);
  }

  private cancelChoice() {
    if (this.choiceResolve) this.pickChoice(0);
  }

  /** A centred title card (battles, episode end). */
  showCard(html: string | null) {
    this.cardEl.classList.toggle('hidden', !html);
    if (html) this.cardEl.innerHTML = html;
  }

  /** The strip that says a cutscene is running and how to skip it. */
  setBar(html: string | null) {
    this.barEl.classList.toggle('hidden', !html);
    if (html) this.barEl.innerHTML = html;
  }

  /** Play a movie full screen; resolves when it ends, fails or is skipped. */
  playMovie(url: string): Promise<void> {
    this.stopMovie();
    const v = h('video', { class: 'story-movie', src: assetUrl(url), autoplay: true, playsinline: true }) as HTMLVideoElement;
    v.volume = this.movieVolume;
    this.video = v;
    this.root.append(v);
    return new Promise((resolve) => {
      const done = () => {
        if (this.video === v) this.stopMovie();
        resolve();
      };
      v.addEventListener('ended', done);
      v.addEventListener('error', done);
      v.addEventListener('emptied', done);
      v.play().catch(done);
    });
  }

  stopMovie() {
    const v = this.video;
    this.video = null;
    if (v) {
      v.pause();
      v.removeAttribute('src');
      v.load();
      v.remove();
    }
  }

  get moviePlaying() {
    return !!this.video;
  }

  /** Movie sound level (Settings → Audio → Music). */
  movieVolume = 1;

  setMovieVolume(v: number) {
    this.movieVolume = v;
    if (this.video) this.video.volume = v;
  }

  /** Pause menu over a movie. */
  pauseMovie(on: boolean) {
    const v = this.video;
    if (!v) return;
    if (on) v.pause();
    else void v.play().catch(() => {});
  }

  reset() {
    this.setFade(true, 0);
    this.setFade(false, 0);
    this.showStill(null);
    this.closeBubbles();
    this.hideTalk();
    this.hideNarration();
    this.hideLocation();
    this.cancelChoice();
    this.showCard(null);
    this.setBar(null);
    this.setWaiting(false);
    this.stopMovie();
  }
}

/** Sound effects: one-shots from a small pool per URL, plus the game's four loop slots. */
export class SoundEffects {
  private pool = new Map<string, HTMLAudioElement[]>();
  private slots = new Map<number, HTMLAudioElement>();
  volume = 0.8;
  /** Battle voices (voice_battle_*) have their own level (Settings → Audio). */
  voiceVolume = 0.9;

  private level(url: string) {
    return /\/voice_/.test(url) ? this.voiceVolume : this.volume;
  }

  setVolumes(sfx: number, voice: number) {
    this.volume = sfx;
    this.voiceVolume = voice;
    for (const a of this.slots.values()) a.volume = sfx;
  }

  play(url: string) {
    let list = this.pool.get(url);
    if (!list) this.pool.set(url, (list = []));
    let a = list.find((x) => x.paused || x.ended);
    if (!a && list.length < 4) {
      a = new Audio(assetUrl(url));
      list.push(a);
    }
    if (!a) return;
    a.volume = this.level(url);
    a.currentTime = 0;
    void a.play().catch(() => {});
  }

  loop(url: string, slot: number) {
    this.stopSlot(slot);
    const a = new Audio(assetUrl(url));
    a.loop = true;
    a.volume = this.volume;
    void a.play().catch(() => {});
    this.slots.set(slot, a);
  }

  stopSlot(slot: number) {
    this.slots.get(slot)?.pause();
    this.slots.delete(slot);
  }

  stopAll() {
    for (const list of this.pool.values()) for (const a of list) a.pause();
    for (const s of [...this.slots.keys()]) this.stopSlot(s);
  }
}

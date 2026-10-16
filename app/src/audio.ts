import { assetUrl } from './platform/source';
import type { MusicTrack } from './types';

/** Background music: auto-plays a map's BGM, or whatever the jukebox picked. */
export class Music {
  readonly el = new Audio();
  current: MusicTrack | null = null;
  /** When the user picked a jukebox track it sticks until they release it. */
  pinned = false;
  unlocked = false;
  onChange: (t: MusicTrack | null) => void = () => {};

  constructor() {
    this.el.loop = true;
    // Honour the game's LOOPSTART/LOOPEND so tracks loop seamlessly past their intros.
    const tick = () => {
      const t = this.current;
      if (t?.loopEnd && t.loopStart !== undefined && t.loopStart !== null && !this.el.paused && this.el.currentTime >= t.loopEnd - 0.02) {
        this.el.currentTime = t.loopStart + (this.el.currentTime - t.loopEnd);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  unlock() {
    this.unlocked = true;
    if (this.current && this.el.paused) void this.el.play().catch(() => {});
  }

  /** Set from Settings → Audio (game/settings.ts stores it). */
  set volume(v: number) {
    this.el.volume = v;
  }
  get volume() {
    return this.el.volume;
  }

  play(track: MusicTrack | null, opts: { pin?: boolean } = {}) {
    if (opts.pin !== undefined) this.pinned = opts.pin;
    if (!track) {
      this.el.pause();
      this.current = null;
      this.onChange(null);
      return;
    }
    if (this.current?.url !== track.url) {
      this.el.src = assetUrl(track.url);
      this.current = track;
    }
    if (this.unlocked) void this.el.play().catch(() => {});
    this.onChange(track);
  }

  /** Map changed: follow its BGM unless the jukebox is pinned. */
  mapTrack(track: MusicTrack | null) {
    if (this.pinned) return;
    this.play(track);
  }

  toggle() {
    if (this.el.paused) void this.el.play().catch(() => {});
    else this.el.pause();
  }
}

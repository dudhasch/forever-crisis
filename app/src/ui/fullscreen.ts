/**
 * Full screen: whether the game fills the screen, and a way to ask the browser for it. The Fullscreen API needs a
 * user gesture (a click or key press; browsers do not count gamepad buttons), so callers run it from one.
 */

/** True when the page fills the screen: the Fullscreen API, an installed app in fullscreen mode, or the browser's F11. */
export function isFullscreen() {
  if (document.fullscreenElement) return true;
  if (matchMedia('(display-mode: fullscreen)').matches) return true;
  // F11 in a desktop browser sets neither of the above; the window then covers the whole screen
  return Math.abs(window.innerWidth - screen.width) <= 2 && Math.abs(window.innerHeight - screen.height) <= 2;
}

/** The browser lets this page go full screen (not inside a frame that forbids it, not on iOS Safari for pages). */
export function canFullscreen() {
  return document.fullscreenEnabled && typeof document.documentElement.requestFullscreen === 'function';
}

/** Ask for full screen; false when the browser refused (no user gesture, or blocked). */
export async function enterFullscreen() {
  if (!canFullscreen()) return false;
  try {
    await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Keyboard focus for windows drawn over everything else (settings, pause menus). This module's keydown listener
 * is registered when it is first imported, before the title screen, the game menu and the field input, so the
 * topmost window gets every key press and nothing underneath sees it.
 */
type Handler = (k: string, e: KeyboardEvent) => void;

const stack: Handler[] = [];

window.addEventListener(
  'keydown',
  (e) => {
    const top = stack[stack.length - 1];
    if (!top) return;
    const t = e.target as HTMLElement | null;
    // let range inputs and text fields inside the window keep their own keys, except Esc
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') && (t as HTMLInputElement).type !== 'checkbox' && e.key !== 'Escape') {
      if ((t as HTMLInputElement).type !== 'range') return;
      t.blur();
    }
    e.stopImmediatePropagation();
    e.preventDefault();
    top(e.key.toLowerCase(), e);
  },
  true,
);

export function pushModal(h: Handler) {
  stack.push(h);
}

export function popModal(h: Handler) {
  const i = stack.lastIndexOf(h);
  if (i >= 0) stack.splice(i, 1);
}

export function modalOpen() {
  return stack.length > 0;
}

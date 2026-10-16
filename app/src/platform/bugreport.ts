/**
 * "Report a bug": opens GitHub's new-issue form (.github/ISSUE_TEMPLATE/bug_report.yml) in a new tab with the
 * environment fields filled in through query parameters (field ids must match the template).
 *
 * What goes into the URL (and nothing else): app version and build, asset mode, browser + OS family, where you
 * are in the game (map, story content/step, battle id and wave), the asset manifest version, and up to
 * MAX_ERRORS recent error messages with file paths reduced to file names. No ids, names, IPs or save data —
 * the save is added only when the player ticks the box, and only as a short summary.
 */
import './bugreport.css';
import { h } from '../ui';
import { SE } from '../game/data';
import { popModal, pushModal } from '../game/modal';
import { APP_VERSION, BUILD_HASH, GITHUB_REPO, assetMode } from './source';
import { assetManifest } from './firstrun';

import { stripPaths, type BugContext, type BugFields, issueUrl, locationLine, uaSummary } from './bugreport-url';

export type { BugContext } from './bugreport-url';
const MAX_ERRORS = 5;
const MAX_ERROR_LEN = 300;

const errors: string[] = [];
let context: () => BugContext = () => ({});

export function setBugContext(fn: () => BugContext) {
  context = fn;
}

export function recordError(msg: unknown) {
  const s = stripPaths(String(msg instanceof Error ? `${msg.name}: ${msg.message}` : msg))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_ERROR_LEN);
  if (!s || errors[errors.length - 1] === s) return;
  errors.push(s);
  if (errors.length > MAX_ERRORS) errors.shift();
}

export function recentErrors() {
  return [...errors];
}

// the existing error plumbing: uncaught errors, rejections and console.error
addEventListener('error', (e) => recordError(e.error ?? e.message));
addEventListener('unhandledrejection', (e) => recordError(e.reason));
const origError = console.error.bind(console);
console.error = (...a: unknown[]) => {
  recordError(a.map((x) => (x instanceof Error ? `${x.name}: ${x.message}` : typeof x === 'string' ? x : safeJson(x))).join(' '));
  origError(...a);
};

function safeJson(x: unknown) {
  try {
    return JSON.stringify(x);
  } catch {
    return String(x);
  }
}

export function collectFields(c: BugContext, includeSave: boolean): BugFields {
  const m = assetManifest();
  const mode = assetMode();
  return {
    version: `${APP_VERSION} (${BUILD_HASH})`,
    mode: mode === 'folder' ? 'hosted folder' : mode,
    browser: uaSummary(),
    location: locationLine(c),
    manifest: m ? `format ${m.format}, assets ${m.assetFormat}, catalog ${m.catalogRevision}, extractor ${m.extractor}` : 'none loaded',
    errors: errors.length ? errors.map((e) => `- ${e}`).join('\n') : 'none',
    save: includeSave ? (c.save?.() ?? undefined) : undefined,
  };
}

/** The FF7 window: what gets sent, the save checkbox, and a warning when a story or battle is running. */
export function openBugReport(sfx?: { play(s: string): void }): Promise<boolean> {
  const c = context();
  return new Promise((done) => {
    const box = h('input', { type: 'checkbox' }) as HTMLInputElement;
    const preview = h('pre', { class: 'br-pre' });
    const paint = () => {
      const f = collectFields(c, box.checked);
      preview.textContent = [
        `Version: ${f.version}`,
        `Mode: ${f.mode}`,
        `Browser: ${f.browser}`,
        `Where: ${f.location}`,
        `Assets: ${f.manifest}`,
        `Recent errors:\n${f.errors}`,
        f.save ? `Save summary: ${f.save}` : '',
      ]
        .filter(Boolean)
        .join('\n');
    };
    box.addEventListener('change', paint);
    const close = (go: boolean) => {
      popModal(key);
      root.remove();
      if (go) {
        sfx?.play(SE.decide);
        const url = issueUrl(collectFields(c, box.checked), GITHUB_REPO);
        if (!window.open(url, '_blank', 'noopener')) location.href = url;
      } else sfx?.play(SE.cancel);
      done(go);
    };
    const key = (k: string) => {
      if (k === 'escape' || k === 'backspace') close(false);
      else if (k === 'enter') close(true);
      else if (k === ' ') {
        box.checked = !box.checked;
        paint();
      }
    };
    const root = h(
      'div',
      { class: 'pz ff br' },
      h(
        'div',
        { class: 'pz-win ff-win br-win' },
        h('div', { class: 'pz-title' }, 'Report a bug'),
        h('div', { class: 'pz-note dim' }, 'Opens a GitHub issue form in a new tab with these details filled in. You can edit everything before posting. Needs a GitHub account.'),
        c.busy ? h('div', { class: 'br-warn' }, 'A story scene or battle is in progress. It stays paused here; GitHub opens in a new tab.') : null,
        preview,
        h('label', { class: 'br-check' }, box, ' Include a summary of my current save (party, levels, story progress)'),
        h(
          'div',
          { class: 'br-btns' },
          h('div', { class: 'ff-opt cursor', onclick: () => close(true) }, 'Open GitHub'),
          h('div', { class: 'ff-opt', onclick: () => close(false) }, 'Cancel'),
        ),
        h('div', { class: 'title-foot dim' }, 'Enter open · Space toggle save · Esc cancel'),
      ),
    );
    paint();
    document.body.append(root);
    pushModal(key);
  });
}

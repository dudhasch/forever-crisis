/** Pure helpers for bug reports (no DOM): unit-tested with `node --test`. */

/** GitHub rejects very long URLs (~8 KB); stay well below. */
export const MAX_URL = 6000;

export interface BugContext {
  map?: string | null;
  content?: string | number | null;
  step?: number | null;
  battle?: number | null;
  wave?: number | null;
  /** A story or battle is running (we ask before opening the form). */
  busy?: boolean;
  /** Short save summary, sent only when the player opts in. */
  save?: () => string | null;
}

export interface BugFields {
  version: string;
  mode: string;
  browser: string;
  location: string;
  manifest: string;
  errors: string;
  save?: string;
}

export function stripPaths(s: string) {
  return s
    .replace(/(?:https?:\/\/[^\s)]+\/|file:\/\/\/?[^\s)]+\/|[A-Za-z]:\\[^\s)]+\\|\/(?:home|Users)\/[^\s)]+\/)([^/\\\s)]+)/g, '$1')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>');
}

/** "Chrome 141 / Windows" — family and major version only. */
export function uaSummary(ua = navigator.userAgent) {
  const b =
    /Edg\/(\d+)/.exec(ua)?.[1] != null
      ? `Edge ${/Edg\/(\d+)/.exec(ua)![1]}`
      : /Firefox\/(\d+)/.test(ua)
        ? `Firefox ${/Firefox\/(\d+)/.exec(ua)![1]}`
        : /Chrome\/(\d+)/.test(ua)
          ? `Chrome ${/Chrome\/(\d+)/.exec(ua)![1]}`
          : /Version\/(\d+).*Safari/.test(ua)
            ? `Safari ${/Version\/(\d+)/.exec(ua)![1]}`
            : 'Other browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'Other OS';
  return `${b} / ${os}`;
}

export function locationLine(c: BugContext) {
  const parts: string[] = [];
  if (c.map) parts.push(`map ${c.map}`);
  if (c.content != null) parts.push(`content ${c.content}`);
  if (c.step != null) parts.push(`story step ${c.step}`);
  if (c.battle != null) parts.push(`battle ${c.battle}${c.wave != null ? ` wave ${c.wave + 1}` : ''}`);
  return parts.join(', ') || 'title screen';
}

/** The new-issue URL; long fields are trimmed (errors first, then save) to keep it under MAX_URL. */
export function issueUrl(f: BugFields, repo: string, title = '[Bug] ') {
  const build = (x: BugFields) => {
    const p = new URLSearchParams({ template: 'bug_report.yml', title, labels: 'bug' });
    for (const [k, v] of Object.entries(x)) if (v != null) p.set(k, v);
    return `https://github.com/${repo}/issues/new?${p}`;
  };
  const x = { ...f };
  let url = build(x);
  for (let n = 0; url.length > MAX_URL && n < 40; n++) {
    if (x.save && x.save.length > 200) x.save = x.save.slice(0, Math.floor(x.save.length * 0.7)) + '…';
    else if (x.errors.length > 60) x.errors = x.errors.slice(0, Math.floor(x.errors.length * 0.7)) + '…';
    else x.save = undefined;
    url = build(x);
  }
  return url.slice(0, MAX_URL);
}


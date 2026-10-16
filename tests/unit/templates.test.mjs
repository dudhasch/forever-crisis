// The game's "Report a bug" prefills issue-form fields by id: keep the template and the app in step.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';

const dir = new URL('../../.github/ISSUE_TEMPLATE/', import.meta.url);
const form = (n) => parse(readFileSync(new URL(n, dir), 'utf8'));

test('issue templates are valid forms', () => {
  for (const n of readdirSync(dir)) {
    const y = form(n);
    if (n === 'config.yml') {
      assert.equal(y.blank_issues_enabled, false);
      continue;
    }
    assert.ok(y.name && y.description && Array.isArray(y.body), n);
    const ids = y.body.filter((b) => b.id).map((b) => b.id);
    assert.equal(new Set(ids).size, ids.length, `duplicate ids in ${n}`);
  }
});

test('bug_report.yml has every field the app fills in', () => {
  const ids = new Set(form('bug_report.yml').body.map((b) => b.id));
  const src = readFileSync(new URL('../../app/src/platform/bugreport-url.ts', import.meta.url), 'utf8');
  const fields = /export interface BugFields \{([^}]*)\}/.exec(src)[1].match(/^\s*(\w+)\??:/gm).map((m) => m.trim().replace(/\??:$/, ''));
  for (const f of fields) assert.ok(ids.has(f), `template lacks field "${f}"`);
  const modes = form('bug_report.yml').body.find((b) => b.id === 'mode').attributes.options;
  for (const m of ['hosted folder', 'local', 'remote', 'dev']) assert.ok(modes.includes(m));
});

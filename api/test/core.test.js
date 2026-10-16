import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accountKey, cmpVersion, compat, fromEntity, sanitizeTelemetry, toEntity, validateSave } from '../src/lib/core.js';

const feed = { app: { version: '0.2.0' }, extractor: { version: '0.2.0', assetFormat: 2 }, minAssetFormat: 2 };

test('version compare', () => {
  assert.equal(cmpVersion('0.1.0', '0.2.0'), -1);
  assert.equal(cmpVersion('1.10.0', '1.9.3'), 1);
  assert.equal(cmpVersion('1.0', '1.0.0'), 0);
});

test('compat', () => {
  assert.equal(compat(feed, '1', '0.1.0').ok, false);
  assert.deepEqual(compat(feed, '2', '0.1.0'), { ok: true, updateAvailable: true, latestExtractor: '0.2.0' });
  assert.equal(compat(feed, '2', '0.2.0').updateAvailable, false);
  assert.equal(compat(feed, 'x', '').ok, false);
});

test('saves round trip in 30k chunks', () => {
  const big = 'x'.repeat(100_000);
  const body = { slots: { 'ff7ec.game': big, 'ff7ec.save.1': '{"a":1}' } };
  assert.equal(validateSave(body), null);
  const e = toEntity('k', body, '0.1.0');
  assert.ok(e.chunks >= 4);
  for (let i = 0; i < e.chunks; i++) assert.ok(e[`d${i}`].length <= 30_000);
  assert.deepEqual(fromEntity(e).slots, body.slots);
});

test('save validation', () => {
  assert.match(validateSave({ slots: { 'evil.key': 'x' } }), /Unexpected slot/);
  assert.match(validateSave({ slots: { 'ff7ec.game': 5 } }), /string/);
  assert.match(validateSave({ slots: { 'ff7ec.game': 'x'.repeat(950_000) } }), /too large/);
});

test('account key hides the provider id', () => {
  const k = accountKey({ identityProvider: 'github', userId: 'abc123' });
  assert.equal(k.length, 40);
  assert.ok(!k.includes('abc123'));
});

test('telemetry keeps only documented fields', () => {
  const rows = sanitizeTelemetry({
    install: '0b8e3c2a-1111-4222-8333-444455556666',
    app: '0.1.0',
    mode: 'folder',
    browser: 'chrome',
    screen: '1920',
    assetFormat: 1,
    ip: '1.2.3.4',
    email: 'someone@example.com',
    events: [
      { t: Date.now(), type: 'map', data: { map: 'dungeon_map_0001', user: 'x' } },
      { t: Date.now(), type: 'battle', data: { battle: 101, result: 'won', seconds: 40, name: 'leak' } },
      { t: Date.now(), type: 'hack', data: {} },
    ],
  });
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.ok(!('ip' in r) && !('email' in r));
    assert.ok(!r.data.includes('leak') && !r.data.includes('user'));
  }
  assert.equal(sanitizeTelemetry({ install: 'bad', events: [] }), 'Missing install id.');
});

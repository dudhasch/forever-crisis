// HTTP functions of the Forever Crisis site. Routes are under /api (SWA managed functions).
import { app } from '@azure/functions';
import { accountKey, compat, fromEntity, json, principal, releaseFeed, sanitizeTelemetry, table, toEntity, validateSave } from '../lib/core.js';

/** Latest app / extractor versions and the asset format this deployment needs (installer + site). */
app.http('version', {
  route: 'version',
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async () => json(200, releaseFeed(), { 'Cache-Control': 'public, max-age=300' }),
});

/** Does a local asset folder (manifest assetFormat + extractor version) work with this deployment? */
app.http('compat', {
  route: 'compat',
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (request) => json(200, compat(releaseFeed(), request.query.get('assetFormat'), request.query.get('extractor'))),
});

/** Cloud saves of the signed-in account (staticwebapp.config.json restricts the route to authenticated users). */
app.http('saves', {
  route: 'saves',
  methods: ['GET', 'PUT', 'DELETE'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    const p = principal(request);
    if (!p) return json(401, { error: 'Sign in first.' });
    const key = accountKey(p);
    const t = await table('saves');
    if (request.method === 'GET') {
      try {
        return json(200, fromEntity(await t.getEntity('save', key)));
      } catch (e) {
        if (e.statusCode === 404) return json(404, { error: 'No cloud save yet.' });
        throw e;
      }
    }
    if (request.method === 'DELETE') {
      await t.deleteEntity('save', key).catch((e) => {
        if (e.statusCode !== 404) throw e;
      });
      return json(204, null);
    }
    const text = await request.text();
    if (text.length > 1_000_000) return json(413, { error: 'Save data too large.' });
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return json(400, { error: 'Invalid JSON.' });
    }
    const err = validateSave(body);
    if (err) return json(400, { error: err });
    const entity = toEntity(key, body, body.app);
    await t.upsertEntity(entity, 'Replace');
    context.log(`save stored (${entity.chunks} chunk(s))`);
    return json(200, fromEntity(entity));
  },
});

async function pruneTelemetry(t) {
  const days = Number(process.env.TELEMETRY_RETENTION_DAYS ?? 180);
  const cutoff = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
  let n = 0;
  for await (const e of t.listEntities({ queryOptions: { filter: `PartitionKey lt '${cutoff}'`, select: ['PartitionKey', 'RowKey'] } })) {
    await t.deleteEntity(e.partitionKey, e.rowKey);
    if (++n >= 1000) break;
  }
}

/** Opt-in play statistics and error reports; only whitelisted, documented fields are stored. */
app.http('telemetry', {
  route: 'telemetry',
  methods: ['POST'],
  authLevel: 'anonymous',
  handler: async (request) => {
    if (process.env.TELEMETRY_ENABLED === '0') return json(202, { stored: 0 });
    const text = await request.text();
    if (text.length > 128_000) return json(413, { error: 'Too large.' });
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return json(400, { error: 'Invalid JSON.' });
    }
    const rows = sanitizeTelemetry(body);
    if (typeof rows === 'string') return json(400, { error: rows });
    const t = await table('telemetry');
    // one transaction per partition (day), at most 100 rows each
    const byDay = new Map();
    for (const r of rows) byDay.set(r.partitionKey, [...(byDay.get(r.partitionKey) ?? []), r]);
    for (const list of byDay.values()) {
      if (list.length) await t.submitTransaction(list.map((r) => ['create', r]));
    }
    // retention: managed functions have no timers, so roughly every 200th write deletes old days
    if (Math.random() < 0.005) await pruneTelemetry(t).catch(() => undefined);
    return json(202, { stored: rows.length });
  },
});

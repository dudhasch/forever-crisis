// The Static Web App headers (CSP etc.) do not break the built app: serves app/dist with the globalHeaders
// and navigation fallback from swa/staticwebapp.config.json, loads it in Chromium, and fails on any CSP
// violation. Also checks the asset service worker registers and the first-run screen renders.
//   npm run build && node tests/e2e/headers-csp.mjs
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { chromium } from 'playwright';

const DIST = 'app/dist';
const cfg = JSON.parse(readFileSync('swa/staticwebapp.config.json', 'utf8'));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon', '.png': 'image/png' };

const server = createServer((req, res) => {
  const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
  let file = normalize(join(DIST, url === '/' ? 'index.html' : url));
  if (!file.startsWith(normalize(DIST)) || !existsSync(file) || !statSync(file).isFile()) {
    if (/^\/(api|arc|lib|gen)\//.test(url) || extname(url)) {
      res.writeHead(404, cfg.globalHeaders);
      return res.end();
    }
    file = join(DIST, cfg.navigationFallback.rewrite);
  }
  const route = cfg.routes.find((r) => r.route === url);
  res.writeHead(200, { ...cfg.globalHeaders, ...(route?.headers ?? {}), 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const site = `http://localhost:${server.address().port}`;

const browser = await chromium.launch();
const page = await browser.newPage();
const violations = [];
const errors = [];
page.on('console', (m) => {
  if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text());
  else if (m.type() === 'error') errors.push(m.text());
});
await page.addInitScript(() => {
  document.addEventListener('securitypolicyviolation', (e) => console.error(`Refused to load: CSP ${e.violatedDirective} ${e.blockedURI}`));
});
await page.goto(site + '/');
await page.waitForTimeout(4000);
const sw = await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length);
const gate = await page.textContent('.ffcx-gate h2').catch(() => null);
await browser.close();
server.close();

console.log(`site ${site}  service workers: ${sw}  first screen: ${gate}`);
if (!sw || !gate) {
  console.error('the app did not start under the headers');
  process.exit(1);
}
if (errors.length) console.log('console errors (not CSP):\n  ' + errors.join('\n  '));
if (violations.length) {
  console.error('CSP violations:\n  ' + violations.join('\n  '));
  process.exit(1);
}
console.log('no CSP violations');

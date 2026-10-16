/** Config → "Online & privacy": cloud saves, the telemetry opt-in, the asset folder and update info. */
import './firstrun.css';
import { apiAvailable, cloudSaves, compatCheck, restoreSaves, signIn, signOut, startAutoBackup, stopAutoBackup, uploadSaves, versionFeed, whoAmI } from './cloud';
import { assetManifest } from './firstrun';
import { forgetFolder } from './folder';
import { APP_VERSION, ASSET_FORMAT, assetMode } from './source';
import { setTelemetry, telemetryEnabled } from './telemetry';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function button(label: string, onclick: () => void, primary = false) {
  const b = el('button', primary ? 'primary' : '', label);
  b.onclick = onclick;
  return b;
}

function section(title: string, ...children: (HTMLElement | string)[]) {
  const s = el('div', 'ffcx-section');
  s.append(el('h3', '', title));
  for (const c of children) s.append(typeof c === 'string' ? el('p', '', c) : c);
  return s;
}

const TELEMETRY_FIELDS = [
  'A random id made when you turn this on (deleted when you turn it off)',
  'Forever Crisis version, browser family (Chrome, Edge, …) and a rough screen width',
  'Which maps you enter, which story steps you play, battle results and how long you played',
  'Error messages, so bugs can be fixed',
];

export async function openOnlinePanel() {
  document.querySelector('.ffcx-gate')?.remove();
  const wrap = el('div', 'ffcx-gate ffcx-panel');
  const card = el('div', 'ffcx-card');
  card.append(el('h2', '', 'Online & privacy'));
  const body = el('div');
  card.append(body);
  const close = el('div', 'ffcx-buttons');
  close.append(button('Close', () => wrap.remove(), true));
  card.append(close);
  wrap.append(card);
  wrap.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') wrap.remove();
  });
  document.body.append(wrap);
  (close.firstChild as HTMLButtonElement).focus();

  const online = await apiAvailable();
  const [me, feed] = online ? await Promise.all([whoAmI(), versionFeed()]) : [null, null];

  // cloud saves
  const status = el('p', 'ffcx-status');
  const saves = section('Cloud saves', status);
  const row = el('div', 'ffcx-buttons');
  saves.append(row);
  if (!online) {
    status.textContent = 'Cloud saves are available on the online site. Your saves are kept in this browser.';
  } else if (!me) {
    status.textContent = 'Sign in to back up your save slots and continue on another PC. Only your saves are stored, under an account id.';
    row.append(button('Sign in with GitHub', () => signIn('github'), true), button('Sign in with Microsoft', () => signIn('aad')));
  } else {
    const c = await cloudSaves();
    const last = localStorage.getItem('ffcx.cloud.lastSync');
    const who = me.userDetails ? `${me.userDetails} (${me.identityProvider})` : `your ${me.identityProvider === 'aad' ? 'Microsoft' : 'GitHub'} account`;
    status.textContent = `Signed in as ${who}. ` +
      (c ? `Cloud copy from ${new Date(c.updated).toLocaleString()}.` : 'No cloud copy yet.') +
      (last ? ` Last sync here: ${new Date(last).toLocaleString()}.` : '');
    row.append(
      button('Back up now', async () => {
        status.textContent = (await uploadSaves()) ? 'Backed up.' : 'Backup failed — try again later.';
      }, true),
      button('Restore from cloud', async () => {
        if (!confirm('Replace the saves in this browser with the cloud copy?')) return;
        if (await restoreSaves()) location.reload();
        else status.textContent = 'Nothing to restore.';
      }),
      button('Sign out', () => signOut()),
    );
    const auto = el('label', 'ffcx-check');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = localStorage.getItem('ffcx.cloud.auto') === '1';
    cb.onchange = () => {
      localStorage.setItem('ffcx.cloud.auto', cb.checked ? '1' : '0');
      if (cb.checked) startAutoBackup();
      else stopAutoBackup();
    };
    auto.append(cb, ' Back up automatically after saving');
    saves.append(auto);
  }
  body.append(saves);

  // telemetry
  const tl = el('label', 'ffcx-check');
  const tcb = el('input');
  tcb.type = 'checkbox';
  tcb.checked = telemetryEnabled();
  tcb.disabled = !online;
  tcb.onchange = () => setTelemetry(tcb.checked);
  tl.append(tcb, ' Share anonymous play statistics and error reports');
  const list = el('ul', 'ffcx-steps');
  for (const f of TELEMETRY_FIELDS) list.append(el('li', '', f));
  body.append(section('Help improve Forever Crisis', tl,
    'Off unless you turn it on. When on, this is sent:', list,
    'Never sent: your IP address (not stored), account, saves, or anything you type.'));

  // game files
  const m = assetManifest();
  const files = section('Game files',
    `Mode: ${({ dev: 'developer server', folder: 'folder on this PC', local: 'local server', remote: 'local server (from this site)' } as const)[assetMode()]}.` +
      (m ? ` Extracted ${new Date(m.created).toLocaleDateString()} with extractor ${m.extractor} (format ${m.assetFormat}), ${m.stats?.files ?? '?'} files.` : ''));
  if (assetMode() === 'folder') {
    const r = el('div', 'ffcx-buttons');
    r.append(button('Choose another folder…', async () => {
      await forgetFolder();
      location.reload();
    }));
    files.append(r);
  }
  body.append(files);

  // updates
  const up = section('Version', `Forever Crisis ${APP_VERSION}, expects game files format ${ASSET_FORMAT}.`);
  if (feed && m) {
    const c = await compatCheck(m.assetFormat, m.extractor);
    if (c && !c.ok) up.append(el('p', 'ffcx-warn', c.reason ?? 'Your game files need an update: run the installer again.'));
    else if (feed.extractor.version !== m.extractor) up.append(el('p', '', `Extractor ${feed.extractor.version} is available. Your files still work; run the installer again when convenient.`));
    else up.append(el('p', '', 'Your game files are up to date.'));
  }
  body.append(up);
}

/** Non-blocking notice after start when the site says the local files are too old. */
export async function checkForUpdates(toast: (msg: string) => void) {
  const m = assetManifest();
  if (!m || !(await apiAvailable())) return;
  const c = await compatCheck(m.assetFormat, m.extractor);
  if (c && !c.ok) toast(c.reason ?? 'Your game files need an update: run the installer again.');
}

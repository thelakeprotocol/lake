import './approvals.css';
import { loadKey, signCredential, signEnvelope } from './owner-crypto';

interface Request { id: string; offerId: string; visitor: { webId: string; domain: string }; purpose: string; fields: string[]; retention: string; priceUsd: number; study: string | null; question?: string; recommendation: string }
interface Key { id: string; visitor: string; fields: string[]; purpose: string; until: string; authorizedBy: string }

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const key = loadKey();
const api = new URL('./', location.href).href; // served at /owner/
let webId = '';
let seen = new Set<string>();

async function pair(): Promise<boolean> {
  const token = new URLSearchParams(location.hash.slice(1)).get('pair') ?? undefined;
  const res = await fetch(`${api}pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ publicJwk: key.jwk, token }) });
  const body = await res.json();
  if (res.ok) {
    webId = body.webId;
    history.replaceState(null, '', location.pathname);
    return true;
  }
  $('pair-msg').textContent = body.error ?? 'pairing failed';
  return false;
}

async function call(payload: Record<string, unknown>) {
  const res = await fetch(`${api}api`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signEnvelope(payload, key, webId || 'owner')) });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? String(res.status));
  return res.json();
}

const text = (tag: string, cls: string, t: string) => { const e = document.createElement(tag); if (cls) e.className = cls; e.textContent = t; return e; };
const row = (k: string, v: Node | string) => { const d = document.createElement('div'); d.append(text('dt', '', k)); const dd = document.createElement('dd'); dd.append(v); d.append(dd); return d; };
const hoursLeft = (iso: string) => { const h = (Date.parse(iso) - Date.now()) / 3_600_000; return h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : `${Math.round(h)} h`; };

function renderRequests(reqs: Request[]) {
  const box = $('requests');
  $('n-req').textContent = String(reqs.length);
  $('no-req').hidden = reqs.length > 0;
  if (reqs.some((r) => !seen.has(r.id))) navigator.vibrate?.([120, 60, 120]);
  seen = new Set(reqs.map((r) => r.id));
  box.replaceChildren(...reqs.map((r) => {
    const card = text('article', 'req', '');
    card.append(text('div', 'who', r.visitor.domain));
    if (r.question) card.append(text('p', 'q', `“${r.question}”`));
    const fields = document.createElement('span');
    fields.append(...r.fields.map((f) => text('span', 'chip', f.replace(/_/g, ' '))));
    const dl = document.createElement('dl');
    dl.append(row('Purpose', r.purpose), row('Fields', fields), row('Keeps it', r.retention === 'none' ? 'no, deleted after the study' : r.retention), row('Pays', `$${r.priceUsd}`), row('Key for', '48 hours, revocable'));
    card.append(dl);
    const advice = text('p', 'advice', r.recommendation);
    advice.prepend(text('b', '', 'Your housekeeper says'));
    card.append(advice);
    const actions = text('div', 'actions', '');
    const allow = text('button', 'btn allow', 'Allow') as HTMLButtonElement;
    const deny = text('button', 'btn deny', 'Deny') as HTMLButtonElement;
    allow.onclick = async () => {
      allow.disabled = deny.disabled = true;
      // The key is cut here, on this device, with your key. The house only checks it.
      const grant = signCredential({
        '@context': ['https://www.w3.org/ns/credentials/v2'],
        type: ['VerifiableCredential', 'LakeAccessGrant'],
        issuer: webId,
        validFrom: new Date().toISOString(),
        validUntil: new Date(Date.now() + 48 * 3_600_000).toISOString(),
        credentialSubject: { id: r.visitor.webId, offer: r.offerId, study: r.study, fields: r.fields, purpose: r.purpose, authorizedBy: 'owner, live' },
      }, key);
      await call({ kind: 'answer', request: r.id, answer: 'allow', grant }).catch((e) => alert(e.message));
      void refresh();
    };
    deny.onclick = async () => { allow.disabled = deny.disabled = true; await call({ kind: 'answer', request: r.id, answer: 'deny' }); void refresh(); };
    actions.append(allow, deny);
    card.append(actions);
    return card;
  }));
}

function renderKeys(keys: Key[]) {
  $('n-keys').textContent = String(keys.length);
  $('no-keys').hidden = keys.length > 0;
  $('revoke-all').hidden = keys.length === 0;
  $('keys').replaceChildren(...keys.map((k) => {
    const li = document.createElement('li');
    const info = document.createElement('div');
    info.append(text('div', 'k-who', `${k.visitor} · ${k.purpose}`), text('div', 'k-meta', `${k.fields.join(', ').replace(/_/g, ' ')} · ${hoursLeft(k.until)} left · ${k.authorizedBy}`));
    const b = text('button', '', 'Revoke');
    b.onclick = async () => { await call({ kind: 'revoke', revoke: k.id }); void refresh(); };
    li.append(info, b);
    return li;
  }));
}

async function refresh() {
  try {
    const v = await call({ kind: 'list' });
    webId = v.webId;
    $('who').textContent = v.webId;
    $('status').className = 'dot live';
    renderRequests(v.requests);
    renderKeys(v.keys);
  } catch {
    $('status').className = 'dot down';
  }
}

$('revoke-all').onclick = async () => { if (confirm('Revoke every key to your house? Active connections are cut at once.')) { await call({ kind: 'revoke', revoke: 'all' }); void refresh(); } };
$('pair-btn').onclick = async () => { if (await pair()) start(); };

function start() {
  $('pair').hidden = true;
  $('main').hidden = false;
  void refresh();
  setInterval(refresh, 1000);
}

// Already paired? A signed "list" answers. Otherwise offer to pair (automatically when the link carries a token).
call({ kind: 'list' }).then((v) => { webId = v.webId; start(); }).catch(async () => {
  $('pair').hidden = false;
  if (location.hash.includes('pair=') && (await pair())) start();
});

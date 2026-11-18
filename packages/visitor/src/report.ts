import { createHash } from 'node:crypto';
import { cellLabels, predicateLines, type Study } from '@thelakeprotocol/core';
import { DECLINE_WORDS, type StudyRun } from './dispatch.js';

const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const digest = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);
// Why a house that agreed was left out, in fixed words: a house's own reason or an error can carry its address (round 98).
const leftOut = (why: string) => /^over budget/.test(why) ? 'the budget ran out' : /^too few houses/.test(why) ? 'too few houses joined for a table' : 'its answer didn\'t arrive or didn\'t check';

/**
 * A study's result as one page a researcher can show a colleague (round 82, a researcher: the result lived in a terminal
 * and a JSON bundle): the question, what each house counted in the packs' own words, the table, how many houses were
 * asked and why the others said no, and what it rests on (each signed credential by its digest, to check with
 * lake_verify). No house is named, and nothing here was a record.
 */
export function renderStudyReport(run: StudyRun, study: Study, at = new Date()): string {
  const t = run.answer.table;
  const labels = cellLabels(study);
  const declined = Object.entries(run.declinedBecause).map(([k, n]) => `<li>${n} · ${esc(DECLINE_WORDS[k] ?? k)}</li>`).join('');
  const credential = (what: string, c?: { credential: string; card?: { name?: string } }) => c ? `<li>${esc(what)}: ${esc(c.card?.name ?? 'signed')} · <code>sha256 ${digest(c.credential)}…</code></li>` : '';
  // Each teller's signed answer: its name is on the card inside it.
  const tellers = run.evidence.tellers as { leader?: { card?: { name?: string } }; helper?: { card?: { name?: string } } };
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(run.question)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:720px;margin:24px auto;padding:0 16px;color:#13201a;background:#fff}h1{font-size:22px;line-height:1.3}h2{font-size:15px;text-transform:uppercase;letter-spacing:.06em;color:#5b6b63;margin-top:28px}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #e3e8e5;padding:6px 4px;text-align:left}td.n{text-align:right;font-variant-numeric:tabular-nums}code{font-size:13px;overflow-wrap:anywhere}.small{color:#5b6b63;font-size:14px}@media (prefers-color-scheme:dark){body{background:#0b1210;color:#e6efe9}td,th{border-color:#22302a}h2,.small{color:#9fb1a7}}</style></head><body>
<p class="small">A study on the Lake · ${esc(at.toISOString().slice(0, 16).replace('T', ' '))} UTC · ${esc(run.study)}</p>
<h1>${esc(run.question)}</h1>
<p><b>${esc(run.answer.summary)}</b></p>
<h2>What each house counted</h2><ul>${predicateLines(study).map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
<p class="small">Each house answered these at home, from its own record; the answer left as two shares neither teller can read alone, and only the sum was published.</p>
<h2>The table</h2>${run.cells.length ? `<table><tr><th>Houses that were</th><th>How many</th></tr>${run.cells.map((c, i) => `<tr><td>${esc(labels[i] ?? c.label)}</td><td class="n">${esc(Math.max(0, c.count))}</td></tr>`).join('')}</table>` : '<p>No table: too few houses answered to publish one.</p>'}
${t ? `<p class="small">${t.precision.exact ? 'Exact counts.' : `Noise added by the tellers: standard deviation ${esc(t.precision.sdPerCell)} per cell (ε ${esc(t.precision.epsilon)}); a cell noise took below zero shows as 0.`}${t.small ? ' Some cells are under 5: small numbers, read with care.' : ''}</p>` : ''}
<p class="small">No table is published from fewer than ${esc(study.privacy.min)} houses${t ? `; this one comes from ${esc(t.n)}` : ''}.</p>
<h2>Who was asked</h2><p>${run.houses} houses asked · ${run.participants} answered${run.paid ? ` · ${esc(run.paid.houses)} paid, $${esc(run.paid.total)} in all` : ''}.</p>
${declined ? `<p class="small">Why the others said no:</p><ul>${declined}</ul>` : ''}${run.pending.length ? `<p class="small">${run.pending.length} owners were asked and hadn't answered.</p>` : ''}${run.excluded.length ? `<p class="small">${run.excluded.length} agreed but were left out: ${esc([...new Set(run.excluded.map((x) => leftOut(x.why)))].join('; '))}.</p>` : ''}
<h2>What it rests on</h2><ul>${credential('Ethics approval', run.evidence.ethics)}${credential('Audit certificate', run.evidence.audit)}${credential('Spending mandate', run.evidence.mandate)}
<li>Agreements: ${run.evidence.agreements.length} countersigned by the houses that answered</li>
<li>Tellers: ${esc(tellers.leader?.card?.name ?? 'leader')} and ${esc(tellers.helper?.card?.name ?? 'helper')}, each signing its share of the sum</li>
<li>Receipts: ${run.evidence.receipts.length}${run.evidence.receipts.some((r) => r.logged) ? `, ${run.evidence.receipts.filter((r) => r.logged).length} on the transparency log` : ''}</li></ul>
<p class="small">Every one of these checks on its own: the full bundle is lake_dispatch_study { evidence_for: "${esc(run.study)}" }, and lake_verify checks any credential in it. No house is named on this page, and no record left any house.</p>
</body></html>`;
}

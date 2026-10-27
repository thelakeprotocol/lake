/**
 * The look every page a house serves shares with the owner's panel (packages/ui/src/approvals.css): dark, one sans face,
 * mono only for addresses, one accent. Plain HTML and CSS: these pages work without JavaScript.
 */
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const CSS = `:root{--ink:#070B12;--raised:#0E1622;--raised-2:#142032;--line:#1E2A3B;--fg:#E8EEF4;--muted:#93A3B6;--faint:#5C6B7E;--mint:#3DDC97;--mint-ink:#04170F;color-scheme:dark}
*{box-sizing:border-box}body{margin:0;background:var(--ink);color:var(--fg);font:400 16px/1.55 'Public Sans',system-ui,-apple-system,'Segoe UI',sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:600px;margin:0 auto;padding:40px 16px 64px}a{color:var(--mint)}
.eyebrow{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--muted);margin:0 0 10px}.eyebrow i{width:8px;height:8px;border-radius:50%;background:var(--mint);display:inline-block}
h1{font-size:30px;line-height:1.15;margin:0 0 8px;letter-spacing:-.01em}h2{font-size:17px;margin:0 0 10px}.lead{color:var(--muted);font-size:17px;margin:0 0 26px}
.card{background:var(--raised);border:1px solid var(--line);border-radius:14px;padding:18px;margin:0 0 18px}
.say{display:block;width:100%;font-size:16px;line-height:1.6;background:var(--ink);color:var(--fg);border:1px solid var(--line);border-radius:10px;padding:12px 14px;overflow-wrap:anywhere}.say code{background:none;padding:0;color:var(--mint)}
.btn{display:inline-flex;align-items:center;gap:6px;font:600 15px/1 inherit;border-radius:10px;padding:12px 16px;border:1px solid var(--line);background:var(--raised-2);color:var(--fg);cursor:pointer;text-decoration:none}.btn.primary{background:var(--mint);border-color:var(--mint);color:var(--mint-ink)}
.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:12px}.muted{color:var(--muted)}.small{font-size:14px;color:var(--muted)}
code{font:400 .86em 'IBM Plex Mono',ui-monospace,Menlo,monospace;background:var(--raised-2);padding:3px 7px;border-radius:6px;overflow-wrap:anywhere}
details{border-top:1px solid var(--line);padding:10px 0}details:last-of-type{border-bottom:1px solid var(--line)}summary{cursor:pointer;list-style:none;font-weight:600;color:var(--muted);padding:4px 0}summary::-webkit-details-marker{display:none}summary::before{content:'▸';display:inline-block;width:1.1em;transition:transform .15s}details[open] summary::before{transform:rotate(90deg)}
details ul,details ol{margin:8px 0 4px;padding-left:20px}details li{margin:6px 0}
ul.list{list-style:none;margin:0;padding:0;display:grid;gap:8px}ul.list li{display:flex;justify-content:space-between;align-items:center;gap:10px;background:var(--raised);border:1px solid var(--line);border-radius:12px;padding:12px 14px}
.say .ghost{color:var(--faint)}.ideas{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:8px}.ideas li{font-size:14px;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:6px 12px}
.btn.small{padding:8px 12px;font-size:14px;border-radius:8px}
.chip{font-size:12px;font-weight:600;padding:5px 9px;border-radius:999px;border:1px solid var(--line);color:var(--muted)}.chip.ok{color:var(--mint);border-color:rgba(61,220,151,.45)}`;

/** A page in the shared look. `head` adds to <head> (a description for agents, say). */
export function page(title: string, body: string, head = ''): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#070B12"><title>${esc(title)}</title>${head}
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400&family=Public+Sans:wght@400;600;700&display=swap"><style>${CSS}</style></head><body><main>${body}</main></body></html>`;
}

// Where you are: one hash per screen, so links from notifications open the right one and the phone's back gesture works.
//   tabs: #chats  #inbox  #ai  #you        chats: #chat=<sender key>  #note=<id>  #want=<id>
//   my AI: #aikey=<kid>                     you: #door #notify #free #address #rules #access #offers #money #data #circles #key #move #about
// Old addresses (in notifications already sent, and bookmarks) still land in the right place.

export type Tab = 'chats' | 'inbox' | 'ai' | 'you';
export type Route = { tab: Tab; page?: string; arg?: string };
export const YOU_PAGES = ['door', 'notify', 'free', 'address', 'rules', 'access', 'offers', 'money', 'data', 'circles', 'key', 'move', 'about'] as const;
const OLD: Record<string, string> = { today: 'inbox', home: 'inbox', needs: 'inbox', requests: 'inbox', myagent: 'ai', ais: 'ai', me: 'you', settings: 'you', keys: 'access', agents: 'access' };

export function parse(hash = location.hash): Route {
  const h = hash.replace(/^#/, '');
  const [k, ...rest] = h.split('=');
  const v = rest.length ? decodeURIComponent(rest.join('=')) : '';
  if (k === 'chat' || k === 'note') return { tab: 'chats', page: 'chat', arg: v };
  if (k === 'want') return { tab: 'chats', page: 'want', arg: v };
  if (k === 'aikey') return { tab: 'ai', page: 'aikey', arg: v };
  const name = OLD[k!] ?? k;
  if (name === 'inbox' || name === 'ai' || name === 'you' || name === 'chats') return { tab: name };
  if ((YOU_PAGES as readonly string[]).includes(name!)) return { tab: 'you', page: name };
  return { tab: 'chats' };
}

const fire = () => dispatchEvent(new HashChangeEvent('hashchange'));
/** Opens a screen on top of this one: back returns here. */
export const push = (hash: string) => { history.pushState({ pushed: true, from: parse().tab }, '', hash); fire(); };
const LABELS: Record<Tab, string> = { chats: 'Chats', inbox: 'Inbox', ai: 'My AI', you: 'You' };
/** What Back says: the tab this screen was opened from, else the given one. */
export const backLabel = (fallback?: string) => { const f = (history.state as { from?: Tab } | null)?.from; return f ? LABELS[f] : fallback; };
/** Switches tab: no history step. */
export const goTab = (t: Tab) => { history.replaceState(null, '', `#${t}`); fire(); };
/** Back: the step before, or the tab's first screen when this one was opened directly (from a notification). */
export const back = (fallback: string) => { if ((history.state as { pushed?: boolean } | null)?.pushed) history.back(); else { history.replaceState(null, '', fallback); fire(); } };
/** A note a notification was about (#note=<id>): its message is lit in the chat. */
export const focusNote = () => (location.hash.startsWith('#note=') ? decodeURIComponent(location.hash.slice(6)) : '');

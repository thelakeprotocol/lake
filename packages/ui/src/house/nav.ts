// Where you are: one hash per screen, so links from notifications open the right one and the phone's back gesture works.
//   tabs: #chats (People)  #inbox (Today)  #ai  #you        people: #chat=<sender key>  #note=<id>      today: #want=<id>
//   my AI: #aikey=<kid>                     you: #door #rules #mydata #money #phone, and the pages each of those opens:
//     #door: #free    #mydata: #access #data #move    #money: #offers #address #circles    #phone: #notify #key #about
// Old addresses (in notifications already sent, and bookmarks) still land in the right place.

export type Tab = 'chats' | 'inbox' | 'ai' | 'you';
export type Route = { tab: Tab; page?: string; arg?: string };
export const YOU_PAGES = ['door', 'notify', 'free', 'address', 'rules', 'access', 'offers', 'money', 'data', 'circles', 'key', 'move', 'about', 'mydata', 'phone'] as const;
/** The pages that open from another page under You: their Back goes to that page. */
export const UNDER: Record<string, string> = { free: 'door', access: 'mydata', data: 'mydata', move: 'mydata', offers: 'money', address: 'money', circles: 'money', notify: 'phone', key: 'phone', about: 'phone' };
const OLD: Record<string, string> = { people: 'chats', today: 'inbox', home: 'inbox', needs: 'inbox', requests: 'inbox', myagent: 'ai', ais: 'ai', me: 'you', settings: 'you', keys: 'access', agents: 'access' };

export function parse(hash = location.hash): Route {
  const h = hash.replace(/^#/, '');
  const [k, ...rest] = h.split('=');
  const v = rest.length ? decodeURIComponent(rest.join('=')) : '';
  if (k === 'chat' || k === 'note') return { tab: 'chats', page: 'chat', arg: v };
  if (k === 'want') return { tab: 'inbox', page: 'want', arg: v };
  if (k === 'aikey') return { tab: 'ai', page: 'aikey', arg: v };
  const name = OLD[k!] ?? k;
  if (name === 'inbox' || name === 'ai' || name === 'you' || name === 'chats') return { tab: name };
  if ((YOU_PAGES as readonly string[]).includes(name!)) return { tab: 'you', page: name };
  return { tab: 'inbox' };
}

const fire = () => dispatchEvent(new HashChangeEvent('hashchange'));
/** Opens a screen on top of this one: back returns here. */
const LABELS: Record<string, string> = { chats: 'People', inbox: 'Today', ai: 'My AI', you: 'You', door: 'Your door', mydata: 'My data', money: 'Money', phone: 'This phone' };
export const push = (hash: string) => { const r = parse(); history.pushState({ pushed: true, from: r.page && LABELS[r.page] ? r.page : r.tab === 'you' && r.page ? '' : r.tab }, '', hash); fire(); };
/** What Back says: the screen this one was opened from (nothing when that's a page with no short name), else the
 *  page it sits under, else the given one. */
export const backLabel = (fallback?: string) => { const f = (history.state as { from?: string } | null)?.from; return f === '' ? undefined : f ? LABELS[f] : LABELS[UNDER[parse().page ?? ''] ?? ''] ?? fallback; };
/** Switches tab: no history step. */
export const goTab = (t: Tab) => { history.replaceState(null, '', `#${t}`); fire(); };
/** Back: the step before, or the tab's first screen when this one was opened directly (from a notification). */
export const back = (fallback: string) => { if ((history.state as { pushed?: boolean } | null)?.pushed) history.back(); else { history.replaceState(null, '', fallback); fire(); } };
/** A note a notification was about (#note=<id>): its message is lit in the chat. */
export const focusNote = () => (location.hash.startsWith('#note=') ? decodeURIComponent(location.hash.slice(6)) : '');

import '@ionic/core/css/core.css';
import '@ionic/core/css/normalize.css';
import '@ionic/core/css/structure.css';
import '@ionic/core/css/typography.css';
import '@ionic/core/css/palettes/dark.system.css';
import './house/theme.css';
import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { CACHE, Version, api, cached, call, houseBase, reachWatchers, reachable, remember, state } from './house/api';
import { h, toast } from './house/ion';
import { type ListView } from './house/logic';
import { back, goTab, parse, type Tab } from './house/nav';
import { ChatPage, ChatsTab, WantPage, unreadChats } from './house/chats';
import { InboxTab, decisions } from './house/inbox';
import { AiKeyPage, AiTab } from './house/ai';
import { DoorPage, NotifyPage, YouTab } from './house/you';
import { AboutPage, AccessPage, AddressPage, CirclesPage, DataPage, FreePage, KeyPage, MoneyPage, MovePage, OffersPage, RulesPage } from './house/pages';
import { ConnectAI, Pair, connecting } from './house/pair';

// The control panel that comes with every house (open source). Served by the house at /owner/; every call is signed on
// this device with the owner's key, which never leaves it. Four tabs, each thing in one place: Chats (people and what
// you're looking for), Inbox (what needs you), My AI, You (how you're reached, your data, this phone).

const TABS: { tab: Tab; label: string; icon: string }[] = [
  { tab: 'chats', label: 'Chats', icon: 'chatbubbles' },
  { tab: 'inbox', label: 'Inbox', icon: 'file-tray' },
  { tab: 'ai', label: 'My AI', icon: 'sparkles' },
  { tab: 'you', label: 'You', icon: 'person-circle' },
];
const YOU: Record<string, (p: { backTo: () => void }) => unknown> = { door: DoorPage, notify: NotifyPage, free: FreePage, address: AddressPage, rules: RulesPage, access: AccessPage, offers: OffersPage, money: MoneyPage, data: DataPage, circles: CirclesPage, key: KeyPage, move: MovePage, about: AboutPage };

function App() {
  const [route, setRoute] = useState(parse());
  const [version, setVersion] = useState(0);
  const bump = () => setVersion((v) => v + 1);
  // Whether the house answers (every call says) and whether its stream is open; grey while a phone gets it back.
  const [ok, setOk] = useState(reachable);
  const [live, setLive] = useState<boolean | 'reconnecting'>(true);
  useEffect(() => { reachWatchers.add(setOk); return () => { reachWatchers.delete(setOk); }; }, []);
  useEffect(() => { const f = () => setRoute(parse()); addEventListener('hashchange', f); addEventListener('popstate', f); return () => { removeEventListener('hashchange', f); removeEventListener('popstate', f); }; }, []);
  // Opened from a notification (?n=<text>#<screen>): it opens on that screen, and says what it was about, once.
  useEffect(() => {
    const n = new URLSearchParams(location.search).get('n');
    if (n) { history.replaceState(history.state, '', location.pathname + location.hash); void toast(n, { duration: 5000 }); }
  }, []);
  // The notification helper is registered on every open, so a phone picks up a new one (8 Nov: it kept the first forever).
  useEffect(() => { try { if ('serviceWorker' in navigator && 'Notification' in window && Notification.permission === 'granted') void navigator.serviceWorker.register('./owner-sw.js', { scope: './' }).then((r) => r.update()).catch(() => {}); } catch { /* not supported */ } }, []);
  // The house's "something changed" (SSE), opened with a one-use token from a signed call (an EventSource can't sign);
  // a burst of changes is one refetch. A look every minute anyway, and when you come back to the app.
  useEffect(() => {
    let es: EventSource | null = null, timer: ReturnType<typeof setTimeout> | undefined, retry: ReturnType<typeof setTimeout> | undefined, stopped = false;
    const changed = () => { clearTimeout(timer); timer = setTimeout(bump, 150); };
    const open = () => call<{ path: string }>({ kind: 'panel.stream' }).then((s) => {
      if (stopped) return;
      es = new EventSource(`${api}${s.path}`);
      let first = true;
      es.addEventListener('changed', () => { if (first) first = false; else changed(); });
      es.onopen = () => setLive(true);
      es.onerror = () => { es?.close(); es = null; setLive('reconnecting'); clearTimeout(retry); retry = setTimeout(open, 3_000); };
    }).catch(() => { setLive(false); clearTimeout(retry); retry = setTimeout(open, 10_000); });
    void open();
    const every = setInterval(() => { if (!document.hidden) changed(); }, 60_000);
    const back = () => { if (document.hidden) return; if (!es) { clearTimeout(retry); void open(); } changed(); };
    addEventListener('visibilitychange', back);
    return () => { stopped = true; es?.close(); clearTimeout(timer); clearTimeout(retry); clearInterval(every); removeEventListener('visibilitychange', back); };
  }, []);
  // Badges, and a buzz when a new request comes in.
  const [list, setList] = useState<ListView | undefined>(() => cached<ListView>(JSON.stringify({ kind: 'list' })));
  const seenReq = useRef<Set<string> | null>(null);
  useEffect(() => {
    void call<ListView>({ kind: 'list' }).then((v) => {
      if (seenReq.current && v.requests.some((r) => !seenReq.current!.has(r.id))) navigator.vibrate?.([120, 60, 120]);
      seenReq.current = new Set(v.requests.map((r) => r.id));
      setList(v);
    }).catch(() => {});
  }, [version]);
  const counts: Record<Tab, number> = { chats: unreadChats(list), inbox: decisions(list), ai: (list?.assistants ?? []).filter((a) => a.waiting).length, you: 0 };
  const tabbar = h('ion-tab-bar', { id: 'tabbar', class: 'lake-tabbar', selectedTab: route.tab },
    ...TABS.map((t) => h('ion-tab-button', { key: t.tab, tab: t.tab, selected: route.tab === t.tab, onClick: () => { if (route.tab === t.tab && !route.page) document.querySelector('ion-content')?.scrollToTop(300); else goTab(t.tab); } },
      h('ion-icon', { name: route.tab === t.tab ? t.icon : `${t.icon}-outline` }), h('ion-label', {}, t.label),
      counts[t.tab] ? h('ion-badge', { color: t.tab === 'inbox' ? 'warning' : 'primary' }, counts[t.tab] > 99 ? '99+' : String(counts[t.tab])) : null)));
  const status = ok && live === true ? null : h('span', { class: `status-chip${ok ? '' : ' down'}`, role: 'status' }, h('span', { class: 'status-dot' }), ok ? 'Reconnecting' : 'Offline');
  const backTo = (t: Tab) => () => back(`#${t}`);
  const k = `${route.tab}/${route.page ?? ''}/${route.arg ?? ''}`;
  let view;
  if (route.page === 'chat') view = h(ChatPage, { key: k, arg: route.arg ?? '' });
  else if (route.page === 'want') view = h(WantPage, { key: k, arg: route.arg ?? '' });
  else if (route.page === 'aikey') view = h(AiKeyPage, { key: k, arg: route.arg ?? '' });
  else if (route.page && YOU[route.page]) view = h(YOU[route.page], { key: k, backTo: backTo('you') });
  else view = h({ chats: ChatsTab, inbox: InboxTab, ai: AiTab, you: YouTab }[route.tab], { key: k, tabbar, status });
  return h(Version.Provider, { value: { version, bump } }, view);
}

function Root() {
  // Paired before on this device (its last answers are kept): open straight away and check behind.
  const seen = cached<{ webId: string; until?: string }>(JSON.stringify({ kind: 'list' }));
  if (seen && !state.webId) { state.webId = seen.webId; state.leaseUntil = seen.until ?? null; }
  const [s, setS] = useState<'checking' | 'paired' | 'unpaired'>(seen ? 'paired' : 'checking');
  // Already paired? A signed "list" answers. Otherwise offer to pair (automatically when the link carries a token).
  useEffect(() => {
    void call<{ webId: string; until?: string }>({ kind: 'list' }).then((v) => { state.webId = v.webId; state.leaseUntil = v.until ?? null; remember(JSON.stringify({ kind: 'list' }), v); setS('paired'); }, () => { if (reachable || !seen) setS('unpaired'); });
  }, []);
  const [why, setWhy] = useState<string | undefined>();
  useEffect(() => {
    const lost = () => {
      try { for (const k of Object.keys(sessionStorage)) if (k.startsWith(CACHE)) sessionStorage.removeItem(k); } catch { /* nothing kept */ }
      setWhy('This phone isn\'t your house\'s key any more (it moved to another device, or was recovered there).');
      setS('unpaired');
    };
    addEventListener('lake:not-the-key', lost);
    return () => removeEventListener('lake:not-the-key', lost);
  }, []);
  // This browser knows this house: the connector's sign-in page offers it next time (same site only).
  useEffect(() => {
    if (s !== 'paired') return;
    try { const all = (JSON.parse(localStorage.getItem('lake-houses') ?? '[]') as string[]).filter((x) => x !== houseBase()); localStorage.setItem('lake-houses', JSON.stringify([...all, houseBase()].slice(-5))); } catch { /* not kept */ }
  }, [s]);
  const [connect, setConnect] = useState(connecting);
  if (s === 'checking') return h('div', { class: 'boot' }, h('ion-spinner', { name: 'crescent' }));
  if (s === 'paired' && connect) return h(ConnectAI, { c: connect, done: () => setConnect(null) });
  return s === 'paired' ? h(App, {}) : h(Pair, { onPaired: () => setS('paired'), why });
}

const root = document.createElement('ion-app');
document.getElementById('app')!.replaceWith(root);
render(h(Root, {}), root);

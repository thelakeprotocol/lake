/**
 * When the owner is free to meet (SPEC §9.0), and the free slots that leaves around their agenda: iCalendar's free/busy
 * (RFC 5545 VFREEBUSY) in the small, so their assistant can offer a time instead of asking them each time (runs 49-50:
 * a coffee stalled at "I don't know your calendar"). Pure: no I/O.
 */
export interface Availability {
  /** IANA time zone the times are in, e.g. Australia/Sydney. */
  tz: string;
  /** Windows like "mon-fri 09:00-12:00" or "sat,sun 10:00-11:30". */
  free: string[];
  /** Length of one meeting, in minutes (default 60). */
  meetings?: number;
}

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const WINDOW = /^([a-z]{3}(?:-[a-z]{3})?(?:,[a-z]{3}(?:-[a-z]{3})?)*)\s+([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-4]):([0-5]\d)$/;

/** The weekdays (0 = Sunday) and minutes from midnight of one window, or an error in plain words. */
export function parseWindow(w: string): { days: number[]; from: number; to: number } | string {
  const m = WINDOW.exec(w.trim().toLowerCase());
  if (!m) return `"${w}": write it like "mon-fri 09:00-12:00"`;
  const days = new Set<number>();
  for (const part of m[1]!.split(',')) {
    const [a, b] = part.split('-').map((d) => DAYS.indexOf(d));
    if (a! < 0 || (b !== undefined && b < 0)) return `"${w}": days are mon, tue, wed, thu, fri, sat, sun`;
    for (let d = a!; ; d = (d + 1) % 7) { days.add(d); if (b === undefined || d === b) break; }
  }
  const from = Number(m[2]) * 60 + Number(m[3]), to = Number(m[4]) * 60 + Number(m[5]);
  if (to <= from) return `"${w}": it ends before it starts`;
  return { days: [...days].sort(), from, to };
}

/** Problems with an availability setting, in plain words (none: it's good). */
export function availabilityProblems(a: unknown): string[] {
  const x = a as Partial<Availability> | null;
  if (!x || typeof x !== 'object') return ['availability: { tz, free: ["mon-fri 09:00-12:00"], meetings? }'];
  const out: string[] = [];
  try { new Intl.DateTimeFormat('en', { timeZone: String(x.tz) }); } catch { out.push(`availability.tz: a time zone like Australia/Sydney (got ${String(x.tz)})`); }
  if (!Array.isArray(x.free) || !x.free.length || x.free.length > 14) out.push('availability.free: 1 to 14 windows, like "mon-fri 09:00-12:00"');
  else for (const w of x.free) { const p = parseWindow(String(w)); if (typeof p === 'string') out.push(`availability.free: ${p}`); }
  if (x.meetings !== undefined && !(Number.isInteger(x.meetings) && x.meetings >= 15 && x.meetings <= 240)) out.push('availability.meetings: 15 to 240 minutes');
  for (const k of Object.keys(x)) if (!['tz', 'free', 'meetings'].includes(k)) out.push(`availability: unknown setting "${k}" (allowed: tz, free, meetings)`);
  return out;
}

/** Minutes the zone is ahead of UTC at that instant. */
function offset(tz: string, at: Date): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(at).map((x) => [x.type, x.value]));
  return (Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!) - at.getTime()) / 60000;
}

/** The instant of a local wall-clock time in a zone (the offset settled twice, for days the clocks change). */
function at(tz: string, y: number, mo: number, d: number, minutes: number): Date {
  const guess = Date.UTC(y, mo, d, 0, minutes);
  const once = guess - offset(tz, new Date(guess)) * 60000;
  return new Date(guess - offset(tz, new Date(once)) * 60000);
}

/**
 * Free slots from `from` for `days` days: each window cut into meetings, less those that overlap something busy or have
 * started. At most `limit`, soonest first.
 */
export function freeSlots(a: Availability, busy: { start: string; minutes?: number }[], from = new Date(), days = 14, limit = 20): { start: string; end: string }[] {
  const len = a.meetings ?? 60;
  const windows = a.free.map(parseWindow).filter((w): w is Exclude<typeof w, string> => typeof w !== 'string');
  const taken = busy.map((b) => ({ s: Date.parse(b.start), e: Date.parse(b.start) + (b.minutes ?? len) * 60000 })).filter((b) => !Number.isNaN(b.s));
  const out: { start: string; end: string }[] = [];
  // The zone's own calendar date today, then day by day.
  const local = new Date(from.getTime() + offset(a.tz, from) * 60000);
  for (let i = 0; i < days && out.length < limit; i++) {
    const day = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + i));
    const today: { start: string; end: string }[] = [];
    for (const w of windows) {
      if (!w.days.includes(day.getUTCDay())) continue;
      for (let m = w.from; m + len <= w.to; m += len) {
        const s = at(a.tz, day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), m).getTime(), e = s + len * 60000;
        if (s <= from.getTime() || taken.some((b) => b.s < e && s < b.e)) continue;
        today.push({ start: new Date(s).toISOString(), end: new Date(e).toISOString() });
      }
    }
    // Windows that overlap give the same slot twice: once is enough.
    for (const x of today.sort((p, q) => p.start.localeCompare(q.start))) if (out.length < limit && out.at(-1)?.start !== x.start) out.push(x);
  }
  return out;
}

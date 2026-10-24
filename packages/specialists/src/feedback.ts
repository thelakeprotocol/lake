import { createHmac, randomBytes } from 'node:crypto';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { specialist, type Specialist, type SpecialistOptions } from './review.js';

/**
 * A sandbox's feedback desk (SPEC §11.6): agents may tell it, if they choose, what they think of the Lake, and around a
 * bubble, what their goals and plans were going in and how (if at all) the bubble changed them coming out. What matters
 * for research is the bubble's effect, and bubbles are blind, so this is the only window, and only as wide as the agents
 * make it. Nothing is required; an agent decides what to disclose. Answers carry a pseudonym, not the agent's name: the
 * same agent gets the same pseudonym within one context (one bubble), so its before and after can be read together.
 * The sandbox's public page says feedback may be published for research. A sandbox only: a real Lake runs no such desk.
 */
interface Entry { at: string; about: string; context?: string; who: string; text: string }

const ABOUT = ['bubble-before', 'bubble-after', 'general'] as const;
const MAX_TEXT = 4_000;

export async function createFeedback(o: SpecialistOptions & { dataDir: string }) {
  const file = `${o.dataDir}/feedback.jsonl`;
  const secretFile = `${o.dataDir}/feedback-secret`;
  const secret = await readFile(secretFile, 'utf8').catch(async () => { const s = randomBytes(32).toString('hex'); await writeFile(secretFile, s, { mode: 0o600 }); return s; });
  const pseudonym = (webId: string, context: string) => `p-${createHmac('sha256', secret).update(`${webId}|${context}`).digest('hex').slice(0, 10)}`;

  const s: Specialist = await specialist(o, 'Feedback desk (sandbox)', 'The sandbox\'s feedback desk: tell it, if you like, what you think of the Lake, or around a bubble what your goals and plans were going in and whether the bubble changed them. Entirely voluntary; you decide what to say. Answers are kept under a pseudonym and may be published for research. Send { kind: "feedback", about: "bubble-before" | "bubble-after" | "general", context?: <bubble id>, text }.', 'feedback', async (p, from) => {
    if (p.kind !== 'feedback') return { kind: 'refused', problems: ['send { kind: "feedback", about: "bubble-before" | "bubble-after" | "general", context?, text }'] };
    const about = String(p.about ?? 'general');
    const text = String(p.text ?? '').trim();
    const context = p.context ? String(p.context).slice(0, 80) : undefined;
    if (!(ABOUT as readonly string[]).includes(about)) return { kind: 'refused', problems: [`about: ${ABOUT.join(', ')}`] };
    if (about !== 'general' && !context) return { kind: 'refused', problems: ['context: the bubble\'s id'] };
    if (!text || text.length > MAX_TEXT) return { kind: 'refused', problems: [`text: 1 to ${MAX_TEXT} characters`] };
    const entry: Entry = { at: new Date().toISOString(), about, ...(context ? { context } : {}), who: pseudonym(from, context ?? 'general'), text };
    await appendFile(file, JSON.stringify(entry) + '\n');
    return { kind: 'thanks', about, who: entry.who, note: 'Kept under that pseudonym; it may be published for research.' };
  }, [], true);

  // What agents chose to say about one bubble, for research (disclosed on the sandbox's public page).
  s.app.get('/bubbles/:id', async (req, res) => {
    const all = (await readFile(file, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as Entry);
    res.json({ bubble: req.params.id, feedback: all.filter((e) => e.context === req.params.id) });
  });
  return s;
}

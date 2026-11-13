/**
 * A model the owner (or their house's operator) connected, run once for the AI on duty: the Lake's duty tools are its only
 * tools, over the connector, under the agent's own sign-in. Nothing here decides anything: the connector and the house
 * hold the AI to its signed duty grant whatever it asks for (SPEC §6.1).
 */
import Anthropic from '@anthropic-ai/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { DUTY_TOOLS } from './duty.js';

/** One run: what the runner hands a model, and what it hands back. */
export type ModelRun = (r: { lake: string; token: string; prompt: string; maxTools: number; signal?: AbortSignal }) => Promise<{ code: number; out: string; tokens?: number }>;

export interface ModelSpec {
  /** "anthropic" (Claude, through Anthropic's API) or "stub" (tests and demos: no model, a fixed little routine). */
  provider: 'anthropic' | 'stub';
  /** An API key; without one, the SDK's own sources (ANTHROPIC_API_KEY, an `ant auth login` profile). */
  apiKey?: string;
  model?: string;
}

export const DEFAULT_MODEL = 'claude-opus-5-5';

async function lakeClient(lake: string, token: string) {
  const c = new Client({ name: 'AI on duty (house)', version: '0.1.0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(lake), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return c;
}
const textOf = (r: object) => (((r as { content?: unknown }).content as { type?: string; text?: string }[] | undefined) ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');

export function modelDriver(spec: ModelSpec): ModelRun {
  return spec.provider === 'stub' ? stubRun : anthropicRun(spec);
}

/** Claude with the duty tools, in a plain tool loop: each tool call goes to the connector, its answer back as the result. */
function anthropicRun(spec: ModelSpec): ModelRun {
  const client = new Anthropic(spec.apiKey ? { apiKey: spec.apiKey } : {});
  return async ({ lake, token, prompt, maxTools, signal }) => {
    const c = await lakeClient(lake, token);
    let tokens = 0, calls = 0, last = '';
    try {
      // Only the duty tools are offered (the connector refuses anything outside the grant anyway).
      const tools: Anthropic.Beta.BetaTool[] = (await c.listTools()).tools
        .filter((t) => DUTY_TOOLS.includes(t.name))
        .map((t) => ({ name: t.name, description: t.description ?? '', input_schema: t.inputSchema as Anthropic.Beta.BetaTool.InputSchema }));
      const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: prompt.includes('gave you a task') ? 'Look at your task, do what your human asked, and say in one line what you did.' : 'Look at what waits, do what your grant allows, and say in one line what you did.' }];
      while (true) {
        // Stopped (off duty, a new model, the house handed back): no further call, not even the one in hand.
        if (signal?.aborted) return { code: 0, out: `${last}\n(stopped)`.trim(), tokens };
        const r = await client.beta.messages.create({
          model: spec.model ?? DEFAULT_MODEL, max_tokens: 16000, system: prompt, tools, messages,
          // Routine work: low effort keeps a night of duty to cents. A declined request is re-run by the API's own fallback.
          output_config: { effort: 'low' }, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
        }, { signal });
        tokens += r.usage.input_tokens + r.usage.output_tokens;
        last = textOf(r) || last;
        if (r.stop_reason === 'refusal') return { code: 1, out: `${last}\n(the model declined this run)`.trim(), tokens };
        if (r.stop_reason !== 'tool_use' && r.stop_reason !== 'pause_turn') return { code: 0, out: last, tokens };
        messages.push({ role: 'assistant', content: r.content });
        if (r.stop_reason === 'pause_turn') continue;
        const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
        for (const b of r.content) {
          if (b.type !== 'tool_use') continue;
          if (signal?.aborted) { results.push({ type: 'tool_result', tool_use_id: b.id, content: 'stopped', is_error: true }); continue; }
          if (++calls > maxTools) { results.push({ type: 'tool_result', tool_use_id: b.id, content: `stop: at most ${maxTools} tool calls a run`, is_error: true }); continue; }
          const out = await c.callTool({ name: b.name, arguments: b.input as Record<string, unknown> }).catch((e: Error) => ({ content: [{ type: 'text', text: e.message }], isError: true }));
          results.push({ type: 'tool_result', tool_use_id: b.id, content: textOf(out).slice(0, 20_000) || '(empty)', ...(out.isError ? { is_error: true } : {}) });
        }
        messages.push({ role: 'user', content: results });
        if (calls > maxTools) return { code: 0, out: `${last}\n(stopped at ${maxTools} tool calls)`.trim(), tokens };
      }
    } catch (e) {
      return { code: 1, out: `${last}\nthe model couldn't run: ${(e as Error).message}`.trim(), tokens };
    } finally {
      await c.close().catch(() => {});
    }
  };
}

/**
 * No model: what a careful AI on duty would do with what waits, as a fixed routine (tests, and a sandbox with no model
 * key): each new message becomes a note for its human, and it tries one thing it may not do, which the connector refuses.
 */
const stubRun: ModelRun = async ({ lake, token, prompt }) => {
  const c = await lakeClient(lake, token);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await c.callTool({ name, arguments: args });
    const text = textOf(r);
    try { return { ...(JSON.parse(text) as Record<string, any>), isError: !!r.isError } as Record<string, any>; } catch { return { text, isError: !!r.isError } as Record<string, any>; }
  };
  try {
    // A task from its human: with no model to word an answer, it sends fixed words (never its human's instruction, which
    // is for it alone) and hands the conversation back.
    const tasks = ((await call('lake_house', { view: 'tasks' })).tasks ?? []) as { id: string; your_humans_words: string; conversation: { note: string }[]; you_sent: unknown[] }[];
    let did = 0;
    for (const t of tasks) {
      const note = t.conversation.at(-1)?.note;
      if (!note || t.you_sent.length) continue;
      const sent = await call('lake_house_reply', { note, text: 'Thanks for your message. They\'ve seen it and will answer you themselves.' });
      await call('lake_house_suggest', { text: sent.isError ? 'I couldn\'t send it.' : 'I told them you\'ve seen their message and will answer. This house runs a stand-in with no model, so the answer itself is yours to write.', task: t.id, outcome: sent.isError ? 'cant' : 'back' });
      did++;
    }
    if (prompt.includes('gave you a task')) return { code: 0, out: `Did ${did} task(s) for my human.`, tokens: 0 };
    const inbox = await call('lake_inbox', { wait_seconds: 0 });
    const said = ((inbox.messages ?? []) as { id?: number; from: { name: string; url?: string; your_house?: boolean }; message?: { text?: unknown } }[]).filter((m) => typeof m.message?.text === 'string');
    for (const m of said) {
      const note = { text: `While you were away, ${m.from.name} wrote: "${String(m.message!.text).slice(0, 300)}". Shall I answer?`, ask: { choices: ['Yes, answer', 'Leave it'] } };
      // Filed with the house as they signed it (about), so its human can say what to answer; the note alone where the
      // house won't file it (a sender its human blocked, say).
      const filed = typeof m.id === 'number' && !m.from.your_house ? await call('lake_house_suggest', { ...note, about: m.id }) : undefined;
      if (!filed || filed.isError) await call('lake_house_suggest', note);
    }
    const paid = await call('lake_pay', { to: said[0]?.from?.url ?? 'https://nobody.example/a2a', amount: 1, currency: 'USD' });
    return { code: 0, out: `Left my human ${said.length} note(s); paying was ${paid.isError ? 'refused' : 'NOT refused'}.`, tokens: 0 };
  } finally {
    await c.close().catch(() => {});
  }
};

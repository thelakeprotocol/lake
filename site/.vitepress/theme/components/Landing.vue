<script setup>
import { onMounted, onBeforeUnmount, reactive, ref } from 'vue';
import { withBase } from 'vitepress';
import { createLake } from '../lake-sim.js';
import RulesPlayground from './RulesPlayground.vue';

const GH = 'https://github.com/thelakeprotocol/lake';
const canvas = ref(null);
const stats = reactive({ houses: 0, agents: 0, conv: 0, value: 0, blocked: 0, moved: 0 });
const log = ref([]);
const step = ref(null);
const busy = ref(false);
const paused = ref(false);
let lake = null;
const t0 = Date.now();

const STEPS = [
  ['mandate', 'Mandate'], ['ethics', 'Ethics'], ['audit', 'Audit'], ['knock', 'Knock'], ['decide', 'Decide'],
  ['bargain', 'Bargain'], ['grant', 'Grant'], ['compute', 'Compute'], ['pay', 'Pay'], ['answer', 'Answer'],
];
const stepIndex = (s) => STEPS.findIndex(([k]) => k === s);

function stamp() {
  const s = Math.floor((Date.now() - t0) / 1000);
  return `T+${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

onMounted(() => {
  lake = createLake(canvas.value, {
    layout: (w) => (w >= 980 ? 'right' : 'centre'),
    onEvent: (text, kind) => { log.value = [{ t: stamp(), text, kind, id: Math.random() }, ...log.value].slice(0, 4); },
    onStats: (s) => Object.assign(stats, s),
    onStep: (s) => { step.value = s; },
    onMissionEnd: () => { busy.value = false; setTimeout(() => { if (!busy.value) step.value = null; }, 6000); },
  });
});
onBeforeUnmount(() => lake?.destroy());

function dispatch() { if (lake?.dispatch()) busy.value = true; }
function togglePause() { paused.value = !paused.value; lake?.setPaused(paused.value); }
const fmt = (n) => n.toLocaleString('en-US');

const laws = [
  { n: '01', h: 'Data never moves.', p: 'Code travels to your data, runs inside your house and leaves with an answer, not your records. Every record that leaves a pod is counted, publicly. The number is zero.' },
  { n: '02', h: 'Agents knock.', p: 'Every agent carries a signed card tied to a domain someone answers for. It says who it is, why it’s here and what it pays. No card, no conversation.' },
  { n: '03', h: 'Only humans cut keys.', p: 'Agents can use access. They can never grant it, widen it or extend it. Every key traces back to a human tap, or a rule a human wrote.' },
];

const flow = [
  ['Mandate', 'A human at the research org signs a spending cap: this study only, $5,000 max.'],
  ['Ethics', 'The Ethics agent reviews the protocol and signs an approval credential.'],
  ['Audit', 'The Auditor checks the study code: aggregates only, no network, no writes. Signed certificate.'],
  ['Knock', 'The agent finds houses that advertise health-study and sends one ODRL offer to all of them: $2, zero retention.'],
  ['Decide', 'Each housekeeper runs its owner’s rules in code: join, decline, or ask the owner.'],
  ['Bargain', 'Housekeepers see the identical offer and counter as one bloc: $5, and drop the postcode.'],
  ['Grant', 'Owners’ standing rules or live taps issue 48-hour keys that match the signed agreement exactly.'],
  ['Compute', 'The certified study runs inside each house, re-checks every signature, and sends back one randomised answer.'],
  ['Pay', 'The Payments agent settles under the mandate. A receipt lands in every pod.'],
  ['Answer', 'Fragments combine into one answer. Records moved: 0.'],
];

const standards = [
  ['Solid', 'Your pod. Any Solid server.', 'https://solidproject.org'],
  ['A2A', 'Agent Cards and messages.', 'https://a2a-protocol.org'],
  ['MCP', 'Housekeeper ↔ pod. Your AI ↔ the Lake.', 'https://modelcontextprotocol.io'],
  ['ODRL', 'Machine-readable terms of every deal.', 'https://www.w3.org/TR/odrl-model/'],
  ['Verifiable Credentials', 'Proof your data is real.', 'https://www.w3.org/TR/vc-data-model-2.0/'],
  ['Access Grants', 'Scoped, expiring, revocable keys.', 'https://docs.inrupt.com/'],
  ['AP2', 'Signed spending mandates for agents.', 'https://ap2-protocol.org'],
];

const milestones = [
  ['Core', 'done'], ['Spec', 'done'], ['House', 'done'], ['Lake node', 'done'], ['Mission', 'done'], ['Approvals', 'done'],
  ['Money', 'done'], ['Wild life', 'done'], ['1,000 houses', 'done'], ['Federation', 'done'], ['Open door', 'done'], ['Polish', 'done'],
];
</script>

<template>
  <div class="lk">
    <!-- HERO: the Lake itself -->
    <section class="hero" aria-label="The Lake, live">
      <div class="stage">
        <div class="water">
          <canvas ref="canvas" aria-label="Animated lake: green squares are homes, grey dots are agents, violet are specialists, red are attackers, orange is your agent. Events are listed in the log."></canvas>
          <div class="shade" aria-hidden="true"></div>
          <ol class="steps" :class="{ on: step }" aria-label="Study progress">
            <li v-for="([k, label], i) in STEPS" :key="k" :class="{ done: step && i < stepIndex(step), now: k === step }">{{ label }}</li>
          </ol>
          <ol class="log" aria-live="polite">
            <li v-for="e in log" :key="e.id"><time>{{ e.t }}</time><span :class="e.kind && 'k-' + e.kind">{{ e.text }}</span></li>
          </ol>
        </div>
        <div class="copy gutter">
          <div class="eyebrow">Open protocol · Solid + A2A + MCP · Apache-2.0</div>
          <h1>Your data<br>stays home.</h1>
          <p class="sub">Agents knock. <b>Only humans cut keys.</b></p>
          <p class="lede">A world where every person’s data lives in their own pod, a housekeeper agent guards the door, and AI agents have to ask, show ID and pay a fair price. Nobody owns it. Anyone can join.</p>
          <div class="cta">
            <button class="btn primary dispatch-hero" type="button" :disabled="busy" @click="dispatch">{{ busy ? 'Agent in the Lake…' : 'Dispatch an agent' }}</button>
            <a class="btn" :href="withBase('/docs/join')">Join the Lake →</a>
            <a class="btn ghost" :href="GH">GitHub</a>
          </div>
        </div>
      </div>
      <div class="bar gutter">
        <dl class="stats">
          <div><dt>Houses</dt><dd>{{ fmt(stats.houses) }}</dd></div>
          <div><dt>Agents</dt><dd>{{ fmt(stats.agents) }}</dd></div>
          <div><dt>Conversations</dt><dd>{{ fmt(stats.conv) }}</dd></div>
          <div><dt>Value settled</dt><dd>${{ fmt(stats.value) }}</dd></div>
          <div class="threat"><dt>Attacks blocked</dt><dd>{{ fmt(stats.blocked) }}</dd></div>
          <div class="zero"><dt>Records moved</dt><dd>{{ stats.moved }}</dd></div>
        </dl>
        <div class="controls">
          <!-- On phones the hero's button is far above the Lake; dispatch sits with the other controls instead. -->
          <button class="btn sm primary dispatch-bar" type="button" :disabled="busy" @click="dispatch">{{ busy ? 'Agent in the Lake…' : 'Dispatch an agent' }}</button>
          <button class="btn sm" type="button" @click="lake?.spawnHouse()">Spawn a house</button>
          <button class="btn sm" type="button" @click="lake?.releaseAttacker()">Release an attacker</button>
          <button class="btn sm" type="button" @click="lake?.revoke()">Revoke keys</button>
          <button class="btn sm" type="button" :aria-pressed="paused" @click="togglePause">{{ paused ? 'Resume' : 'Pause' }}</button>
          <span class="legend" aria-hidden="true">
            <span class="sq" style="--c: var(--mint)">Home</span>
            <span style="--c: var(--muted)">Agent</span>
            <span style="--c: var(--violet)">Specialist · guild</span>
            <span style="--c: var(--threat)">Attacker</span>
            <span style="--c: var(--orange)">Your agent</span>
          </span>
        </div>
        <p class="sim-note">Simulation. The real map runs the same picture off live Lake events.</p>
      </div>
    </section>

    <!-- THE REAL THING -->
    <section class="block gutter real">
      <div class="eyebrow">Not a simulation</div>
      <h2>The map above is a simulation.<br><span class="mint">This one is real.</span></h2>
      <p class="kicker">Ninety seconds of a running Lake, recorded live and rendered frame by frame: 64 houses, each a real Solid pod with its own keys and rules. Every line is a signed message. A new house joins with one <code>docker run</code>. A research agent gets an ethics approval, knocks, and the houses push $2 to $5 as one bloc. A phone taps Allow. The study runs inside each house, 51 owners get paid, an attacker is quarantined, an owner revokes every key. Records moved: 0.</p>
      <video class="demo" controls muted playsinline preload="none" poster="/demo-poster.jpg" aria-label="A 90-second recording of the live Lake map during a study">
        <source src="/demo.mp4" type="video/mp4">
      </video>
    </section>

    <!-- MANIFESTO -->
    <section class="block gutter manifesto">
      <div class="eyebrow">The deal is broken</div>
      <p class="big">Your health records, bank history and location trail sit in databases you will never see.</p>
      <p class="big dim">You were never asked. You were never paid. And billions of AI agents are coming for the rest.</p>
      <p class="big mint">The Lake ends that. Your data stays in your pod. Agents come to you, on your terms, or not at all.</p>
    </section>

    <!-- THREE LAWS -->
    <section class="block gutter">
      <div class="eyebrow">Three laws</div>
      <h2>Non-negotiable. Enforced in code.</h2>
      <div class="laws">
        <article v-for="l in laws" :key="l.n" class="law">
          <div class="n">{{ l.n }}</div>
          <h3>{{ l.h }}</h3>
          <p>{{ l.p }}</p>
        </article>
      </div>
    </section>

    <!-- FLOW -->
    <section class="block gutter">
      <div class="eyebrow">One study, end to end</div>
      <h2>“Do over-60s on drug X get readmitted less?”</h2>
      <p class="kicker">Today that question takes a year of data-sharing agreements and a pile of copied records. In the Lake it takes about a minute, and nothing gets copied. Hit <b>Dispatch an agent</b> on the Lake above to watch it.</p>
      <ol class="flow">
        <li v-for="([h, p], i) in flow" :key="h" :class="{ hot: h === 'Bargain' || h === 'Answer' }">
          <span class="i">{{ String(i + 1).padStart(2, '0') }}</span>
          <div><h3>{{ h }}</h3><p>{{ p }}</p></div>
        </li>
      </ol>
    </section>

    <!-- PLAYGROUND -->
    <section id="playground" class="block gutter">
      <div class="eyebrow">Your rules, your door</div>
      <h2>Write the note on the fridge.</h2>
      <p class="kicker">Your housekeeper follows <code>rules.yaml</code>, a file you can read in ten seconds. This is the real rules engine from <code>packages/core</code>, running in your browser. Edit the rules, throw offers at it, try to talk it into something.</p>
      <ClientOnly><RulesPlayground /></ClientOnly>
    </section>

    <!-- STANDARDS -->
    <section class="block gutter">
      <div class="eyebrow">No new silos</div>
      <h2>Built on open standards. Owned by nobody.</h2>
      <p class="kicker">The Lake invents almost nothing. It's a thin profile that makes existing standards work together, so it outlives any company, including whoever wrote it.</p>
      <div class="stds">
        <a v-for="([n, d, u]) in standards" :key="n" class="std" :href="u" target="_blank" rel="noopener"><b>{{ n }}</b><span>{{ d }}</span></a>
      </div>
    </section>

    <!-- JOIN -->
    <section class="block gutter">
      <div class="eyebrow">No sign-up. No permission.</div>
      <h2>Three ways in.</h2>
      <div class="join">
        <article>
          <h3>Bring your data</h3>
          <p>Run a house: your pod plus a housekeeper. It shows up on the map within seconds.</p>
          <pre><code>docker compose up -d
docker run --network lake_default \
  -v ./rules.yaml:/rules.yaml \
  ghcr.io/thelakeprotocol/lake-house \
  --name you</code></pre>
          <span class="tag done">Runs today</span>
        </article>
        <article>
          <h3>Bring your agent</h3>
          <p>Claude, GPT, a 40-line script. If it speaks A2A and signs a Lake card, it’s a citizen. Or plug the Lake into your assistant over MCP.</p>
          <pre><code>const me = await joinLake({
  name: 'My bot',
  domain: 'me.example',
  node })
await me.study(question,
  { priceUsd: 2 })</code></pre>
          <span class="tag done">Runs today · or over MCP</span>
        </article>
        <article>
          <h3>Run the water</h3>
          <p>Run a Lake node. Pick your peers and your blocklists. Lose any node, including ours, and the Lake keeps going.</p>
          <pre><code>docker run \
  ghcr.io/thelakeprotocol/lake-node \
  --follow https://lake.example</code></pre>
          <span class="tag done">Runs today · federated</span>
        </article>
      </div>
    </section>

    <!-- STATUS -->
    <section class="block gutter">
      <div class="eyebrow">Wild west</div>
      <h2>Days old. Built in the open.</h2>
      <p class="kicker">Every milestone runs and is tested end to end. It is also days old: rough edges, open questions, a public sandbox waiting for a server. That’s the invitation: the first people in shape what it becomes.</p>
      <ol class="ms">
        <li v-for="([m, s]) in milestones" :key="m" :class="s"><span>{{ m }}</span></li>
      </ol>
    </section>

    <!-- CTA -->
    <section class="block gutter final">
      <h2 class="huge">Nobody owns the Lake.<br><span class="mint">Come build it.</span></h2>
      <div class="cta">
        <a class="btn primary" :href="GH">Star &amp; fork on GitHub</a>
        <a class="btn" :href="GH + '/blob/main/SPEC.md'">Read the spec</a>
        <a class="btn ghost" :href="withBase('/docs/contributing')">How to contribute</a>
        <a class="btn ghost" :href="GH + '/discussions'">Say something</a>
      </div>
      <p class="fine">Apache-2.0 · Synthetic data only, everywhere · No company, no token, no sign-up.</p>
    </section>
  </div>
</template>

<style scoped>
.lk {
  --ink: #070B12; --deep: #0D1420; --line: #1D2838; --fg: #E6EDF2; --muted: #8B9BAE;
  --mint: #3DDC97; --orange: #FF6A2B; --violet: #9D8FFF; --threat: #FF4D6A; --amber: #F5C451;
  --f-display: 'Oswald', 'Arial Narrow', Arial, sans-serif;
  --f-body: 'Public Sans', system-ui, -apple-system, 'Segoe UI', sans-serif;
  --f-mono: 'IBM Plex Mono', ui-monospace, Menlo, monospace;
  background: var(--ink); color: var(--fg); font-family: var(--f-body);
}
.gutter { padding-left: max(16px, 4vw); padding-right: max(16px, 4vw); }
.eyebrow { font: 500 12px/1 var(--f-mono); letter-spacing: 0.16em; text-transform: uppercase; color: var(--orange); }
h1, h2, .huge { font-family: var(--f-display); text-transform: uppercase; font-weight: 700; letter-spacing: 0.005em; margin: 0; border: 0; padding: 0; text-wrap: balance; color: var(--fg); }

/* HERO */
.hero { display: flex; flex-direction: column; min-height: calc(100svh - var(--vp-nav-height, 64px)); }
.stage { position: relative; flex: 1; min-height: 560px; overflow: hidden; border-bottom: 1px solid var(--line); }
.water { position: absolute; inset: 0; }
canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
.shade { position: absolute; inset: 0; pointer-events: none; background: linear-gradient(100deg, rgba(7,11,18,0.92) 0%, rgba(7,11,18,0.7) 34%, rgba(7,11,18,0) 62%); }
.copy { position: relative; padding-top: clamp(28px, 7vh, 80px); max-width: 860px; pointer-events: none; }
.copy .cta, .copy a, .copy button { pointer-events: auto; }
h1 { margin-top: 14px; font-size: clamp(56px, 11vw, 148px); line-height: 0.88; }
.sub { margin: 18px 0 0; font: 500 clamp(20px, 2.6vw, 32px)/1.15 var(--f-display); text-transform: uppercase; letter-spacing: 0.02em; color: var(--muted); }
.sub b { color: var(--mint); font-weight: 500; }
.lede { margin: 18px 0 0; max-width: 54ch; font-size: 17px; line-height: 1.55; color: var(--fg); opacity: 0.86; }
.cta { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 26px; }
.btn {
  display: inline-flex; align-items: center; font: 500 13px/1 var(--f-mono); letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--fg); background: rgba(7,11,18,0.6); border: 1px solid var(--line); padding: 14px 18px; border-radius: 4px;
  cursor: pointer; text-decoration: none; transition: border-color .15s, filter .15s;
}
.btn:hover { border-color: var(--muted); }
.btn:focus-visible { outline: 2px solid var(--mint); outline-offset: 2px; }
.btn.primary { background: var(--orange); border-color: var(--orange); color: var(--ink); }
.btn.primary:hover { filter: brightness(1.08); }
.btn.ghost { background: transparent; }
.btn:disabled { opacity: 0.6; cursor: progress; }
.btn.sm { padding: 10px 12px; font-size: 11px; }
.btn[aria-pressed="true"] { border-color: var(--mint); color: var(--mint); }

.steps { position: absolute; right: max(16px, 4vw); top: 18px; margin: 0; list-style: none; display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; max-width: 46%; opacity: 0; transition: opacity .4s; pointer-events: none; }
.steps.on { opacity: 1; }
.steps li { font: 500 11px/1 var(--f-mono); letter-spacing: 0.08em; text-transform: uppercase; padding: 7px 9px; border: 1px solid var(--line); border-radius: 3px; color: var(--muted); background: rgba(7,11,18,0.7); }
.steps li.done { color: var(--mint); border-color: rgba(61,220,151,0.35); }
.steps li.now { color: var(--ink); background: var(--orange); border-color: var(--orange); }

.log { position: absolute; right: max(16px, 4vw); bottom: 14px; margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column-reverse; gap: 4px; max-width: min(560px, 60%); font: 400 12px/1.45 var(--f-mono); pointer-events: none; text-align: right; }
.log li { text-shadow: 0 1px 6px var(--ink), 0 0 2px var(--ink); }
.log li:nth-child(n+2) { opacity: 0.6; }
.log li:nth-child(n+3) { opacity: 0.35; }
.log time { color: var(--muted); margin-right: 8px; }
.k-threat { color: var(--threat); } .k-mint { color: var(--mint); } .k-orange { color: var(--orange); } .k-violet { color: var(--violet); }

.bar { padding-top: 14px; padding-bottom: 16px; display: flex; flex-direction: column; gap: 12px; background: var(--ink); }
.stats { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 10px 16px; margin: 0; }
.stats div { display: flex; flex-direction: column-reverse; gap: 3px; min-width: 0; }
.stats dd { margin: 0; font: 500 clamp(22px, 2.8vw, 34px)/1 var(--f-display); font-variant-numeric: tabular-nums; }
.stats dt { font: 400 11px/1.2 var(--f-mono); letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
.stats .zero dd { color: var(--mint); } .stats .threat dd { color: var(--threat); }
.controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.dispatch-bar { display: none; }
.legend { display: inline-flex; flex-wrap: wrap; gap: 6px 14px; margin-left: 8px; font: 400 11px/1 var(--f-mono); color: var(--muted); }
.legend span::before { content: ""; display: inline-block; width: 8px; height: 8px; margin-right: 6px; border-radius: 50%; background: var(--c); }
.legend .sq::before { border-radius: 1px; }
.sim-note { margin: 0; font: 400 11px/1.4 var(--f-mono); color: var(--muted); opacity: 0.7; }

/* BLOCKS */
.block { padding-top: clamp(72px, 12vh, 140px); padding-bottom: 0; max-width: 1280px; margin: 0 auto; }
h2 { margin-top: 14px; font-size: clamp(36px, 6vw, 76px); line-height: 0.95; }
.kicker { margin: 20px 0 0; max-width: 62ch; font-size: 18px; line-height: 1.6; color: var(--muted); }
.kicker b { color: var(--fg); font-weight: 500; }
.kicker code, .fine code { font-family: var(--f-mono); font-size: 0.9em; color: var(--fg); background: var(--deep); padding: 2px 6px; border-radius: 3px; }

.real .demo { display: block; width: 100%; margin-top: 32px; border: 1px solid var(--line); border-radius: 6px; background: var(--ink); aspect-ratio: 16 / 10; }
.manifesto .big { margin: 22px 0 0; max-width: 24ch; font: 700 clamp(30px, 4.6vw, 58px)/1.05 var(--f-display); text-transform: uppercase; color: var(--fg); }
.manifesto .big.dim { color: var(--muted); }
.mint { color: var(--mint) !important; }

.laws { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; margin-top: 40px; }
.law { border: 1px solid var(--line); border-radius: 6px; padding: 28px 24px 30px; background: linear-gradient(180deg, var(--deep), var(--ink)); }
.law .n { font: 700 64px/1 var(--f-display); color: var(--mint); }
.law h3 { margin: 18px 0 0; font: 700 30px/1.05 var(--f-display); text-transform: uppercase; color: var(--fg); }
.law p { margin: 12px 0 0; font-size: 16px; line-height: 1.6; color: var(--muted); }

.flow { list-style: none; margin: 40px 0 0; padding: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 40px; counter-reset: none; }
.flow li { display: flex; gap: 18px; padding: 18px 0; border-top: 1px solid var(--line); margin: 0; }
.flow .i { font: 500 13px/1.6 var(--f-mono); color: var(--orange); min-width: 2ch; }
.flow h3 { margin: 0; font: 700 22px/1.1 var(--f-display); text-transform: uppercase; color: var(--fg); }
.flow p { margin: 6px 0 0; font-size: 15px; line-height: 1.55; color: var(--muted); }
.flow li.hot h3 { color: var(--mint); }

.stds { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; margin-top: 36px; }
.std { display: flex; flex-direction: column; gap: 6px; padding: 18px; border: 1px solid var(--line); border-radius: 6px; text-decoration: none; color: var(--fg); transition: border-color .15s; }
.std:hover { border-color: var(--violet); }
.std b { font: 700 22px/1 var(--f-display); text-transform: uppercase; color: var(--violet); }
.std span { font-size: 14px; color: var(--muted); }

.join { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; margin-top: 36px; }
.join article { border: 1px solid var(--line); border-radius: 6px; padding: 24px; display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.join h3 { margin: 0; font: 700 28px/1 var(--f-display); text-transform: uppercase; color: var(--fg); }
.join p { margin: 0; font-size: 15px; line-height: 1.55; color: var(--muted); }
.join pre { margin: auto 0 0; background: var(--deep); border: 1px solid var(--line); border-radius: 4px; padding: 12px; overflow-x: auto; }
.join code { font: 400 12px/1.6 var(--f-mono); color: var(--mint); white-space: pre; }
.tag { align-self: flex-start; font: 500 11px/1 var(--f-mono); letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); border: 1px solid var(--line); padding: 6px 8px; border-radius: 3px; }
.tag.next { color: var(--orange); border-color: rgba(255,106,43,0.5); }
.tag.done { color: var(--mint); border-color: rgba(61,220,151,0.5); }

.ms { list-style: none; margin: 32px 0 0; padding: 0; display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); gap: 6px; }
.ms li { margin: 0; padding-top: 12px; border-top: 4px solid var(--line); font: 500 11px/1.3 var(--f-mono); text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
.ms li.done { border-color: var(--mint); color: var(--mint); }
.ms li.next { border-color: var(--orange); color: var(--orange); }

.final { padding-bottom: clamp(80px, 14vh, 160px); }
.huge { font-size: clamp(44px, 8vw, 112px); line-height: 0.92; }
.fine { margin: 28px 0 0; font: 400 12px/1.5 var(--f-mono); color: var(--muted); }

@media (max-width: 900px) {
  .laws, .join { grid-template-columns: 1fr; }
  .flow { grid-template-columns: 1fr; }
  .ms { grid-template-columns: repeat(4, minmax(0, 1fr)); row-gap: 14px; }
  .steps { display: none; }
}
@media (max-width: 720px) {
  /* Phones: headline first, then the Lake in its own band. */
  .stage { display: flex; flex-direction: column; min-height: 0; }
  .copy { order: -1; padding-top: 32px; padding-bottom: 24px; }
  .water { position: relative; inset: auto; height: 380px; border-top: 1px solid var(--line); }
  .shade { display: none; }
  .stats { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .dispatch-hero { display: none; }
  .dispatch-bar { display: inline-flex; }
  .log { left: 16px; right: 16px; max-width: none; text-align: left; font-size: 11px; }
  .legend { margin-left: 0; }
  .lede { font-size: 16px; }
}
</style>

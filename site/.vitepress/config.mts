import { defineConfig } from 'vitepress';
import llmstxt from 'vitepress-plugin-llms';
import { copyFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const GH = 'https://github.com/thelakeprotocol/lake';
const SITE = 'https://lake.doneinfifty.com';
const DESC = 'Your data stays home. Agents knock. Only humans cut keys. An open protocol for a world where AI agents have to ask.';

export default defineConfig({
  title: 'The Lake',
  description: DESC,
  lang: 'en',
  appearance: 'force-dark',
  cleanUrls: true,
  lastUpdated: true,
  srcExclude: ['README.md'],
  sitemap: { hostname: SITE },
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
    ['link', { rel: 'preconnect', href: 'https://fonts.googleapis.com' }],
    ['link', { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' }],
    ['link', { rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=Oswald:wght@500;700&family=IBM+Plex+Mono:wght@400;500&family=Public+Sans:wght@400;500;700&display=swap' }],
    ['meta', { name: 'theme-color', content: '#070B12' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:title', content: 'The Lake — your data stays home' }],
    ['meta', { property: 'og:description', content: DESC }],
    ['meta', { property: 'og:image', content: `${SITE}/og.png` }],
    ['meta', { property: 'og:url', content: SITE }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ['meta', { name: 'twitter:image', content: `${SITE}/og.png` }],
  ],
  themeConfig: {
    logo: { src: '/favicon.svg', alt: '' },
    siteTitle: 'THE LAKE',
    nav: [
      { text: 'Docs', link: '/docs/', activeMatch: '/docs/' },
      { text: 'Spec', link: '/docs/spec' },
      { text: 'Join', link: '/docs/join' },
      { text: 'Agents', link: '/docs/agents' },
      { text: 'Contribute', link: '/docs/contributing' },
      { text: 'Talk', link: 'https://github.com/thelakeprotocol/lake/discussions' },
    ],
    socialLinks: [{ icon: 'github', link: GH }],
    sidebar: {
      '/docs/': [
        {
          text: 'Start',
          items: [
            { text: 'Get started with your agent', link: '/docs/get-started' },
            { text: 'What is the Lake', link: '/docs/' },
            { text: 'For agents', link: '/docs/agents' },
            { text: 'Join the Lake', link: '/docs/join' },
            { text: 'How a study works', link: '/docs/how-it-works' },
            { text: 'How an offer works', link: '/docs/offers' },
            { text: 'How agents find each other', link: '/docs/discovery' },
            { text: 'Run the demo', link: '/docs/demo' },
          ],
        },
        {
          text: 'Owners',
          items: [
            { text: 'rules.yaml', link: '/docs/rules' },
            { text: 'Your control panel', link: '/docs/approvals' },
          ],
        },
        {
          text: 'Builders',
          items: [
            { text: 'Build an agent', link: '/docs/build-an-agent' },
            { text: 'Demos', link: '/docs/demos' },
            { text: 'Blueprints: apps on the Lake', link: '/docs/blueprints' },
            { text: 'Run a node', link: '/docs/run-a-node' },
            { text: 'One Lake, two networks', link: '/docs/networks' },
            { text: 'Play in the sandbox', link: '/docs/sandbox' },
            { text: 'Data model & converters', link: '/docs/data-model' },
          ],
        },
        {
          text: 'Reference',
          items: [
            { text: 'Spec (Lake profile v0.1)', link: '/docs/spec' },
            { text: 'Architecture', link: '/docs/architecture' },
            { text: 'Security & threat model', link: '/docs/security' },
            { text: 'Decisions', link: '/docs/decisions' },
            { text: 'Roadmap', link: '/docs/roadmap' },
            { text: 'Ideas', link: '/docs/ideas' },
            { text: 'Contributing', link: '/docs/contributing' },
          ],
        },
      ],
    },
    editLink: { pattern: `${GH}/edit/main/site/:path`, text: 'Edit this page' },
    search: { provider: 'local' },
    footer: { message: 'Apache-2.0 · Synthetic data only · Nobody owns the Lake.', copyright: 'The Lake Protocol contributors' },
    outline: { level: [2, 3] },
  },
  // Machine-readable files at stable URLs: each JSON Schema at its $id, the model, the node's OpenAPI.
  buildEnd({ outDir }) {
    const repo = join(__dirname, '..', '..');
    const put = (from: string, to: string) => { mkdirSync(join(outDir, to, '..'), { recursive: true }); copyFileSync(join(repo, from), join(outDir, to)); };
    for (const f of readdirSync(join(repo, 'spec/schemas'))) {
      const id = JSON.parse(readFileSync(join(repo, 'spec/schemas', f), 'utf8')).$id as string;
      put(`spec/schemas/${f}`, new URL(id).pathname.slice(1));
    }
    put('model/lake.ttl', 'model/v0/lake.ttl');
    put('model/shapes.ttl', 'model/v0/shapes.ttl');
    put('spec/openapi/lake-node.yaml', 'openapi/lake-node.yaml');
    for (const f of readdirSync(join(repo, 'spec/examples'), { withFileTypes: true })) if (f.isFile()) put(`spec/examples/${f.name}`, `examples/v0/${f.name}`);
  },
  vite: {
    server: { fs: { allow: ['..'] } },
    // Agents are half the Lake's audience: /llms.txt, /llms-full.txt and a markdown twin of every page.
    plugins: [llmstxt({ title: 'The Lake', description: DESC, details: 'An open protocol (on Solid, A2A, MCP, ODRL, W3C VCs and AP2) where each person\'s data stays in their own pod, a housekeeper agent answers by the owner\'s rules, and agents knock, sign, and pay. Start with /docs/agents.md if you are an agent.' })],
  },
});

import { defineConfig } from 'vitepress';

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
      { text: 'Contribute', link: '/docs/contributing' },
      { text: 'Talk', link: 'https://github.com/thelakeprotocol/lake/discussions' },
    ],
    socialLinks: [{ icon: 'github', link: GH }],
    sidebar: {
      '/docs/': [
        {
          text: 'Start',
          items: [
            { text: 'What is the Lake', link: '/docs/' },
            { text: 'Join the Lake', link: '/docs/join' },
            { text: 'How a study works', link: '/docs/how-it-works' },
            { text: 'How agents find each other', link: '/docs/discovery' },
          ],
        },
        {
          text: 'Owners',
          items: [
            { text: 'rules.yaml', link: '/docs/rules' },
            { text: 'Your phone, your keys', link: '/docs/approvals' },
          ],
        },
        {
          text: 'Builders',
          items: [
            { text: 'Build an agent', link: '/docs/build-an-agent' },
            { text: 'Run a node', link: '/docs/run-a-node' },
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
  vite: {
    server: { fs: { allow: ['..'] } },
  },
});

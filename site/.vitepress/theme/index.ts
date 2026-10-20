import DefaultTheme from 'vitepress/theme';
import type { Theme } from 'vitepress';
import Landing from './components/Landing.vue';
import './brand.css';

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('landing', Landing);
  },
} satisfies Theme;

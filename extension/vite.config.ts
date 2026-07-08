import { defineConfig } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.config';

const isStore = process.env.CWS_BUILD === '1';

export default defineConfig({
  plugins: [crx({ manifest })],
  // Exposed to source as a compile-time boolean so the options page can hide the
  // custom-baseUrl field in the store build (where 'https://*/*' isn't grantable).
  define: { __CWS_BUILD__: JSON.stringify(isStore) },
  build: { target: 'es2022' },
});

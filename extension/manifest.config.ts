import { defineManifest } from '@crxjs/vite-plugin';

export default defineManifest({
  manifest_version: 3,
  name: 'Warsaw Beer Overlay',
  description: 'Shows which beers you have already drunk + your rating on craft beer stores.',
  version: '0.1.0',
  permissions: ['storage'],
  host_permissions: ['https://beer-api.ysilvestrov-ai.uk/*'],
  optional_host_permissions: ['https://*/*'],
  options_page: 'src/options/options.html',
  background: { service_worker: 'src/background/index.ts', type: 'module' },
  content_scripts: [
    {
      matches: [
        'https://beerrepublic.eu/*',
        'https://onemorebeer.pl/*',
        'https://*.onemorebeer.pl/*',
      ],
      js: ['src/content/main.ts'],
      run_at: 'document_idle',
    },
  ],
});

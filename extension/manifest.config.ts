import { defineManifest } from '@crxjs/vite-plugin';
import pkg from './package.json' with { type: 'json' };

const KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqyZ4PALvAS9pOB6ImBCHA9T+5+8R94pTlH0NlALbbwTBbx4lIkilGB82gxXN1u/i/f7FSRhmxN4w/1b4jcl8MxqsxUrJOFg9u2dm84lwIqLN0ocjcGliZsnUFpwXBkn/23EWnPFhHtSV7OLfegPP2edMvZLCJ7yeXNZpfpDhNCdsBbQraLawY21zE+x0OpnRZ7CT2TLXyi+JtiDusaYvSN4eOnGTOAZTCBvXdrikll1zOpqkWrZ2fjryQ8A+8NGEz3eXsokG9O6jy9oK21AS+fKTmjkNCsddsbCoZm8D0m4xLnDBxxkv4LOMWGFG1MPv4gz0aXspaximsyFExL38KQIDAQAB';

const ICONS = {
  16: 'public/icons/icon-16.png',
  32: 'public/icons/icon-32.png',
  48: 'public/icons/icon-48.png',
  128: 'public/icons/icon-128.png',
};

const SHOP_MATCHES = [
  'https://beerrepublic.eu/*',
  'https://*.beerrepublic.eu/*',
  'https://onemorebeer.pl/*',
  'https://*.onemorebeer.pl/*',
  'https://beerfreak.org/*',
  'https://*.beerfreak.org/*',
  'https://bierloods22.nl/*',
  'https://*.bierloods22.nl/*',
  'https://winetime.com.ua/*',
  'https://*.winetime.com.ua/*',
  'https://hoptimaal.com/*',
  'https://*.hoptimaal.com/*',
  'https://flasker.com.ua/*',
  'https://*.flasker.com.ua/*',
  'https://piwnemosty.pl/*',
  'https://*.piwnemosty.pl/*',
  'https://funkyshop.pl/*',
  'https://*.funkyshop.pl/*',
  'https://beershop.pl/*',
  'https://*.beershop.pl/*',
  'https://beershop.cz/*',
  'https://*.beershop.cz/*',
  'https://beershop.sk/*',
  'https://*.beershop.sk/*',
  'https://beershop.eu/*',
  'https://*.beershop.eu/*',
  'https://beershop.de/*',
  'https://*.beershop.de/*',
];

// Direct Untappd domains and Algolia search — zero 3rd-party servers
const UNTAPPD_ORIGINS = [
  'https://untappd.com/*',
  'https://*.untappd.com/*',
  'https://api.untappd.com/*',
  'https://*.algolia.net/*',
];

export function buildManifest(opts: { store: boolean }) {
  return {
    manifest_version: 3 as const,
    name: 'Warsaw Beer Overlay',
    description: 'Shows which beers you have already drunk + your rating on craft beer stores. Direct Untappd integration with local browser database.',
    version: pkg.version,
    icons: ICONS,
    permissions: ['storage', 'activeTab', 'cookies'],
    host_permissions: UNTAPPD_ORIGINS,
    action: { default_popup: 'src/popup/popup.html', default_icon: ICONS },
    options_page: 'src/options/options.html',
    background: { service_worker: 'src/background/index.ts', type: 'module' as const },
    content_scripts: [
      { matches: SHOP_MATCHES, js: ['src/content/main.ts'], run_at: 'document_idle' as const },
    ],
    key: opts.store ? undefined : (KEY as string | undefined),
  };
}

export default defineManifest(buildManifest({ store: process.env.CWS_BUILD === '1' }));

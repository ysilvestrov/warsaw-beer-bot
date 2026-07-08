import { defineManifest } from '@crxjs/vite-plugin';
import pkg from './package.json';

// Public key only; the private key (~/warsaw-beer-extension-key.pem) is kept by the
// maintainer. Pins a stable unpacked extension id so a tester's stored token survives a
// folder change / remove+re-add. Dev build only — CWS rejects packages that carry `key`.
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
];

// Enrichment + check-in sync reach Untappd and its Algolia search from the user's session.
// Requested at runtime (optional) via the options toggle / popup Sync button.
const ENRICH_ORIGINS = ['https://untappd.com/*', 'https://*.algolia.net/*'];

export function buildManifest(opts: { store: boolean }) {
  // Single shape (key?: string) rather than a conditional spread, so consumers/tests can
  // read `.key` without a union type. `key: undefined` is dropped when crx serialises the
  // manifest to JSON, so the store build emits no key at all.
  return {
    manifest_version: 3 as const,
    name: 'Warsaw Beer Overlay',
    description: 'Shows which beers you have already drunk + your rating on craft beer stores.',
    version: pkg.version,
    icons: ICONS,
    // storage: match cache + token/settings. activeTab: the popup reads the active tab's
    // URL (chrome.tabs.query) and messages its content script (chrome.tabs.sendMessage)
    // for "Refresh this page" — both covered by activeTab, so `tabs` is not needed.
    permissions: ['storage', 'activeTab'],
    host_permissions: ['https://beer-api.ysilvestrov-ai.uk/*'],
    // The store build drops the broad 'https://*/*' (custom-baseUrl debugging) the dev
    // build keeps, to avoid an "access all sites" review flag.
    optional_host_permissions: opts.store ? ENRICH_ORIGINS : [...ENRICH_ORIGINS, 'https://*/*'],
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

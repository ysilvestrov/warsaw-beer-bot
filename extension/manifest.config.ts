import { defineManifest } from '@crxjs/vite-plugin';
import pkg from './package.json';

export default defineManifest({
  manifest_version: 3,
  name: 'Warsaw Beer Overlay',
  description: 'Shows which beers you have already drunk + your rating on craft beer stores.',
  version: pkg.version,
  // Pins a stable unpacked extension id regardless of install path, so a tester's
  // stored token survives a folder change / remove+re-add. Public key only; the
  // private key (~/warsaw-beer-extension-key.pem) is kept by the maintainer.
  key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqyZ4PALvAS9pOB6ImBCHA9T+5+8R94pTlH0NlALbbwTBbx4lIkilGB82gxXN1u/i/f7FSRhmxN4w/1b4jcl8MxqsxUrJOFg9u2dm84lwIqLN0ocjcGliZsnUFpwXBkn/23EWnPFhHtSV7OLfegPP2edMvZLCJ7yeXNZpfpDhNCdsBbQraLawY21zE+x0OpnRZ7CT2TLXyi+JtiDusaYvSN4eOnGTOAZTCBvXdrikll1zOpqkWrZ2fjryQ8A+8NGEz3eXsokG9O6jy9oK21AS+fKTmjkNCsddsbCoZm8D0m4xLnDBxxkv4LOMWGFG1MPv4gz0aXspaximsyFExL38KQIDAQAB',
  // storage: the match cache + token/settings. activeTab + tabs: the popup reads the
  // active tab's URL (chrome.tabs.query) and messages its content script
  // (chrome.tabs.sendMessage) for "Refresh this page". (tabs is a candidate to trim to
  // activeTab-only once the popup is verified in Chrome — see PR #135 manual checklist.)
  permissions: ['storage', 'activeTab', 'tabs'],
  host_permissions: ['https://beer-api.ysilvestrov-ai.uk/*'],
  optional_host_permissions: ['https://untappd.com/*', 'https://*.algolia.net/*', 'https://*/*'],
  action: { default_popup: 'src/popup/popup.html' },
  options_page: 'src/options/options.html',
  background: { service_worker: 'src/background/index.ts', type: 'module' },
  content_scripts: [
    {
      matches: [
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
      ],
      js: ['src/content/main.ts'],
      run_at: 'document_idle',
    },
  ],
});

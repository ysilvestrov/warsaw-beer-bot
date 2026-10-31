import { fileURLToPath } from 'node:url';

// #924: the extension imports the server's own feed parser from ../src/shared/. A bare `cheerio`
// in a file outside extension/ would be looked up in the root node_modules, which the extension's
// CI leg never installs, so it is pinned to this package's copy — and to its `slim` browser build
// (htmlparser2, no parse5), the variant the spike measured.
const here = fileURLToPath(new URL('.', import.meta.url));

export const sharedCoreAlias = {
  cheerio: `${here}node_modules/cheerio/dist/browser/slim.js`,
};

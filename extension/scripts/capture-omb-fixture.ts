import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Candidate selectors that mark a rendered product card. The script tries each;
// the first that appears is used as the readiness signal and logged so the
// adapter (Task 10) can reuse it.
const CARD_CANDIDATES = [
  '[class*="product-tile"]',
  '[class*="product-card"]',
  '[class*="catalog-item"]',
  '[class*="product-item"]',
  'a[href*="/produkt"]',
  'a[href*="/p/"]',
];

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' });
  await page.goto('https://onemorebeer.pl/piwa', { waitUntil: 'networkidle', timeout: 60_000 });

  let used = '';
  for (const sel of CARD_CANDIDATES) {
    try {
      await page.waitForSelector(sel, { timeout: 8000 });
      used = sel;
      break;
    } catch {
      /* try next candidate */
    }
  }
  if (!used) throw new Error('No product-card selector matched; inspect the page manually.');
  console.log(`Rendered card selector that matched: ${used}`);

  const html = await page.content();
  const outDir = fileURLToPath(new URL('../tests/fixtures/', import.meta.url));
  mkdirSync(outDir, { recursive: true });
  writeFileSync(`${outDir}onemorebeer-piwa.html`, html, 'utf8');
  console.log('Wrote tests/fixtures/onemorebeer-piwa.html');

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

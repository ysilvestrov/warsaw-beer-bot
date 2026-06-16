import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Flasker's home/store grid is the WooCommerce "All Products" block — rendered
// client-side via the Store API as li.wc-block-grid__product. Capture after
// networkidle so the cards are in the DOM.
const CARD_SELECTOR = 'li.wc-block-grid__product';

async function main() {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' });
    await page.goto('https://flasker.com.ua/', { waitUntil: 'networkidle', timeout: 60_000 });
    await page.waitForSelector(CARD_SELECTOR, { timeout: 15_000 });

    const count = await page.locator(CARD_SELECTOR).count();
    console.log(`Rendered ${count} cards (${CARD_SELECTOR})`);

    const html = await page.content();
    const outDir = fileURLToPath(new URL('../tests/fixtures/', import.meta.url));
    mkdirSync(outDir, { recursive: true });
    writeFileSync(`${outDir}flasker.block.html`, html, 'utf8');
    console.log('Wrote tests/fixtures/flasker.block.html');
  } finally {
    await browser.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Confirmed: onemorebeer tiles are .one-product-list-view__tile. The SPA paginates
// client-side (~15/page); only ~4 tiles render at networkidle, stabilizing after a
// scroll + wait.
const CARD_SELECTOR = '.one-product-list-view__tile';

async function main() {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' });
    await page.goto('https://onemorebeer.pl/piwa', { waitUntil: 'networkidle', timeout: 60_000 });

    await page.waitForSelector(CARD_SELECTOR, { timeout: 15_000 });

    // Tiles finish hydrating after networkidle — scroll a few times + wait so the
    // full page of tiles is in the DOM before we dump the fixture.
    for (let i = 0; i < 4; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1500);
    }
    await page.evaluate(() => window.scrollTo(0, 0));

    const count = await page.locator(CARD_SELECTOR).count();
    console.log(`Rendered ${count} tiles (${CARD_SELECTOR})`);

    const html = await page.content();
    const outDir = fileURLToPath(new URL('../tests/fixtures/', import.meta.url));
    mkdirSync(outDir, { recursive: true });
    writeFileSync(`${outDir}onemorebeer-piwa.html`, html, 'utf8');
    console.log('Wrote tests/fixtures/onemorebeer-piwa.html');
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CARD = '.one-product-list-view__tile';

async function main() {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' });
    await page.goto('https://onemorebeer.pl/szklanki-i-akcesoria', { waitUntil: 'networkidle', timeout: 60_000 });
    await page.waitForSelector(CARD, { timeout: 15_000 });
    // Do NOT scroll/paginate: keep only the first page (all-merch). Later pages may include the
    // MAGIC ROAD beer, which must NOT be in a "pure non-beer" fixture.
    const count = await page.locator(CARD).count();
    console.log(`Rendered ${count} accessory tiles`);
    const html = await page.content();
    const out = fileURLToPath(new URL('../tests/fixtures/onemorebeer.nonbeer.html', import.meta.url));
    writeFileSync(out, html, 'utf8');
    console.log('Wrote tests/fixtures/onemorebeer.nonbeer.html');
  } finally {
    await browser.close();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

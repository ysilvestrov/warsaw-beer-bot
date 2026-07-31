import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// #369: fixture for the "Dane techniczne" panel — specifically a 0.0% product.
// /bezalkoholowe/inne is where orphan 29552 (AleBrowar KWAS CHLEBOWY JASNY) was
// scraped from; being the alcohol-free category it is dense with Moc (%) = 0.0%,
// which is the value that tells Kwas Chlebowy Bright from Light (#322).
//
// The panel is a hidden SIBLING of the tile under .one-product-list-view — it must be
// captured collapsed, exactly as the adapter sees it. Do not expand anything.
const CARD = '.one-product-list-view__tile';
const PANEL = '.one-product-technical-data';

async function main() {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' });
    await page.goto('https://onemorebeer.pl/bezalkoholowe/inne', { waitUntil: 'networkidle', timeout: 60_000 });
    await page.waitForSelector(CARD, { timeout: 15_000 });

    // Tiles finish hydrating after networkidle — scroll a few times + wait so the full
    // page is in the DOM. A capture taken mid-hydration yields wrappers that hold the
    // technical panel but no tile, which parses to zero cards.
    for (let i = 0; i < 4; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1500);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(1000);

    const stats = await page.evaluate(
      ([cardSel, panelSel]) => {
        const tiles = Array.from(document.querySelectorAll(cardSel));
        let withPanel = 0;
        let withMoc = 0;
        const zero: string[] = [];
        for (const tile of tiles) {
          const panel = tile.closest('.one-product-list-view')?.querySelector(panelSel);
          if (!panel) continue;
          withPanel++;
          for (const row of Array.from(panel.children)) {
            const spans = row.querySelectorAll('span');
            const label = (spans[0]?.textContent ?? '').trim();
            const value = (spans[1]?.textContent ?? '').trim();
            if (!label.startsWith('Moc')) continue;
            withMoc++;
            if (parseFloat(value.replace(',', '.')) === 0) {
              zero.push((tile.querySelector('a.product__title')?.textContent ?? '?').replace(/\s+/g, ' ').trim());
            }
          }
        }
        return { tiles: tiles.length, withPanel, withMoc, zero };
      },
      [CARD, PANEL] as const,
    );

    console.log(`tiles ${stats.tiles} | with panel ${stats.withPanel} | with Moc (%) ${stats.withMoc} | 0.0% ${stats.zero.length}`);
    stats.zero.forEach((n) => console.log(`   0.0% → ${n}`));

    // Fail loudly rather than write a fixture that cannot pin what it exists to pin.
    // A mid-hydration capture (panels but no tiles) is the observed failure mode.
    if (stats.tiles === 0) throw new Error('no tiles rendered — captured mid-hydration, re-run');
    if (stats.withPanel === 0) throw new Error('no tile resolved to a technical panel — selector drift?');
    if (stats.zero.length === 0) throw new Error('no 0.0% product on this page — it cannot pin the #369 guard');

    const html = await page.content();
    const out = fileURLToPath(new URL('../tests/fixtures/onemorebeer.abv.html', import.meta.url));
    writeFileSync(out, html, 'utf8');
    console.log('Wrote tests/fixtures/onemorebeer.abv.html');
  } finally {
    await browser.close();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

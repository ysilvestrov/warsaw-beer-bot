// Captures ONE flasker product page as a fixture for the #384 detail-fetch tests.
// Usage: npx tsx scripts/capture-flasker-product.ts <slug> [outfile]
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const slug = process.argv[2] ?? 'tomatol-bulgogi-3-8-330мл';
const out = process.argv[3] ?? 'tests/fixtures/flasker.product.html';

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`https://flasker.com.ua/product/${encodeURIComponent(slug)}/`, {
    waitUntil: 'domcontentloaded',
  });
  const html = await page.content();
  await browser.close();

  // Same spirit as the block-page guard in capture-fixture.ts: refuse to write a
  // Cloudflare challenge over a good fixture.
  if (!/untappd\.com\/b\//.test(html) && !/"@type":"Brand"/.test(html)) {
    throw new Error(`capture looks wrong (${html.length} bytes, no bid and no brand) — refusing to write`);
  }
  writeFileSync(out, html);
  console.log(`wrote ${out} (${html.length} bytes)`);
}

main().catch((e) => { console.error(e); process.exit(1); });

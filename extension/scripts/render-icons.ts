// Rasterises extension/icons/icon.svg → public/icons/icon-<n>.png at CWS sizes.
// Uses Playwright (already a devDependency, also used for fixture capture). The SVG
// is non-square (200×240); we centre it in a square canvas with ~8% padding and a
// transparent background, preserving aspect ratio. Run via `npm run render-icons`
// whenever icon.svg changes; the PNGs are committed so `build` needs no browser.
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = resolve(HERE, '..');
const SIZES = [16, 32, 48, 128] as const;

async function main() {
  const svg = readFileSync(resolve(EXT_ROOT, 'icons/icon.svg'), 'utf8');
  const outDir = resolve(EXT_ROOT, 'public/icons');
  mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    for (const size of SIZES) {
      await page.setViewportSize({ width: size, height: size });
      const inner = Math.round(size * 0.92);
      await page.setContent(
        `<style>*{margin:0;padding:0}html,body{width:${size}px;height:${size}px}` +
          `.wrap{width:${size}px;height:${size}px;display:flex;align-items:center;` +
          `justify-content:center;box-sizing:border-box}` +
          `svg{width:${inner}px;height:${inner}px}</style>` +
          `<div class="wrap">${svg}</div>`,
        { waitUntil: 'load' },
      );
      const buf = await page.locator('.wrap').screenshot({ omitBackground: true });
      writeFileSync(resolve(outDir, `icon-${size}.png`), buf);
      console.log(`wrote icon-${size}.png`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

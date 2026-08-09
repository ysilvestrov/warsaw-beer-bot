import { chromium } from 'playwright';
import { JSDOM } from 'jsdom';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CAPTURE_TARGETS, shouldWriteFixture, type CaptureTarget } from './capture-targets';
import { ADAPTERS } from '../src/sites/registry';

const FIXTURE_DIR = fileURLToPath(new URL('../tests/fixtures/', import.meta.url));
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36';

function existingCardCount(target: CaptureTarget): number | null {
  const path = `${FIXTURE_DIR}${target.out}`;
  if (!existsSync(path)) return null;
  const dom = new JSDOM(readFileSync(path, 'utf8'));
  return dom.window.document.querySelectorAll(target.cardSelector).length;
}

function parseFixture(target: CaptureTarget): void {
  const adapter = ADAPTERS.find((a) => a.id === target.adapter);
  if (!adapter) throw new Error(`no adapter with id "${target.adapter}"`);
  const dom = new JSDOM(readFileSync(`${FIXTURE_DIR}${target.out}`, 'utf8'));
  const cards = adapter.parseCards(dom.window.document);
  console.log(`  parsed ${cards.length} cards:`);
  for (const c of cards) {
    const abv = c.abv === undefined ? '' : ` [${c.abv}%]`;
    console.log(`    ${c.brewery} | ${c.name}${abv}`);
  }
}

async function capture(target: CaptureTarget, force: boolean): Promise<boolean> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ userAgent: UA });
    await page.goto(target.url, { waitUntil: 'networkidle', timeout: 60_000 });
    await page.waitForSelector(target.cardSelector, { timeout: 15_000 }).catch(() => undefined);

    for (let i = 0; i < (target.scrolls ?? 0); i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1500);
    }
    if (target.scrolls) await page.evaluate(() => window.scrollTo(0, 0));

    const next = await page.locator(target.cardSelector).count();
    const verdict = shouldWriteFixture(existingCardCount(target), next, force);
    console.log(`${target.name}: ${verdict.reason}`);
    if (!verdict.ok) return false;

    mkdirSync(FIXTURE_DIR, { recursive: true });
    writeFileSync(`${FIXTURE_DIR}${target.out}`, await page.content(), 'utf8');
    console.log(`  wrote tests/fixtures/${target.out}`);
    return true;
  } finally {
    await browser.close();
  }
}

async function main(argv: string[]): Promise<void> {
  const force = argv.includes('--force');
  const doParse = argv.includes('--parse');
  const names = argv.filter((a) => !a.startsWith('--'));

  if (argv.includes('--list') || (names.length === 0 && !argv.includes('--all'))) {
    console.log('Targets:');
    for (const t of CAPTURE_TARGETS) console.log(`  ${t.name.padEnd(16)} ${t.url}`);
    console.log('\nUsage: npm run capture -- <name...> | --all [--parse] [--force] [--list]');
    return;
  }

  const targets = argv.includes('--all')
    ? CAPTURE_TARGETS
    : names.map((n) => {
        const t = CAPTURE_TARGETS.find((x) => x.name === n);
        if (!t) throw new Error(`unknown target "${n}" (try --list)`);
        return t;
      });

  let failed = 0;
  for (const t of targets) {
    const ok = await capture(t, force);
    if (!ok) failed++;
    else if (doParse) parseFixture(t);
  }
  if (failed) {
    console.error(`\n${failed} target(s) refused — fixtures left untouched.`);
    process.exitCode = 1;
  }
}

main(process.argv.slice(2)).catch((e) => {
  console.error(e);
  process.exit(1);
});

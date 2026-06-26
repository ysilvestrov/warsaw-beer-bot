import { normalizeBrewery } from '../src/domain/normalize';

// Build a paste-ready ALIAS_PAIRS literal from two raw brewery labels.
export function formatAliasPair(shopLabel: string, untappdLabel: string): string {
  const a = normalizeBrewery(shopLabel);
  const b = normalizeBrewery(untappdLabel);
  return `['${a}', '${b}'],`;
}

// CLI: npx tsx scripts/brewery-alias-key.ts "<shop label>" "<untappd label>"
function main(argv: string[]): void {
  const [shop, untappd] = argv;
  if (!shop || !untappd) {
    console.error('Usage: npx tsx scripts/brewery-alias-key.ts "<shop label>" "<untappd label>"');
    process.exitCode = 1;
    return;
  }
  console.log(formatAliasPair(shop, untappd));
}

// Run only when invoked directly, not when imported by the test.
if (require.main === module) {
  main(process.argv.slice(2));
}

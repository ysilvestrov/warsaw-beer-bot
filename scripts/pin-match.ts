import { loadEnv } from '../src/config/env';
import { openDb } from '../src/storage/db';
import { pinMatch, unpinByRef, unpinByBeer, listPins } from '../src/domain/pin-match';
import { loadOperatorEnv } from './operator-env';

loadOperatorEnv();

// Accepts a full Untappd beer URL (…/b/<slug>/<bid>) or a bare numeric id.
export function parseBid(input: string): number | null {
  const m = input.match(/(\d+)\/?$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isInteger(n) ? n : null;
}

function argVal(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

function main(argv: string[]): void {
  const db = openDb(loadEnv().DATABASE_PATH);
  try {
    if (argv.includes('--list')) {
      for (const p of listPins(db)) {
        console.log(`${p.ontap_ref}  →  #${p.beer_id} ${p.brewery} / ${p.name}  (untappd ${p.untappd_id})`);
      }
      return;
    }

    if (argv.includes('--unpin')) {
      const ref = argVal(argv, '--ref');
      const beer = argVal(argv, '--beer');
      if (ref) {
        console.log(`Unpinned ${unpinByRef(db, ref)} link(s) for ref "${ref}".`);
      } else if (beer) {
        console.log(`Unpinned ${unpinByBeer(db, parseInt(beer, 10))} link(s) for beer ${beer}.`);
      } else {
        console.error('--unpin requires --ref <ontap_ref> or --beer <id>');
        process.exitCode = 1;
      }
      return;
    }

    const beer = argVal(argv, '--beer');
    const untappd = argVal(argv, '--untappd');
    if (!beer || !untappd) {
      console.error('Usage: pin-match --beer <id> --untappd <url|bid> | --unpin (--ref <r> | --beer <id>) | --list');
      process.exitCode = 1;
      return;
    }
    const bid = parseBid(untappd);
    if (bid == null) {
      console.error(`Could not parse an Untappd bid from "${untappd}"`);
      process.exitCode = 1;
      return;
    }
    const res = pinMatch(db, parseInt(beer, 10), bid, new Date().toISOString());
    console.log(JSON.stringify(res));
  } finally {
    db.close();
  }
}

if (require.main === module) {
  main(process.argv.slice(2));
}

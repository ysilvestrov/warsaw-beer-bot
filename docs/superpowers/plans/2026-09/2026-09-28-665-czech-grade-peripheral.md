# #665 Czech grade identity — peripheral implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Work sequentially in the existing issue-665 worktree, without subagents. Steps use checkbox syntax.

**Goal:** Deliver the approved Czech grade rule to production callers and persistent row choices, add the verified brewery alias, and verify safe recovery.

**Architecture:** Pass existing raw names/styles into the implemented comparator. Preserve role direction and accepted tiers. Use existing matching and merge functions on one consistent database copy for replay/recovery.

**Tech Stack:** Existing TypeScript, Vitest, better-sqlite3, fast-fuzzy and search clients.

**Spec:** docs/superpowers/specs/2026-09/2026-09-28-665-czech-grade-identity-design.md plus approved 2026-09-28-665-core-review-amendment.md.

## Global constraints and prerequisite

Core head46f62a8 implements U1/U2/S1. The independently verified P2 is resolved locally under the approved amendment:3700 tests passed,1 skipped, typecheck passed. The amended head has not received a fresh independent review; final whole-branch review remains required.

- No new dependencies, migration, global brewery-noise rule or new matching stage.
- Preserve context-free identity, parser shape, tiers, public responses, authoritative bids/pins, ABV tolerance0.3, original brewery pools and fallback budgets.
- Alias is exactly one finite pair: konrad / vratislavice nad nisou, independently confirmed by the original live probe and candidates_summary.
- No extension changes, changelog or install-guide entry.
- Each code unit ends with named red/green receipts, full npm test && npm run typecheck, local review and named-path commit.
- No push, PR, deployment, issue close or production mutation in this plan. Present the complete verified fix before asking about PR.
- Prior Anthropic permission covered one review transfer. It is not permission for a fresh final-head transfer.
- Adjudication retains its existing style-less input contract: no input style is fabricated; candidate style still reaches lookupBeer. Do not expand verdict-file schema or attach rows to665 in this fix. Re-check issue ownership before closing.

## P1 — contextual persistent identity

**Files:** src/domain/digit-identity.ts, src/storage/beers.ts, src/api/routes/enrich.ts, src/jobs/dedupe-brewery-aliases.ts and their existing tests.
**Consumes:** DigitIdentityContext, digitIdentity.
**Produces:** backwards-compatible optional peer context and contextual row choices.

- [ ] Add these peer/storage regressions before implementation:

~~~ts
expect(digitsCompatibleAsPeers('Konrad 10°', 'Konrad 12°', {
  input: { name: 'Konrad 10°' },
  candidate: { name: 'Konrad 12°', style: 'Svetlý Ležák' },
})).toBe(false);
expect(digitsCompatibleAsPeers('Konrad 12°', 'Konrad 10°', {
  input: { name: 'Konrad 12°', style: 'Svetlý Ležák' },
  candidate: { name: 'Konrad 10°' },
})).toBe(false);
expect(digitsCompatibleAsPeers('Konrad 10°', 'Konrad 12°')).toBe(true);
~~~

Storage test in existing fresh() database:

~~~ts
const db = fresh();
const twelve = ensureOrphan(db, {
  brewery: 'KONRAD Brewery', name: 'Konrad 12°', style: 'Svetlý Ležák',
  normalized_brewery: 'konrad', normalized_name: 'konrad',
});
const ten = ensureOrphan(db, {
  brewery: 'KONRAD Brewery', name: 'Konrad 10°',
  normalized_brewery: 'konrad', normalized_name: 'konrad',
});
expect(db.prepare('SELECT name, untappd_id FROM beers ORDER BY id').all()).toEqual([
  { name: 'Konrad 12°', untappd_id: null },
  { name: 'Konrad 10°', untappd_id: null },
]);
expect(upsertBeerByBid(db, {
  untappd_id: 227734, untappd_id_source: 'checkin',
  brewery: 'KONRAD Brewery', name: 'Konrad 10°',
  normalized_brewery: 'konrad', normalized_name: 'konrad',
})).toBe(ten);
expect(db.prepare('SELECT untappd_id FROM beers WHERE id = ?').get(twelve))
  .toEqual({ untappd_id: null });
~~~

Close each fresh database. Add a SEPARATE resolution regression with only twelve present before upsert ten: otherwise two-peer ambiguity can hide missing comparator context. Assert twelve remains unlinked and the linked row's raw name is Konrad10°. Equal12° must resolve twelve; existing authoritative bid must remain authoritative. Include input-only style and neither-style controls.

API test uses setup()/post(), one twelve orphan with known Czech style:

~~~ts
const { db, app } = setup();
const twelve = seedBeer(db, {
  brewery: 'KONRAD Brewery', name: 'Konrad 12°', style: 'Svetlý Ležák',
  normalized_brewery: 'konrad', normalized_name: 'konrad',
});
const res = await post(app, '/enrich/candidates', {
  beers: [{ brewery: 'KONRAD Brewery', name: 'Konrad 10°' }],
});
expect(res.status).toBe(200);
expect((await res.json()).candidates[0].eligible).toBe(true);
expect(db.prepare('SELECT name, untappd_id FROM beers ORDER BY id').all()).toEqual([
  { name: 'Konrad 12°', untappd_id: null },
  { name: 'Konrad 10°', untappd_id: null },
]);
~~~

Also post /enrich/result with brewery/name above and:
~~~ts
algolia: { hits: [{
  bid: 227734, beer_name: 'Konrad 10°', brewery_name: 'KONRAD Brewery',
  type_name: 'Czech Lager', beer_abv: 4, rating_score: 3.5,
}], nbHits: 1 }
~~~
Assert response status matched and untappd_id227734; the original twelve row remains untappd_id:null. Use raw inserts for multiple same-pair rows: seedBeer can overwrite one. Retain alias-memory and pin tests.

Dedupe regression: directly insert canonical Konrad10°/bid227734/CzechLager, brewery Konrad / Konrad Brewery, and orphan Konrad12°/null style, brewery KONRAD Brewery. Both normalized_name are konrad. Assert:
~~~ts
expect(dedupeBreweryAliases(db, silentLog)).toEqual({ pairsMerged: 0, beersDeleted: 0 });
expect(db.prepare('SELECT name, untappd_id FROM beers ORDER BY id').all()).toEqual([
  { name: 'Konrad 10°', untappd_id: 227734 },
  { name: 'Konrad 12°', untappd_id: null },
]);
~~~
Equal12° positive control must merge one/delete one. Preserve existing check-in/link redirection tests.

- [ ] Capture assertion failures. Implement optional peer context with reversed roles:
~~~ts
export function digitsCompatibleAsPeers(a: string, b: string, context?: DigitIdentityContext): boolean {
  const digitsA = readNameDigits(a);
  const digitsB = readNameDigits(b);
  const reverse = context ? { input: context.candidate, candidate: context.input } : undefined;
  return digitIdentity(digitsA, digitsB, context) !== 'different'
    && digitIdentity(digitsB, digitsA, reverse) !== 'different';
}
~~~
Add b.style to both resolvableOrphan/ensureOrphan SELECTs and style:string|null to their row casts. Resolution:
~~~ts
const identity = digitIdentity(readNameDigits(o.name), bidDigits, {
  input: { name: o.name, style: o.style },
  candidate: { name: b.name, style: b.style },
});
~~~
Peer reuse:
~~~ts
if (!digitsCompatibleAsPeers(o.name, b.name, {
  input: { name: o.name, style: o.style },
  candidate: { name: b.name, style: b.style },
})) return false;
~~~
Keep existing normalized-empty/ABV gates. API pickRowByDigits accepts optional third cardStyle:string|null; ensureBeerRow passes facts.style:
~~~ts
const judged = rows.map((row) => ({
  row, identity: digitIdentity(card, readNameDigits(row.name), {
    input: { name: cardName, style: cardStyle },
    candidate: { name: row.name, style: row.style },
  }),
}));
~~~
Do not move this ahead of findAliasTarget or authoritative bid paths.

Dedupe PairCandidate gains canonical_style/orphan_style:string|null, selected from a.style/b.style:
~~~ts
const identity = digitIdentity(readNameDigits(c.orphan_name), readNameDigits(c.canonical_name), {
  input: { name: c.orphan_name, style: c.orphan_style },
  candidate: { name: c.canonical_name, style: c.canonical_style },
});
~~~
Keep same/year-fallback as its only merge tiers.

- [ ] Focused green, omission mutations of peer/resolution/API contexts, full gate, review, commit.

## P2 — production matching and search propagation

**Files:** src/domain/untappd-lookup.ts, src/domain/web-fallback.ts, src/jobs/untappd-enrich.ts, src/api/routes/enrich.ts, src/index.ts, src/jobs/refresh-ontap.ts, src/jobs/cleanup-polluted-ontap.ts and their existing tests.
**Consumes:** implemented optional core context.
**Produces:** optional LookupArgs/GateInput style and style-bearing production catalog loaders.

- [ ] Add input-only lookup regression:
~~~ts
const bad = {
  bid: 158057, beer_name: 'Konrad 12°', brewery_name: 'KONRAD Brewery',
  style: null, abv: 5.2, global_rating: 3.5,
};
const out = await lookupBeer({
  brewery: 'KONRAD Brewery', name: 'Konrad 10°', style: 'Czech Lager',
  search: fakeSearch(() => [bad]),
});
expect(out.kind).toBe('not_found');
~~~
Add candidate-only style, equal-grade and ale controls. Extend existing retry fixtures: return the conflicting candidate only for the shortened query and assert not_found. Original raw-name ale markers must survive retries as well as original digits.

Web regression:
~~~ts
const input = { brewery: 'KONRAD Brewery', name: 'Konrad 10°', abv: null, style: 'Czech Lager' };
const candidate = { bid: 158057, brewery_name: 'KONRAD Brewery', beer_name: 'Konrad 12°', abv: null };
expect(evaluateCandidate(input, candidate)).toBe('reject:digits');
expect(gateWebCandidate(input, candidate)).toBe(false);
expect(gateWebCandidate({ ...input, name: 'Konrad 12°' }, candidate)).toBe(true);
~~~
Run the same conflicting candidate through runWebFallback's existing real DB/noHydrate/resolver fixture, expecting null. Do not invent candidate style from Brave.

Cron integration: create a Konrad10°/CzechLager orphan, enrichOneOrphan with search returning bad above, and assert original row's untappd_id remains null. This catches loss of input style at the entry point.

Refresh integration uses existing panel()/HTTP stub:
~~~ts
const index = '<div onclick="location.assign(\'https://mixed.ontap.pl/\')"><div class="panel-body">Mixed Pub 1 taps</div></div>';
const pub = '<html><head><meta property="og:title" content="Mixed Pub / ontap.pl"></head><body>'
  + panel(1, 'KONRAD Brewery', 'KONRAD 10°', 'Czech Lager') + '</body></html>';
~~~
Seed core ten and twelve rows, stub only warszawa index and mixed pub URLs, invoke refreshOntap with lookupEnabled:false, then:
~~~ts
expect(getMatch(db, 'KONRAD Brewery', 'KONRAD 10°')?.untappd_beer_id).toBe(tenId);
~~~
Repeat with null candidate styles to prove tap-style delivery independently. Keep remembered-merge/pin tests.

Cleanup integration: clean Konrad12°/SvetlýLežák row plus polluted KONRAD Brewery Konrad10°·4% source, no correct ten. Source normalized_name must be polluted, so a rewrite actually runs:
~~~ts
expect(await cleanupPollutedOntap(db, silentLog)).toEqual({ rewritten: 1, merged: 0 });
expect(getRow(db, pollutedId)?.name).toBe('Konrad 10°');
expect(getRow(db, pollutedId)?.untappd_id).toBeNull();
~~~
Repeat input-only style. Source must not be deleted into twelve.

- [ ] Capture red. LookupArgs gains style?:string|null. lookupBeer gains optional fifth originalName?:string after existing originalDigits. Context:
~~~ts
const identityName = originalName ?? name;
const inputContext = { name: identityName, style: args.style };
~~~
Candidate judgment:
~~~ts
result, identity: digitIdentity(inputDigits, readNameDigits(result.beer_name), {
  input: inputContext,
  candidate: { name: result.beer_name, style: result.style },
}),
~~~
Both recursive calls pass inputDigits AND identityName in fourth/fifth positions. Keep seenCandidates intact as not_found evidence and preserve existing stages.

Forward beer.style in enrichOneOrphan and row.style in the API lookup call. Extend GateInput/runWebFallback input with optional style; evaluateCandidate context:
~~~ts
{ input: { name: input.name, style: input.style }, candidate: { name: cand.beer_name } }
~~~
src/index.ts forwards already loaded beer.style. No extra fetch.

Refresh listBeerCatalog adds b.style and style:string|null in return/cast, and matchPrepared receives style:t.style. Cleanup cleanPool selects b.style and matchPrepared receives style:p.style. Verify prepared orphan additions already retain style without a new code path.

- [ ] Focused green, input/candidate/retry omission mutations, full gate, review and commit.

## P3 — alias and spec.md

**Files:** src/domain/brewery-aliases.ts, spec.md, existing alias/matcher tests.
**Produces:** the single confirmed pair and accurate specification.

- [ ] Add red:
~~~ts
expect(aliasNeighbors('konrad')).toEqual(['vratislavice nad nisou']);
expect(aliasNeighbors('vratislavice nad nisou')).toEqual(['konrad']);
~~~
Add real matcher fixture with ten45 and canonical31849/ Konrad12° / PivovarVratislavice nad Nisou / CzechPils5.2, no duplicate37334:
~~~ts
const canonicalTwelve = c({
  id: 31849, brewery: 'Pivovar Vratislavice nad Nisou', name: 'Konrad 12°',
  style: 'Pilsner - Czech / Bohemian', abv: 5.2,
});
expect(matchBeer({ brewery: 'KONRAD Brewery', name: 'Konrad 12°' }, [ten, canonicalTwelve]))
  .toEqual({ id: 31849, confidence: 1, source: 'exact' });
expect(matchBeer({ brewery: 'KONRAD Brewery', name: 'Konrad 10°' }, [ten, canonicalTwelve]))
  .toEqual({ id: 45, confidence: 1, source: 'fuzzy' });
~~~
Preserve pre-recovery orphan selection and non-transitivity tests; no canonical priority rule.
- [ ] Add ['konrad', 'vratislavice nad nisou'] to ALIAS_PAIRS with issue/evidence comment.
- [ ] Amend spec.md identity section and Plato note with these approved facts: unique explicit integer7–20 on both sides, Czech lager style on either side, no raw-name/style ale markers; equal decimal/duplicate grades equivalent; fractional/missing/ambiguous grades keep old rules; context-free behavior unchanged. Candidate exclusion precedes both exact routes and fuzzy selection; after relevant veto fuzzy requires positive unique matching grade/soft evidence. Preserve other digit rejection order and original brewery bucket/budget. Document peer versus persistent same/year-fallback tiers, stored-style provenance and unchanged authoritative bids/pins. Do not claim missing grade is a contradiction.
- [ ] Focused green, full gate, review and commit.

## P4 — replay, recovery rehearsal, review

**Artifacts:** /tmp snapshots/base export/probes; durable docs/superpowers/plans/2026-09/2026-09-28-665-replay-recovery.md.
**Consumes:** complete P1–P3.
**Produces:** judged selection changes and row-by-row recovery evidence, not a production migration.

- [ ] Take one consistent SQLite backup using better-sqlite3 backup from readonly:true/fileMustExist:true. Do not copy the live db without its WAL. Export base4964f00 with git archive to /tmp/issue-665-base and link its node_modules to existing dependencies. Import the OLD matcher from the base export, so CURRENT aliases cannot contaminate baseline.

Use the same loadCatalog(snapshotDb) rows for both prepared matchers. Replay all latest taps with:
~~~sql
SELECT t.*, ml.untappd_beer_id, ml.reviewed_by_user, ml.merged_at
FROM taps t LEFT JOIN match_links ml
  ON ml.ontap_ref = t.beer_ref
 AND ml.brewery_ref = coalesce(t.brewery_ref, '')
WHERE t.snapshot_id IN (SELECT MAX(id) FROM tap_snapshots GROUP BY pub_id)
ORDER BY t.snapshot_id, t.id;
~~~
For each tap call resolveTapIdentity, skip non-keep results like ingest, and pass identical brewery/name/abv/style to old/new matchPrepared. Record every differing id/source/confidence and saved pin/merge state. Ingest currently calls without explicit fallback budget; use the same for this replay. Label a separate bounded-batch /match replay using identical limits/scopes on both sides. Use the actual request schema for input metadata; do not supply stored tap.style if the wire request does not carry it.

- [ ] Judge every changed id individually. Inventory all five Konrad/Vratislavice rows and alias-opened changes separately. Keep the constructed shorter-sibling and permitted non-Czech controls. Unknown changes block shipping; counts are not correctness evidence.
- [ ] Create a SECOND writable copy for recovery. Inventory all incoming rows:
~~~sql
SELECT * FROM match_links WHERE untappd_beer_id = 37334 ORDER BY brewery_ref, ontap_ref;
SELECT * FROM checkins WHERE beer_id = 37334;
SELECT * FROM beer_aliases WHERE beer_id = 37334;
SELECT * FROM enrich_failures WHERE beer_id = 37334 OR issue_number = 665;
~~~
Judge every row. Preserve human pins and unresolved check-ins for human decision. Before merge, rematch each confirmed automatic TEN link individually on the COPY:
~~~ts
upsertMatch(copyDb, breweryRef, ontapRef, 45, 1);
~~~
Only after all incoming identities are resolved/separated and orphan twelve is confirmed bid158057:
~~~ts
mergeIntoCanonical(copyDb, 37334, 31849, rehearsalAt);
~~~
Read back every affected link/check-in/alias. Tens must remain45 and not acquire a remembered twelve merge; confirmed twelves must point31849. Unknown check-ins cannot be silently repointed by the merge. Record exact preconditions and copied-db results. Do not execute mutation calls against production.

- [ ] Freshly query issue665 ownership. If it has rows at close time, run existing two-step adjudicate probe/apply with canaries and individual judgments. No blanket remap or review_class change.
- [ ] Whole-branch review includes inline U1/U2/S1/P1/P2/P3, approved specs, mutation receipts and recovery evidence. Fix valid findings, rerun affected tests/full gate after code changes. Old peer receipt is not fresh amended-head corroboration.
- [ ] Final full gate and clean tree; present complete fix for PR approval. After confirmation fetch main, rebase if moved, repeat full gate after rebase, push/open PR and wait for review/checks.

## Coverage

P1 covers peer orphan reuse, bid resolution, API persistent choice and dedupe. P2 covers lookup/web/retry/cron/API context and both production catalog loaders. P3 covers the exact verified alias and spec. P4 covers every selection change, copied-db recovery, issue ownership and final review.

Core contextual identity and post-veto evidence are already implemented. Authoritative IDs, pins, old non-Czech behavior, budgets and cache memoization remain cross-unit regression requirements.

No peripheral production file was modified while writing this plan.


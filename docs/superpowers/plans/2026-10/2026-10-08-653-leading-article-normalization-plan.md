# #653 Leading Article Normalization Implementation Plan

**Goal:** Normalize leading grammatical article `The` in beer names when the remaining name retains $\ge 2$ tokens, rescuing orphan row 37244 (*The Stonewall Inn IPA*) and reconciling article divergence across shop and Untappd variants.

**Architecture:** Implement leading `the` stripping in `stripBreweryFromName()` in `src/domain/style-identity.ts` after brewery brand stripping (or on the name if no brewery is matched), when remainder has $\ge 2$ tokens (`nt.length >= 3 && nt[0] === 'the'`). Keep `normalizeName()` in `src/domain/normalize.ts` unchanged to preserve `beers.normalized_name` DB keys and protect breweries starting with `The` (*The Bruery*). Document behavior in `spec.md` under §3.1 and verify adjudication on row 37244.

**Tech Stack:** TypeScript, Node.js, Vitest, SQLite.

**Spec:** `docs/superpowers/specs/2026-10/2026-10-08-653-leading-article-normalization-design.md`

## Global Constraints

- Never drop `the` from 2-token names (`The Alchemist`, `The End`) — they must retain both tokens to avoid collapsing into weak single-token keys.
- Never drop `the` when it would leave an empty string (e.g. style-only tail `The IPA`).
- Never drop `the` occurring in the middle of a title (`Eye of the Tiger`, `Son Of The Son`).
- Do not modify `ABV_TOLERANCE` (0.3%).
- Adjudicate row 37244 via live Algolia probe before marking issue resolved.

---

### Task 1: Leading Article Normalization in `stripBreweryFromName`

**Files:**
- Modify: `src/domain/style-identity.ts`
- Test: `src/domain/matcher.test.ts`

- [x] **Step 1: Write unit tests in `src/domain/matcher.test.ts`**
  Cover leading article stripping when remainder $\ge 2$ tokens, preservation when $< 2$ tokens, mid-phrase preservation, and breweries starting with "The".
- [x] **Step 2: Implement leading `the` stripping in `stripBreweryFromName` in `src/domain/style-identity.ts`**
- [x] **Step 3: Run Vitest to verify tests pass**
- [x] **Step 4: Commit changes**

---

### Task 2: Lookup Integration Tests, Spec Update, and Adjudication

**Files:**
- Modify: `src/domain/untappd-lookup.test.ts`
- Modify: `spec.md`
- Run: `DATABASE_PATH=/var/lib/warsaw-beer-bot/bot.db DOTENV_CONFIG_PATH=/home/ysi/warsaw-agy-bb/.env npm run adjudicate -- --issue 653`

- [x] **Step 1: Write integration tests in `src/domain/untappd-lookup.test.ts`**
  Cover realistic Stonewall candidates with rating counts, ABV tiebreaks (4.6% vs 4.0% vs null), short name disambiguation (`The End` vs `End`), and "The" brewery protection (*The Bruery*).
- [x] **Step 2: Update `spec.md` under §3.1**
- [x] **Step 3: Run full gate in worktree (`npm test && npm run typecheck`)**
- [x] **Step 4: Live adjudication probe of issue #653**
  Confirmed: row 37244 marked `rescued` with bid `6992173` @ 4.6% ABV (verdict file: `/tmp/adjudicate-653-1791490720357.json`).
- [x] **Step 5: Commit changes**

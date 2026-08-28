# #527 — the guard must judge a path by whether it ships, not by its name

## The model

Production is a function of the tree rsync copies into `/opt`. A path the filter
excludes cannot change production, whatever it contains and whoever wrote it.

That makes "may an unattended deploy carry this diff?" two independent
questions, not one:

1. **Which changed paths can affect production at all?** `deploy/rsync-filter`
   answers this, and it is the only thing that can — it is what rsync executes.
2. **Which of those may an unattended deploy change?** The manifest allowlist
   answers this: a dependency bump, nothing else.

`deploy/autodeploy-guard.sh` collapses both into one list and holds only the
second. So it answers a blast-radius question with a list that was never about
blast radius, and every path outside the two manifests — an extension file, a
doc, `spec.md` — reads as if it could restart the bot.

## The structural cause: two lists, and they were never the same list

What ships (`deploy/rsync-filter`, established by #473):

```
+ /package.json
+ /package-lock.json
+ /tsconfig.json
+ /src/***
+ /scripts/***
+ /deploy/***
- *
```

What the guard permits (`deploy/autodeploy-guard.sh`):

```
package.json|package-lock.json
```

The guard's own comment states the reason for the narrower list —

> The allowlist. NOT `extension/**` — the extension never ships to the server.

— and that reason argues for the opposite behaviour. "This must not be
deployed" and "the diff must not contain this" are different statements. They
were written as one, and the second one turns a merge that cannot touch
production into a block on every security patch.

`report_drift_once` in `deploy/autodeploy.sh` hardcodes the same two names a
second time, for a different decision (⚠️ BLOCKED vs ℹ️ still-works), so the
defect is present twice over.

## Evidence — measured 2026-08-28

`feb0ed5` (popup restyle, extension-only) merged at 18:21 UTC on top of the
deployed `d48413c`. The guard is a pure function of four arguments, so the state
replays exactly:

```
$ wbb-autodeploy-guard $REPO d48413c feb0ed5 origin/main
REFUSE: 7 path(s) outside the allowlist:
  .gitignore
  .impeccable/critique/2026-08-28T17-11-20Z__extension-src-popup-popup-html.md
  docs/extension-install-en.md
  docs/extension-install-uk.md
  extension/src/popup/popup.css
  extension/src/popup/popup.html
  spec.md
exit=1
```

Seven paths. **Zero** of them pass `deploy/rsync-filter`. Any dependabot tag
arriving in that window would have been refused for a change that cannot reach
the server. At 18:38:50 UTC the drift check sent the operator the ⚠️ BLOCKED
message, which was accurate about the mechanism and useless as advice: the
prescribed remedy, `./deploy/deploy.sh`, would have restarted the bot to ship a
byte-identical payload.

Unblocked by hand with `deploy/record-deployed.sh feb0ed5`. That was truthful
rather than a workaround — the tree that would ship from `feb0ed5` is identical
to what is already in `/opt` — but it is a manual step that should not exist.

## Change 1 — `deploy/ships.sh`: one predicate, derived from the filter

A new script, installed as `/usr/local/bin/wbb-ships`, following the established
`read-env.sh` → `wbb-read-env` pattern: an installed copy, reached through an
env-overridable path (`WBB_SHIPS`), because a flat `/usr/local/bin` copy cannot
find its sibling through its own `$0`.

**Interface (I1).** `ships.sh <filter-file>`; paths on stdin, one per line;
stdout is `SHIP <path>` or `SKIP <path>`, one line per input line, in order.
Exit 0 when the filter parsed; exit 1 when it did not, with the reason on
stderr and **nothing on stdout**. One process per diff, not per path.

(Line-based, matching every existing consumer. A path containing a newline is
already unrepresentable everywhere in this pipeline; that is not made worse
here and is not fixed here.)

The filter arrives as a **file**, while its source is a git ref (below) whose
content comes out of `git show` on stdout — and stdin is already carrying the
paths. So each caller materialises it first and cleans up after itself:

```
filter=$(mktemp); trap 'rm -f "$filter"' EXIT
git -C "$repo" show "<ref>:deploy/rsync-filter" > "$filter" || <fail closed>
```

A file argument rather than a second stream keeps the script testable with a
fixture on disk and keeps the two consumers identical.

**Grammar.** Four forms and nothing else:

| Form | Meaning |
|---|---|
| blank, or first non-space is `#` | ignored |
| `+ /NAME` (no `/`, no `*?[`) | exact root file |
| `+ /DIR/***` | that directory and everything under it |
| `- *` | the terminal catch-all — the LAST rule that is neither blank nor a comment |

Anything else — a glob in a name, a `-` rule that is not the terminal one, an
unknown prefix — is an error, not a guess. We are re-deriving rsync's semantics
in a second engine; the honest way to hold that is to implement a small subset
exactly and refuse the rest loudly.

**The catch-all is checked, not assumed.** The predicate concludes "not matched
⇒ does not ship", and that conclusion is only sound because the last rule is
`- *`. If someone deletes it, rsync's default flips to "everything ships" while
our predicate keeps saying the opposite. So the parser requires a terminal
`- *` and errors without one. This is the single most dangerous way the filter
could change, and it is the one an eye would skip.

**Anchoring is the failure to fear.** `+ /src/***` is anchored at the transfer
root: `vendor/src/x.ts` does **not** ship. A parser that matches a bare `src/`
prefix would silently widen the violation set. This is why the equivalence test
below exists.

## Change 2 — the guard: violation = ships ∧ not a manifest

```
violation(path) = ships(path) && path ∉ {package.json, package-lock.json}
```

Two layers, and the pair is why this is not a loosening. The shipped set says
whether a path can change production **at all**; the manifest allowlist says
what an unattended deploy may change **among the paths that can**. Everything
that ships today — `tsconfig.json`, `src/**`, `scripts/**`, `deploy/**` —
refuses exactly as it refuses now.

**Where the filter comes from: BOTH commits — the deployed one and the target**,
read as `git show <deployed>:deploy/rsync-filter` and
`git show <target>:deploy/rsync-filter`, never from the clone's working tree.
A path ships if **either** filter ships it; the guard's SHIP set is the union.

Missing file at either ref, or an unparseable filter at either ref: REFUSE.

### Why the union — and the argument this replaces (REFUTED)

This section originally said the opposite, and the refutation is worth keeping
visible. What it said:

> **Where the filter comes from: the target commit.** A wrong ACCEPT would
> require a path that ships under *target's* filter to be classified as
> non-shipping. Reading target's filter makes that impossible by definition, in
> one step. Reading the deployed commit's filter is also safe today, but only
> through a two-step argument — "a widened filter is itself a change to
> `deploy/rsync-filter`, and `deploy/***` ships, therefore violation" — which
> holds only while `deploy/***` remains in the filter. The one-step guarantee
> survives the day that stops being true.

**That argument considered only a WIDENED filter.** It equates "affects
production" with "ships under the new filter", and that equation is false,
because `deploy/deploy.sh:16` runs

```
sudo rsync -a --delete --delete-excluded --filter='merge deploy/rsync-filter' ...
```

A path can change production by **leaving** the filter, not only by entering it:
one that stops shipping is DELETED from `/opt`. So a commit that NARROWS the
filter cloaks itself and everything it drops. In the limit — rewriting
`deploy/rsync-filter` to just `- *` — every changed path, the filter file
included, classifies `SKIP` against the target; violations come back empty; the
guard ACCEPTs; and the deploy that follows empties `/opt/warsaw-beer-bot`
unattended, then reports the bot unhealthy and rolls back to a baseline that is
no longer on disk. Reproduced live against the real guard and the real
`ships.sh` in the final whole-branch review. The old two-name allowlist refused
this by name (`deploy/rsync-filter` is not `package.json`), so the one-sided
read was a *regression* — a wrong ACCEPT on the unattended path, the failure
class the severity ordering weights above everything else.

The narrower cases were already safe, which is why this was easy to miss:
dropping only `+ /src/***` while keeping `+ /deploy/***` still makes
`deploy/rsync-filter` itself a SHIP, hence a violation, hence a REFUSE. The hole
is specifically a change that removes the rule covering the filter's own
directory.

**The rule, restated.** `rsync --delete` makes the DEPLOYED filter's set
material — it is the set that can be deleted — and the target's filter's set is
what can be written. Production is affected by the union, so:

```
ships(path) = ships_under(deployed_filter, path) || ships_under(target_filter, path)
```

The original argument's real content survives inside this: reading the target is
still what covers a widened filter, in one step, without relying on `deploy/***`
staying in the filter forever. The union adds the half it was missing. Both
`git show`es fail closed, and the classifier must answer for every path it was
handed — a short or empty answer is REFUSE, not "nothing ships".

For the 2026-08-28 replay the two filters are byte-identical, so the union is
the same set and P1 is unchanged.

**The ACCEPT message changes.** `ACCEPT: lockfile-only change` becomes false —
the diff may now legitimately carry unrelated paths. It reports how many
non-shipping paths were waved through and names them. This goes to the journal,
not to Telegram, so the 3500-char notify cap does not apply.

## Change 3 — drift is drift only if something ships

Fixing the guard alone would close the tag refusal and open a worse hole. With
the guard fixed, an extension-only merge stops blocking tags, but production
stays behind `main` **forever** — there is nothing to deploy, so the baseline
never advances — and `report_drift_once` keeps finding a difference. The result
is a daily ℹ️ whose text ("only the manifest and lockfile differ") is a lie
about `popup.css`. A standing daily siren about a condition nobody can clear is
the exact failure mode #490 already had to remove once.

So drift is redefined by the same predicate:

Same rule for the filter's origin as the guard's — the union of both sides,
`git show DEPLOYED_SHA:deploy/rsync-filter` and
`git show origin/main:deploy/rsync-filter`. (Originally written as the newer
side alone; corrected with Change 2 above. Here a narrowed filter buys silence
rather than a deploy, so it is strictly less severe — but the same rule
applies, and "cannot assess" is its own state either way.)

```
shipping = { p ∈ diff(DEPLOYED_SHA, origin/main) : ships(p) }

shipping = ∅                      → no drift; close an open episode, silently
shipping ⊄ {manifests}            → ⚠️ BLOCKED
otherwise                         → ℹ️ manifest-only
```

The empty branch **absorbs the existing `DEPLOYED_SHA = main_sha` test** —
equality becomes one case of "nothing ships", and a condition disappears rather
than being added.

Message wording moves with the rule: "N path(s) outside the allowlist" becomes
"N path(s) that ship to the server differ", because "allowlist" no longer names
the thing being counted. The commit count stays as it is — production genuinely
is N commits behind — and is now reported alongside a path count that means
something different from it.

Under this rule the 2026-08-28 episode never opens: `feb0ed5` ships nothing, so
there is no drift, no message, and no manual `record-deployed.sh`.

## Change 4 — the new silence must be earned, not assumed

The empty-shipping branch is **quieter than #499**. If classification fails —
`wbb-ships` missing, filter unparseable, `git show` failing — "nothing ships"
and "everything is fine" produce the identical outcome: total silence. That is
strictly worse than the reassuring message #499 is about.

So a classification failure is its own state, reported as "cannot assess", never
folded into the quiet branch. The guard's C1 note already documents this failure
shape for itself; drift never learned it.

We are replacing the exact `{ n=0; while read -r f; ... }` group that is #499's
body. If the replacement closes #499 as a by-product, verify it with a test and
close it citing the evidence — but **do not widen scope to chase it**. #499's
full claim covers an unresolvable baseline SHA, which is a different input, and
it stays its own issue.

## Testing

**Predicate** (`scripts/autodeploy/ships.test.ts`, new). Root manifests,
`tsconfig.json`, `src/**`, `scripts/**`, `deploy/**` ship. `extension/**`,
`docs/**`, `spec.md`, `.gitignore`, `.impeccable/**` do not. Anchoring pinned
explicitly: `vendor/src/x.ts` does not ship; `extension/package-lock.json` does
not ship.

**Equivalence with real rsync.** Materialise a fixture tree, run the real
`rsync` with the same `--filter='merge deploy/rsync-filter'` into a temporary
destination, walk the result, and assert it equals the predicate's SHIP set,
path for path. `scripts/deploy-rsync.test.ts` already has `filesBelow()`,
`temporaryDirectory()` and calls the real `/usr/bin/rsync`, so this reuses
existing machinery and needs no fake `sudo` — rsync is invoked directly. This
converts "we believe we matched the semantics" into a measurement, and it is the
test that catches an anchoring mistake.

Compare **file** sets: rsync transfers directories too, and `git diff
--name-only` never names one.

**Filter syntax, checked in CI.** The repository's real `deploy/rsync-filter`
must parse: exit 0. Negative: a temporary filter carrying `+ /weird[abc]` exits
nonzero, and one with the terminal `- *` removed exits nonzero. An unsupported
line then fails a merge, not a production guard a week later.

**Guard.** The flipped test: an extension-only diff now ACCEPTs where
`guard.test.ts` currently requires REFUSE. The intent of that test — "the
allowlist is string equality, not a glob" — is preserved, relocated into the
predicate's anchoring tests. `src/**` and `tsconfig.json` stay REFUSE. New:
missing or unparseable `wbb-ships` → REFUSE; the ACCEPT message names the
ignored paths.

**Drift.** Nothing ships → **no notification and no episode**: assert
`DRIFT_SINCE` is absent from the state file, not merely that no Telegram was
sent. Manifests only → ℹ️. `src/**` → ⚠️. Classification fails → not silence.

Integration note: `driftRemote()` builds real fixture repositories whose commits
contain only `src/x.ts` — **no `deploy/rsync-filter`**. Under this design
`git show origin/main:deploy/rsync-filter` fails there, so every existing drift
test would go red. The fixtures gain a real filter in their commits, which makes
them exercise the live path; a fixture deliberately left without one becomes the
fail-closed test.

**Install invariant** (source guard). Every repository path named in
`autodeploy.sh`'s `installed_is_stale` pair list must be installed by
`install-autodeploy.sh`. A fifth installed file is a fifth way to be silently
stale, and it has to be added in two places that nothing currently ties
together.

Every test mutation-proven: delete the line, show the red.

## Rollout

1. Merge.
2. `sudo bash deploy/install-autodeploy.sh`.
3. `wbb-installed-current` reports CURRENT.
4. One tick by hand: silence expected.

The window between merge and install is safe by construction — the old
installed copy sees `autodeploy.sh` diverge from `origin/main` and refuses
pending tags as stale, which is correct — but the install cannot be skipped
(the same install-after-merge trap as #435).

## Predictions, recorded before implementation

- **P1 (replayable, exact).** `wbb-autodeploy-guard $REPO d48413c feb0ed5
  origin/main` prints `REFUSE: 7 path(s)` and exits 1 today. After the change
  the same four arguments must print ACCEPT, name 7 ignored non-shipping paths,
  and exit 0. No tag push, no deploy: the guard is a pure function.
- **P2.** A drift run with `DEPLOYED_SHA=d48413c` and `origin/main=feb0ed5`
  sends **no** message and writes **no** `DRIFT_SINCE`. Today it sends ⚠️.
- **P3.** A diff carrying `src/**` still REFUSEs, with the same paths listed.
  This change must move nothing about what may be deployed.

## Decisions taken in the brainstorm

- **Drift is in scope, not a follow-up issue.** Fixing only the guard trades a
  blocked tag for a daily siren; both live on the same predicate.
- **Parse the filter; do not duplicate it behind a source-guard test.**
  Duplication with an alarm is the disease #527 describes, with a bell on it.
  The re-implementation risk is answered by the real-rsync equivalence test,
  and the grammar refuses whatever it does not implement.
- **A test on the filter's own syntax**, so an unsupported rule surfaces at
  merge time rather than in production.
- ~~**Read the filter from the newer side** (target / `origin/main`), for the
  one-step safety argument.~~ **REFUTED** by the final whole-branch review — it
  covers a widened filter and not a narrowed one, and `rsync --delete` makes the
  deployed side material. Superseded by **read BOTH sides and take the union of
  the SHIP sets**; see Change 2.

## Rejected

- **Advance the baseline automatically on a ship-nothing merge.** It removes the
  drift by recording that a commit was deployed when it was not. The baseline's
  value is that it is true; drift should learn to ask a better question instead.
- **Ask real rsync at runtime.** Materialising a tree and shelling out to rsync
  inside the guard makes the deploy path depend on rsync's presence and on
  scratch-directory I/O to answer a question about seven strings. rsync belongs
  in the test, as the oracle, not in the guard.
- **Unify all four copies of the list.** `scripts/autodeploy/manifest-scope.ts`
  answers a different question — is this dependabot PR a pure dependency bump? —
  which is about the shape of a pull request, not about what reaches the server.
  It stays narrow and untouched.

## Deliberately not in scope

- **#499** — the reassuring message when drift cannot assess production at all.
  Adjacent code, broader claim (unresolvable baseline SHA). Our replacement must
  not add a second instance; closing #499 outright is its own cycle.
- **#498** — a deployed tag re-read as pending and refused as a downgrade;
  `LAST_FAILED_SHA=72448d9` still sits in production state. Different mechanism,
  different threat model.

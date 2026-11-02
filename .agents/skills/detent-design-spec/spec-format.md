# Design spec format: owner section, estimate, claim → evidence, spec review

Applies to every new architectural spec, whoever writes it. The light path has no spec, so it has
no format either.

A spec has two readers. The owner approves it from the first section and need not read the body;
the body is for whoever writes the plan. Everything the owner must know to say "yes" or "stop"
stands at the top.

## Language

Write the spec in the `language` from `detent.json`: prose, section and field names, status
values, premise tags. The names in this file are English originals; translate them. Keep literal
only the `Spec-review:` line: the CLI prints it.

For `uk`, use these names:

| English | uk |
|---|---|
| Date / Status | Дата / Статус |
| draft / awaiting approval / approved | чернетка / чекає на затвердження / затверджено |
| For the owner | Для власника |
| Goal | Мета |
| What changes for you | Що зміниться для тебе |
| What the decision rests on | На чому стоїть рішення |
| `[owner requirement]` / `[probe]` / `[inference]` | `[вимога власника]` / `[проба]` / `[виведення]` |
| Key decisions | Ключові рішення |
| Considered the standard: X — rejected because Y | Розглянуто стандартне: X — відкинуто, бо Y |
| What gets worse | Що стане гірше |
| Estimate / Actual | Оцінка / Фактично |
| Questions for the owner | Питання до власника |
| Claim → evidence | Заявка → доказ |
| Spec review | Рев'ю спеки |

## Location

`<specsDir>/<YYYY-MM>/<file>.md`, the month of the spec's date. `detent cross-review --spec`
refuses a spec outside `<specsDir>/<YYYY-MM>/`.

## Header

```
# <topic>

Date: YYYY-MM-DD
Status: draft | awaiting approval | approved YYYY-MM-DD
Spec-review: <reviewer>/<model> @ <sha7> (author: <author>) — <n> findings: <f> fixed, <r> rejected
```

The `Spec-review:` line is printed by `npx -y @ysilvestrov/detent cross-review --spec <file>`;
fill in `<f>` and `<r>`. A failure prints `Spec-review: failed (…)`; copy it as is.

## Owner section

The first section after the header. One screen at most. In the owner's terms: what changes for the
product's users or for the project's resources, not the mechanism. Fields in this order:

| Field | Contents | Rule |
|---|---|---|
| Goal | 1–2 sentences: what changes for the product's users or for the project's resources | No module names |
| What changes for you | What now happens without the owner; what the owner must do differently; what becomes irreversible | Required. "Nothing" only with an explanation |
| What the decision rests on | Premises and invariants, each tagged `[owner requirement]`, `[probe]` (with a reference to the probe in the body) or `[inference]` | An untagged premise is a defect |
| Key decisions | 3–5 decisions that are expensive to undo, each with the rejected alternative; plus "Considered the standard: X — rejected because Y" for each standard alternative considered | A body decision that changes visible behaviour, the operational regime, access rights, or is irreversible must be here |
| What gets worse | Cost, losses, new risks | Required, not empty |
| Estimate | The owner's estimate, the author's estimate, the breakdown, the cheaper option; after merge, "Actual" | See "Estimate" |
| Questions for the owner | At most three; with Superpowers, these include the builder check's questions only the owner can answer | "None" is allowed |

`[inference]` is where the owner should look first: that is where the author could be wrong.

**Amendments.** An amendment that changes a premise, a key decision or the estimate in the owner
section changes the owner section too and returns the status to "awaiting approval". An
amendment that does not touch the owner section does not.

## Body

For whoever writes the plan. It holds the probes that the `[probe]` tags point to: what was run
and the key output lines.

## Claim → evidence

Every place where the system records something as fact (a status row, a cursor, coverage, a
verdict, a cache that is later read as truth) gets a row:

```
| Claim | Where it is recorded | What proves it | Strength |
|---|---|---|---|
```

A row whose evidence is a counter, an assumption about external data, or "it has always been so"
is weak: probe it live before the plan, or do not make the claim at all.

## Estimate

| Size | Meaning |
|---|---|
| XS | no code, or one edit on the light path |
| S | one PR, plan ≤ 4 tasks |
| M | one PR, core + a separate plan for the periphery |
| L | 2–3 PRs, or a step a human performs outside the repo |
| XL | splits into several specs |

1. At the start, retell the task in your own words and ask for the owner's estimate. Do not name
   yours and do not hint at it: it becomes an anchor.
2. Once the approach is chosen and before the spec is written, give your estimate with a
   breakdown (shares of the work by component) and, if one exists, a cheaper option with what it
   loses.
3. A divergence of ≥ 2 sizes is a mandatory stop and analysis: the author missed a trap, is
   overcomplicating, or the owner underestimates. The outcome goes into "Estimate" as a separate
   paragraph.
4. After the last PR of the change is merged, add "Actual: <size>, <n> PRs, <m> tasks in the
   plans". A share of a usage limit only if measured, never estimated.

## Spec review

After the probes and before the owner reads the spec, run the review by a model of another family:
`npx -y @ysilvestrov/detent cross-review --spec <file>`, per the `detent-cross-review` skill
(author flag, background run, failures).

The spec must be committed: the review is bound to the SHA. Once per spec; amendments after
approval do not rerun it.

Handle each finding as a review comment: fix it or reject it with a reason, never apply it
blindly. A reinvention finding (check 5): accepted, it changes the design; rejected, it gives a
"Considered the standard" line in the owner section. A reviewer failure (exit 5) does not block
the spec; tell the owner in your message.

The trace: the `Spec-review:` line in the header and the last section of the spec:

```
## Spec review

| # | Check | Decision | Reason / what changed |
|---|---|---|---|
```

The reviewer's report lives in `tmpDir` and is not committed, so this table is the only trace.

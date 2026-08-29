# #490 — the drift alarm becomes an episode with two ends

Date: 2026-08-23
Status: agreed
Issue: #490
Related: `2026-08-16-435-dependency-security-autofix-design.md` (the deployer this signal belongs to),
`2026-08-19-431-saturation-as-state-design.md` (the same shape: a standing condition is a state, not
a repeated refusal)
Measured from: the #489 merge, 2026-08-23

## The model

> The deployer reports the *existence* of drift, not its *life*. An alarm that can only say
> "something is wrong" — never "it started", never "it is over" — is a siren, and a siren that also
> silences itself for the rest of the day is worse than none.

Drift between production and `main` is not a fault. It is the normal state of the minutes between a
merge and the deploy that follows it. What makes it worth reporting is **duration**, not existence:
a gap that outlives a coffee break means someone merged and walked away. The current code cannot
express duration, because it stores no beginning.

Everything below follows from giving the episode a start, an end, and one message at each.

## Measured 2026-08-23

### 1. The alarm fires 99 seconds after a merge

| time | event |
|---|---|
| 20:41:25 | PR #489 merged → `origin/main` = `a661320` |
| **20:43:04** | autodeploy tick → «⚠️ autodeploy is BLOCKED…» |
| 20:43:13 | `./deploy/deploy.sh` starts |
| ~20:43:30 | deploy done, `DEPLOYED_SHA=a661320` recorded |
| 20:48:47 | next tick — silence |

The timer runs every 5 minutes (journal: 20:21, 20:26, 20:31, 20:37, 20:43, 20:48). The message was
false 26 seconds after it was sent, and nothing said so.

### 2. There is no recovery path in the code

```bash
report_drift_once() {
  ...
  [ "$DEPLOYED_SHA" != "$main_sha" ] || return 0     # drift gone → silent return
  [ "$LAST_DRIFT_NOTICE" != "$today" ] || return 0
```

The third guard is the only handling of "drift cleared": an early return. `grep -rn "in sync\|synced\|
resolved\|caught up" deploy/*.sh` finds nothing. The alarm has one direction.

### 3. The suppressor silences the *next* merge, not the repeat

`LAST_DRIFT_NOTICE` holds a date. Once today's notice is written, the sequence

> merge → BLOCKED → deploy → **merge again the same day**

produces **no message at all**: the alarm will not repeat within the day, and the recovery event it
would be waiting for does not exist. The mechanism that stops the noise stops the signal with it.

### 4. The drift path has no tests

`grep drift scripts/autodeploy/autodeploy.test.ts` → nothing. The rest of `autodeploy.sh` is well
covered by a harness that runs the real script against throwaway git repos with every external
contact stubbed through a `WBB_*` variable. Drift was simply never exercised.

## Design

### The episode

One new state field, `DRIFT_SINCE` — the epoch second at which the current episode began, empty when
there is no episode. `LAST_DRIFT_NOTICE` keeps its name and its date format but changes meaning:
from "we said something today" to "we reminded during *this* episode today". Both are cleared when
the episode closes.

`report_drift_once` becomes five explicit transitions:

| drift? | `DRIFT_SINCE` | action |
|---|---|---|
| no | empty | nothing |
| no | set, never announced (`LAST_DRIFT_NOTICE` empty) | clear both, **say nothing** — nobody was told the episode began |
| no | set, announced | **notify recovery once**, clear `DRIFT_SINCE` and `LAST_DRIFT_NOTICE` |
| yes | empty | record `DRIFT_SINCE=now`; **say nothing** — the grace window opens |
| yes | set, age < `DRIFT_GRACE_S` | nothing |
| yes | set, age ≥ `DRIFT_GRACE_S`, not yet reminded today | notify, set `LAST_DRIFT_NOTICE=today` |

`DRIFT_GRACE_S=900` (15 minutes), declared beside `HEALTH_TIMEOUT_S`.

Consequences worth stating because they are the point:

- A merge followed by a deploy inside 15 minutes produces **no traffic at all** — not a warning, not
  a recovery. This is why the recovery transition is conditioned on the episode having been
  announced: an "all clear" for an alarm that never sounded is pure noise, and it would arrive on
  exactly the happy path we are trying to make quiet. `LAST_DRIFT_NOTICE` being non-empty is the
  record that we spoke, so it is also the test for whether we owe a closing message.
- Further merges while an episode is open stay silent. The gap's *size* is a standing property; it
  belongs in the daily digest, not in the alarm channel. (Deliberately out of scope here — see below.)
- A forgotten merge still resurfaces once a day, which is what `LAST_DRIFT_NOTICE` was always
  supposed to buy and could not, because it also suppressed the first message.

### The state write needs no refactor

`write_state` already carries three of its five positional arguments by default
(`${4:-$LAST_DRIFT_NOTICE}` and friends). `DRIFT_SINCE` joins them the same way, so
**`report_drift_once` assigns the shell variable and lets the default carry it** — none of the other
ten call sites change, and no call site grows a sixth positional argument.

This was reconsidered mid-design: converting `write_state` to read shell variables instead of
positionals was proposed and rejected. It would touch all eleven call sites in the highest-blast-radius
file in the repository, and its failure mode — a call site that silently stops persisting a field —
corrupts the deployer's record of what production is running. The carry-by-default pattern already
solves the stated problem at zero risk to the existing sites.

### The clock seam

Fifteen minutes cannot be tested deterministically against the wall clock. `autodeploy.sh` already
routes every external contact through a `WBB_*` override (`WBB_GUARD`, `WBB_DEPLOY_CMD`,
`WBB_HEALTH_CMD`, `WBB_NOTIFY_CMD`, …). Time becomes one more: `NOW_S="${WBB_NOW_S:-$(date +%s)}"`.

Without it the grace-period test either sleeps fifteen minutes or does not exist, and "does not
exist" is what happened to the drift tests already.

### The messages

The current text describes a standing emergency. The replacement describes the situation:
production is N commits behind, the deployer cannot close the gap itself because the differing
paths are outside the allowlist, and security tags are refused until someone deploys. The claim
about security tags is accurate and stays — what changes is that it is no longer asserted 99
seconds after a merge.

The recovery message is new and short: production has caught up with `main`, and unattended
deploys work again.

### Testing

The drift branch is written from zero coverage, using the existing harness (real script, throwaway
repos, stubbed `WBB_*`), with `WBB_NOW_S` driving the clock:

- drift younger than the grace period → **no notify call at all**;
- drift older than the grace period → exactly one notify, and `LAST_DRIFT_NOTICE` written;
- a second tick in the same day, still drifted → no second notify;
- the next day, still drifted → one reminder;
- `DEPLOYED_SHA` catches up after an announced episode → **one recovery notify**, both fields cleared;
- `DEPLOYED_SHA` catches up *within* the grace window, never announced → **no notify at all**, both
  fields cleared — the happy path stays silent at both ends;
- **the regression this issue is named for**: merge → notify → deploy → merge again the same day →
  a second notify must arrive. Under today's code this is silence.

Every test mutation-proven: reverting the production change must turn it red. The harness's
`readState` helper asserts the state fields directly, so a test cannot pass on a notify that wrote
nothing.

### Out of scope

- **A digest line carrying the current gap.** It is the other half of the "standing state, not an
  alarm" argument and deserves its own change; this one is about the alarm channel.
- **The five-minute timer cadence.** It is not implicated: the same 99-second alarm would fire on a
  one-minute or a ten-minute timer. Duration is the variable, not frequency.

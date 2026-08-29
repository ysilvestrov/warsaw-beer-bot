# #527 — the guard judges a path by whether it ships

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An unattended deploy is refused over a changed path only when that path
actually reaches production, so an extension-only merge stops blocking every
security patch and stops raising a daily alarm nobody can clear.

**Architecture:** One new predicate, `deploy/ships.sh`, parses
`deploy/rsync-filter` — the file rsync itself executes — and classifies paths as
`SHIP` or `SKIP`. Two consumers replace their hardcoded two-name list with it:
the guard (`violation = ships ∧ not a root manifest`) and the drift report
(`drift exists only if something ships`). A real-rsync equivalence test is the
oracle that keeps the second engine honest.

**Tech Stack:** Bash (`set -euo pipefail`), Vitest, real `git` and real `rsync`
against throwaway repositories and temp trees. No network, no sudo, no systemd
in tests.

**Spec:** `docs/superpowers/specs/2026-08/2026-08-28-527-guard-ships-predicate-design.md`

## Global Constraints

- **The filter is read from the newer side of the comparison, never from a
  working tree:** the guard uses `git show <target>:deploy/rsync-filter`, the
  drift report uses `git show origin/main:deploy/rsync-filter`.
- **Fail closed everywhere.** A missing `wbb-ships`, a missing or unparseable
  filter, a failed `git show`: the guard REFUSES, the drift report says "cannot
  assess". Neither may produce silence or an ACCEPT.
- **The grammar is exactly four forms** — blank/`#` comment, `+ /NAME` (single
  segment, no `*?[`), `+ /DIR/***` (single segment), and a terminal `- *` that
  must be the last non-blank non-comment rule. Anything else exits non-zero.
- **What may be deployed does not change.** `tsconfig.json`, `src/**`,
  `scripts/**`, `deploy/**` refuse exactly as they refuse today. Only the root
  `package.json` and `package-lock.json` are ever permitted.
- **`scripts/autodeploy/manifest-scope.ts` is not touched.** Its `ALLOWED_PATHS`
  answers a different question (is this dependabot PR a pure dependency bump?).
- **Every test is mutation-proven:** delete the line it defends, watch it go red,
  restore. A test that passes against the mutant is not a test.
- **Bash gotcha that will bite:** under `set -e`, `[ cond ] && { ...; }` as the
  last command of a loop body aborts the script when the condition is false.
  Use `if` blocks, never `&&` chains, for control flow in these scripts.
- **Bash gotcha #2:** `"${arr[@]}"` on an empty array trips `set -u` on older
  bash. Use `${arr[@]+"${arr[@]}"}`.

---

### Task 1: `deploy/ships.sh` — the predicate, proven against real rsync

**Files:**
- Create: `deploy/ships.sh`
- Create: `scripts/autodeploy/ships.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `deploy/ships.sh <filter-file>`. Reads paths from stdin, one per
  line. Writes `SHIP <path>` or `SKIP <path>` to stdout, one line per non-empty
  input line, in input order. Exit 0 when the filter parsed; exit 1 with the
  reason on stderr and **nothing on stdout** when it did not. Tasks 2 and 3
  invoke it through an env-overridable path (`WBB_SHIPS`, default
  `/usr/local/bin/wbb-ships`).

- [ ] **Step 1: Write the failing unit tests**

Create `scripts/autodeploy/ships.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const SHIPS = resolve(__dirname, '../../deploy/ships.sh');
const REPO_FILTER = resolve(__dirname, '../../deploy/rsync-filter');

/** The production filter's text, so the tests do not re-state it by hand. */
const REAL_FILTER = [
  '+ /package.json',
  '+ /package-lock.json',
  '+ /tsconfig.json',
  '+ /src/***',
  '+ /scripts/***',
  '+ /deploy/***',
  '- *',
  '',
].join('\n');

function filterFile(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'wbb-ships-filter-'));
  const p = join(dir, 'rsync-filter');
  writeFileSync(p, body);
  return p;
}

function ships(filter: string, paths: string[]): { code: number; out: string; err: string } {
  try {
    const out = execFileSync('bash', [SHIPS, filter], {
      encoding: 'utf8',
      input: paths.join('\n') + (paths.length ? '\n' : ''),
    });
    return { code: 0, out, err: '' };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, out: err.stdout ?? '', err: err.stderr ?? '' };
  }
}

/** The SHIP set, as a plain array, for set comparisons. */
function shipped(filter: string, paths: string[]): string[] {
  const r = ships(filter, paths);
  expect(r.code).toBe(0);
  return r.out.split('\n').filter((l) => l.startsWith('SHIP ')).map((l) => l.slice(5));
}

describe('ships.sh — what reaches production', () => {
  const filter = filterFile(REAL_FILTER);

  it('ships the root manifests, tsconfig, and the three shipped directories', () => {
    expect(shipped(filter, [
      'package.json',
      'package-lock.json',
      'tsconfig.json',
      'src/index.ts',
      'src/deep/nested/file.ts',
      'scripts/tool.ts',
      'deploy/deploy.sh',
    ])).toEqual([
      'package.json',
      'package-lock.json',
      'tsconfig.json',
      'src/index.ts',
      'src/deep/nested/file.ts',
      'scripts/tool.ts',
      'deploy/deploy.sh',
    ]);
  });

  it('does not ship the paths that blocked autodeploy on 2026-08-28', () => {
    expect(shipped(filter, [
      '.gitignore',
      '.impeccable/critique/2026-08-28T17-11-20Z__extension-src-popup-popup-html.md',
      'docs/extension-install-en.md',
      'docs/extension-install-uk.md',
      'extension/src/popup/popup.css',
      'extension/src/popup/popup.html',
      'spec.md',
    ])).toEqual([]);
  });

  it('anchors directory rules at the root: vendor/src/x.ts does not ship', () => {
    // The exact mistake a prefix-matching parser makes. `+ /src/***` is
    // anchored at the transfer root; a nested directory of the same name is
    // not the same directory.
    expect(shipped(filter, ['vendor/src/x.ts', 'a/scripts/b.ts', 'x/deploy/y.sh'])).toEqual([]);
  });

  it('anchors file rules at the root: a nested manifest is a different file', () => {
    expect(shipped(filter, ['extension/package-lock.json', 'sub/package.json'])).toEqual([]);
  });

  it('emits one verdict per input line, in order, with SKIP for the rest', () => {
    const r = ships(filter, ['src/a.ts', 'docs/b.md', 'package.json']);
    expect(r.code).toBe(0);
    expect(r.out).toBe('SHIP src/a.ts\nSKIP docs/b.md\nSHIP package.json\n');
  });

  it('accepts comments and blank lines in the filter', () => {
    const f = filterFile('# a comment\n\n  # indented comment\n+ /src/***\n- *\n');
    expect(shipped(f, ['src/a.ts', 'docs/b.md'])).toEqual(['src/a.ts']);
  });

  it('handles an empty path list without producing output', () => {
    const r = ships(filter, []);
    expect(r.code).toBe(0);
    expect(r.out).toBe('');
  });
});

describe('ships.sh — the grammar refuses what it does not implement', () => {
  it('refuses a filter with no terminal catch-all', () => {
    // Without `- *` rsync's default is "everything ships", which is the exact
    // opposite of what this predicate concludes from a non-match.
    const f = filterFile('+ /src/***\n');
    const r = ships(f, ['src/a.ts']);
    expect(r.code).not.toBe(0);
    expect(r.out).toBe('');
    expect(r.err).toMatch(/terminal/i);
  });

  it('refuses a glob in a file rule', () => {
    const f = filterFile('+ /weird[abc]\n- *\n');
    const r = ships(f, ['weirda']);
    expect(r.code).not.toBe(0);
    expect(r.out).toBe('');
  });

  it('refuses a rule after the catch-all', () => {
    const f = filterFile('+ /src/***\n- *\n+ /late.txt\n');
    const r = ships(f, ['late.txt']);
    expect(r.code).not.toBe(0);
    expect(r.out).toBe('');
  });

  it('refuses an exclude rule that is not the catch-all', () => {
    const f = filterFile('- /secret\n+ /src/***\n- *\n');
    const r = ships(f, ['src/a.ts']);
    expect(r.code).not.toBe(0);
    expect(r.out).toBe('');
  });

  it('refuses a multi-segment directory rule rather than guessing', () => {
    const f = filterFile('+ /src/deep/***\n- *\n');
    const r = ships(f, ['src/deep/a.ts']);
    expect(r.code).not.toBe(0);
    expect(r.out).toBe('');
  });

  it('refuses an unreadable filter file', () => {
    const r = ships('/nonexistent/rsync-filter', ['package.json']);
    expect(r.code).not.toBe(0);
    expect(r.out).toBe('');
  });

  it("parses the repository's own deploy/rsync-filter", () => {
    // The check that makes an unsupported rule fail a merge instead of a
    // production guard a week later.
    const r = ships(REPO_FILTER, ['package.json']);
    expect(r.code).toBe(0);
    expect(r.out).toBe('SHIP package.json\n');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run scripts/autodeploy/ships.test.ts`
Expected: FAIL — every test errors because `deploy/ships.sh` does not exist.

- [ ] **Step 3: Write `deploy/ships.sh`**

```bash
#!/usr/bin/env bash
# #527 — does this path reach production?
#
# The autodeploy guard used to answer that with a two-name list of its own,
# while the actual answer lives in deploy/rsync-filter — the file rsync
# executes. The two lists were never the same list, and the guard held the
# wrong one: an extension-only merge, which cannot change anything in /opt,
# refused every security tag (MEASURED 2026-08-28, seven paths, none shipped).
#
# So there is one predicate, and it is derived from the filter rather than
# restated beside it.
#
# Usage:  ships.sh <filter-file>   paths on stdin, one per line
# Output: `SHIP <path>` or `SKIP <path>`, one line per non-empty input line
# Exit:   0 = the filter parsed;  1 = it did not (reason on stderr, NO stdout)
#
# This re-derives rsync's matching in a second engine, which is a debt. It is
# paid two ways: the grammar implements a small subset EXACTLY and refuses
# everything else rather than guessing, and scripts/autodeploy/ships.test.ts
# proves the result against real rsync, path for path.
set -euo pipefail

filter=${1:?filter file required}

if [ ! -r "$filter" ]; then
  echo "ships: cannot read filter file: $filter" >&2
  exit 1
fi

files=()          # exact root paths, from `+ /NAME`
dirs=()           # root directories WITH a trailing slash, from `+ /DIR/***`
seen_catchall=0

while IFS= read -r raw || [ -n "$raw" ]; do
  # Trim both ends; the filter is data written by hand.
  line=${raw#"${raw%%[![:space:]]*}"}
  line=${line%"${line##*[![:space:]]}"}

  if [ -z "$line" ]; then continue; fi
  case "$line" in '#'*) continue ;; esac

  # rsync takes the FIRST matching rule, so nothing after the catch-all can
  # ever match. A rule there means the file no longer says what we read it to
  # say — refuse rather than ignore it.
  if [ "$seen_catchall" -eq 1 ]; then
    echo "ships: rule after the terminal '- *': $line" >&2
    exit 1
  fi

  if [ "$line" = '- *' ]; then
    seen_catchall=1
    continue
  fi

  case "$line" in
    '+ /'*) rule=${line#'+ /'} ;;
    *)
      echo "ships: unsupported filter rule: $line" >&2
      exit 1
      ;;
  esac

  case "$rule" in
    */'***')
      dir=${rule%/'***'}
      # Single segment only, and no globbing. Extending this grammar is a
      # deliberate act with its own test, not something a parser guesses at.
      case "$dir" in
        *[*?\[]* | */* | '')
          echo "ships: unsupported directory rule: $line" >&2
          exit 1
          ;;
      esac
      dirs+=("$dir/")
      ;;
    *)
      case "$rule" in
        *[*?\[]* | */* | '')
          echo "ships: unsupported file rule: $line" >&2
          exit 1
          ;;
      esac
      files+=("$rule")
      ;;
  esac
done < "$filter"

# The predicate concludes "did not match ⇒ does not ship". That is sound ONLY
# because the last rule excludes everything else. Without it rsync's default is
# the opposite, and every verdict below would be backwards.
if [ "$seen_catchall" -ne 1 ]; then
  echo "ships: filter has no terminal '- *' rule; its default is 'everything ships', which this predicate cannot express" >&2
  exit 1
fi

while IFS= read -r path || [ -n "$path" ]; do
  if [ -z "$path" ]; then continue; fi

  verdict=SKIP

  # `if` blocks, not `&&` chains: under `set -e` a false `[ ... ] && { ... }`
  # as the last command of a loop body aborts the whole script.
  for f in ${files[@]+"${files[@]}"}; do
    if [ "$path" = "$f" ]; then
      verdict=SHIP
      break
    fi
  done

  if [ "$verdict" = SKIP ]; then
    for d in ${dirs[@]+"${dirs[@]}"}; do
      case "$path" in
        "$d"*)
          verdict=SHIP
          break
          ;;
      esac
    done
  fi

  printf '%s %s\n' "$verdict" "$path"
done
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run scripts/autodeploy/ships.test.ts`
Expected: PASS, all tests.

Also run: `bash -n deploy/ships.sh`
Expected: no output, exit 0.

- [ ] **Step 5: Write the real-rsync equivalence test**

Append to `scripts/autodeploy/ships.test.ts`:

```typescript
describe('ships.sh agrees with real rsync, path for path', () => {
  // The oracle. A hand-written predicate that re-derives rsync's matching can
  // be subtly wrong in ways no amount of reading catches — anchoring above
  // all. So the fixture tree is transferred by the real rsync with the real
  // filter, and whatever lands is the truth the predicate must reproduce.
  const FIXTURE_PATHS = [
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    'src/index.ts',
    'src/nested/deep/mod.ts',
    'scripts/tool.ts',
    'deploy/deploy.sh',
    'deploy/rsync-filter',
    'extension/manifest.json',
    'extension/src/popup/popup.css',
    'extension/package-lock.json',
    'sub/package.json',
    'vendor/src/x.ts',
    'a/scripts/b.ts',
    'x/deploy/y.sh',
    'docs/plan.md',
    'spec.md',
    '.gitignore',
    '.impeccable/critique/note.md',
    'tests/fixture.ts',
    'tmp/current.db',
  ];

  function filesBelow(root: string, relative = ''): string[] {
    return readdirSync(join(root, relative), { withFileTypes: true }).flatMap((entry) => {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      return entry.isDirectory() ? filesBelow(root, path) : [path];
    });
  }

  it('classifies exactly the files real rsync transfers under the same filter', () => {
    const source = mkdtempSync(join(tmpdir(), 'wbb-ships-src-'));
    const destination = mkdtempSync(join(tmpdir(), 'wbb-ships-dst-'));

    for (const p of FIXTURE_PATHS) {
      const full = join(source, p);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, '');
    }
    // `merge deploy/rsync-filter` resolves relative to rsync's working
    // directory, so the fixture tree carries its own copy of the real filter.
    writeFileSync(join(source, 'deploy/rsync-filter'), REAL_FILTER);

    execFileSync(
      'rsync',
      ['-a', '--delete', '--delete-excluded', '--filter=merge deploy/rsync-filter', './', `${destination}/`],
      { cwd: source },
    );

    // rsync transfers directories too; git diff --name-only never names one,
    // so the predicate is only ever asked about files. Compare file sets.
    const byRsync = filesBelow(destination).sort();
    const byPredicate = shipped(filterFile(REAL_FILTER), FIXTURE_PATHS).sort();

    expect(byPredicate).toEqual(byRsync);
    // Guards against a vacuous pass: an empty tree would equal an empty set.
    expect(byRsync.length).toBeGreaterThan(5);
  });
});
```

- [ ] **Step 6: Run the equivalence test**

Run: `npx vitest run scripts/autodeploy/ships.test.ts`
Expected: PASS.

If it FAILS, the predicate is wrong, not the oracle — fix `deploy/ships.sh`
until real rsync and the predicate agree.

- [ ] **Step 7: Mutation-prove the two load-bearing checks**

Do this by hand, restoring after each:

1. Delete the `if [ "$seen_catchall" -ne 1 ]` block. Expected red: *"refuses a
   filter with no terminal catch-all"*. Restore.
2. In the directory loop, change `case "$path" in "$d"*)` to
   `case "$path" in *"$d"*)`. Expected red: *"anchors directory rules at the
   root"* and the rsync equivalence test. Restore.

Both mutants must produce a red test. If either stays green, the test is not
testing what it claims.

- [ ] **Step 8: Commit**

```bash
git add deploy/ships.sh scripts/autodeploy/ships.test.ts
git commit -m "feat(#527): one predicate for what reaches production, derived from deploy/rsync-filter"
```

---

### Task 2: the guard judges by the predicate

**Files:**
- Modify: `deploy/autodeploy-guard.sh` (the allowlist block, lines ~60-80)
- Modify: `scripts/autodeploy/guard.test.ts`

**Interfaces:**
- Consumes: `deploy/ships.sh` from Task 1 — `ships.sh <filter-file>`, paths on
  stdin, `SHIP <path>` / `SKIP <path>` on stdout, non-zero exit on an
  unparseable filter.
- Produces: `autodeploy-guard.sh <repo> <deployed> <target> <main_ref>`,
  unchanged signature. New env seam `WBB_SHIPS` (default
  `/usr/local/bin/wbb-ships`), which Task 4 installs and Task 3 reuses.

- [ ] **Step 1: Give the guard fixture a filter, and write the failing tests**

In `scripts/autodeploy/guard.test.ts`, add the filter constant below the
imports:

```typescript
const SHIPS = resolve(__dirname, '../../deploy/ships.sh');

const REAL_FILTER = [
  '+ /package.json',
  '+ /package-lock.json',
  '+ /tsconfig.json',
  '+ /src/***',
  '+ /scripts/***',
  '+ /deploy/***',
  '- *',
  '',
].join('\n');
```

Change `guard()` to pass the seam:

```typescript
function guard(repo: string, deployed: string, target: string, mainRef: string, env: Record<string, string> = {}) {
  try {
    const out = execFileSync('bash', [GUARD, repo, deployed, target, mainRef], {
      encoding: 'utf8',
      env: { ...process.env, WBB_SHIPS: SHIPS, ...env },
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, out: (err.stdout ?? '') + (err.stderr ?? '') };
  }
}
```

Add `'deploy/rsync-filter': REAL_FILTER` to the `basec` commit in `beforeAll`,
so every commit on that branch carries it:

```typescript
    basec = commit(repo, {
      'package.json': '{"name":"x","dependencies":{"undici":"^7.28.0"}}',
      'package-lock.json': '{"lockfileVersion":3}',
      'src/index.ts': 'export const a = 1;\n',
      'deploy/rsync-filter': REAL_FILTER,
    }, 'base');
```

Add a `tsconfig` fixture commit at the end of `beforeAll`, after `subPackage`:

```typescript
    tsconfigChange = commit(repo, { 'tsconfig.json': '{"compilerOptions":{}}' }, 'tsconfig change');
```

(declare `let tsconfigChange: string;` beside the others), and a second
repository with no filter at all:

```typescript
    noFilterRepo = mkdtempSync(join(tmpdir(), 'wbb-guard-nofilter-'));
    git(noFilterRepo, 'init', '-q', '-b', 'main');
    git(noFilterRepo, 'config', 'user.email', 't@example.com');
    git(noFilterRepo, 'config', 'user.name', 'T');
    noFilterBase = commit(noFilterRepo, { 'package.json': '{}' }, 'base');
    noFilterHead = commit(noFilterRepo, { 'package.json': '{"v":2}' }, 'bump');
```

**Replace** the two tests that this change deliberately flips:

```typescript
  it('ACCEPTS a diff that touches extension/package-lock.json — it never reaches the server', () => {
    // FLIPPED by #527. This used to REFUSE. The old test's intent — "the
    // allowlist is string equality, not a glob" — did not disappear: it moved
    // into ships.test.ts, which pins that a nested manifest is a different
    // file from the root one. What changed is the conclusion drawn from that:
    // a file that does not ship cannot restart the bot, so it is not a reason
    // to refuse a security patch.
    const r = guard(repo, withSrc, extensionLock, 'main');
    expect(r.code).toBe(0);
    expect(r.out).toContain('ACCEPT');
    expect(r.out).toContain('extension/package-lock.json');
    expect(r.out).toMatch(/do not ship/);
  });

  it('ACCEPTS a diff that touches a nested package.json — also not shipped', () => {
    const r = guard(repo, extensionLock, subPackage, 'main');
    expect(r.code).toBe(0);
    expect(r.out).toContain('ACCEPT');
    expect(r.out).toContain('sub/package.json');
  });
```

**Add** the new tests:

```typescript
  it('refuses a diff that touches tsconfig.json — it ships and is not a manifest', () => {
    const r = guard(repo, subPackage, tsconfigChange, 'main');
    expect(r.code).toBe(1);
    expect(r.out).toContain('tsconfig.json');
  });

  it('replays 2026-08-28: a diff of only non-shipping paths is accepted and named', () => {
    // The measured incident, reduced to a fixture: seven paths, none of which
    // pass the filter, refused for three and a half days.
    const before = commit(repo, { 'package.json': '{"name":"x","dependencies":{"undici":"^7.28.0"}}' }, 'anchor');
    const after = commit(repo, {
      '.gitignore': 'tmp\n',
      'docs/extension-install-uk.md': 'doc\n',
      'extension/src/popup/popup.css': 'body{}\n',
      'spec.md': 'spec\n',
    }, 'extension-only merge');
    const r = guard(repo, before, after, 'main');
    expect(r.code).toBe(0);
    expect(r.out).toContain('ACCEPT');
    expect(r.out).toMatch(/4 changed path\(s\) do not ship/);
  });

  it('REFUSES when the ships predicate is unavailable', () => {
    const r = guard(repo, basec, lockOnly, 'main', { WBB_SHIPS: '/nonexistent/wbb-ships' });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/classify/i);
  });

  it('REFUSES when the target carries no deploy/rsync-filter', () => {
    const r = guard(noFilterRepo, noFilterBase, noFilterHead, 'main');
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/rsync-filter/);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run scripts/autodeploy/guard.test.ts`
Expected: FAIL — the two flipped tests still REFUSE, `tsconfig.json` is refused
for the wrong reason (it is simply not in the two-name list), and the two
fail-closed tests find no such behaviour.

- [ ] **Step 3: Replace the guard's allowlist block**

In `deploy/autodeploy-guard.sh`, add the seam below the argument parsing:

```bash
# #527 — the predicate lives in its own installed copy, like the guard itself;
# a flat /usr/local/bin means this script cannot reach its sibling through $0.
SHIPS_BIN="${WBB_SHIPS:-/usr/local/bin/wbb-ships}"
```

Then replace everything from the `# The allowlist. NOT extension/**` comment
through the `violations` loop and its `if` with:

```bash
# #527 — the allowlist question is really two questions, and this script used
# to hold only the second one.
#
#   1. Can this path affect production AT ALL?  deploy/rsync-filter answers
#      that, and it is the only thing that can: it is what rsync executes.
#   2. Of the paths that can, which may an unattended deploy change?  The root
#      manifests, and nothing else.
#
# Collapsing them into one two-name list made an extension-only merge — which
# cannot touch /opt — refuse every security tag. MEASURED 2026-08-28: seven
# paths, zero of them shipped, autodeploy dead for three and a half days.
#
# The filter is read from the TARGET, not from the clone's working tree and
# not from the deployed commit. A wrong ACCEPT would need a path that ships
# under target's filter to be classified as non-shipping; reading target's
# filter makes that impossible by definition, in one step, without relying on
# `deploy/***` staying inside the filter forever.
if ! diff_out=$(git -C "$repo" diff --name-only "$deployed" "$target"); then
  echo "REFUSE: git diff between $deployed and $target failed"
  exit 1
fi

filter_file=$(mktemp) || { echo "REFUSE: could not create a temporary file for the rsync filter"; exit 1; }
trap 'rm -f "$filter_file"' EXIT

if ! git -C "$repo" show "${target}:deploy/rsync-filter" > "$filter_file" 2>/dev/null; then
  echo "REFUSE: $target carries no deploy/rsync-filter — there is no way to tell what would ship"
  exit 1
fi

if ! classified=$(printf '%s\n' "$diff_out" | "$SHIPS_BIN" "$filter_file" 2>&1); then
  echo "REFUSE: could not classify the diff against ${target}:deploy/rsync-filter"
  echo "$classified"
  exit 1
fi

violations=()
ignored=()
while IFS=' ' read -r verdict path; do
  if [ -z "$path" ]; then continue; fi
  case "$verdict" in
    SHIP)
      case "$path" in
        package.json|package-lock.json) ;;
        *) violations+=("$path") ;;
      esac
      ;;
    SKIP) ignored+=("$path") ;;
    *)
      echo "REFUSE: unexpected classification '$verdict' for $path"
      exit 1
      ;;
  esac
done <<< "$classified"

if [ "${#violations[@]}" -gt 0 ]; then
  echo "REFUSE: ${#violations[@]} path(s) that ship to the server and are not the root manifests:"
  printf '  %s\n' "${violations[@]}"
  exit 1
fi

echo "ACCEPT: nothing outside the root manifests ships, merged into $main_ref"
if [ "${#ignored[@]}" -gt 0 ]; then
  echo "  ${#ignored[@]} changed path(s) do not ship and were ignored:"
  printf '    %s\n' "${ignored[@]}"
fi
exit 0
```

Delete the now-dead `mapfile -t changed <<< "$diff_out"` line and the old
trailing `echo "ACCEPT: lockfile-only change, merged into $main_ref"` / `exit 0`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run scripts/autodeploy/guard.test.ts`
Expected: PASS, all tests including the pre-existing ancestor, downgrade,
empty-diff, `src/` and bogus-sha cases.

Also run: `bash -n deploy/autodeploy-guard.sh`
Expected: no output, exit 0.

- [ ] **Step 5: Mutation-prove the fail-closed paths**

Restoring after each:

1. Change the `git show ... > "$filter_file"` failure branch to `:` (do
   nothing). Expected red: *"REFUSES when the target carries no
   deploy/rsync-filter"*. Restore.
2. Change the classification failure branch to `classified=''`. Expected red:
   *"REFUSES when the ships predicate is unavailable"*. Restore.
3. Change `SHIP)`'s inner `case` to accept `*` as well. Expected red: *"refuses
   a diff that touches src/"* and the `tsconfig.json` test. Restore.

- [ ] **Step 6: Commit**

```bash
git add deploy/autodeploy-guard.sh scripts/autodeploy/guard.test.ts
git commit -m "fix(#527): the guard refuses a path only when that path reaches production"
```

---

### Task 3: drift exists only when something ships

**Files:**
- Modify: `deploy/autodeploy.sh` (`report_drift_once`, and a new helper above it)
- Modify: `scripts/autodeploy/autodeploy.test.ts` (`driftRemote`, `run`, new tests)

**Interfaces:**
- Consumes: `deploy/ships.sh` from Task 1, through the same `WBB_SHIPS` seam
  Task 2 introduced (default `/usr/local/bin/wbb-ships`).
- Produces: `report_drift_once` with three outcomes — silence when nothing
  ships, ⚠️ BLOCKED when a shipping path is not a manifest, ℹ️ when the only
  shipping paths are the manifests — plus a fourth, "cannot assess", when
  classification fails.

- [ ] **Step 1: Give the drift fixtures a filter, and write the failing tests**

In `scripts/autodeploy/autodeploy.test.ts`, add the constant near the top:

```typescript
const SHIPS = resolve(__dirname, '../../deploy/ships.sh');

const REAL_FILTER = [
  '+ /package.json',
  '+ /package-lock.json',
  '+ /tsconfig.json',
  '+ /src/***',
  '+ /scripts/***',
  '+ /deploy/***',
  '- *',
  '',
].join('\n');
```

Add the seam to `run()`'s defaults, before the `...extraEnv` spread:

```typescript
    WBB_INSTALLED_CHECK: defaultInstalledCheck,
    WBB_SHIPS: SHIPS,
    ...extraEnv,
```

Give `driftRemote` the filter and a second, non-shipping variant. Replace it
with:

```typescript
/**
 * #490/#491 as before. #527: the fixture commits now carry a real
 * `deploy/rsync-filter`, because report_drift_once reads it from
 * `origin/main` — a fixture without one is no longer "a repo with two
 * commits", it is the fail-closed case.
 *
 * `differsIn` chooses what the second commit changes: 'src' is drift that
 * ships and is blocking, 'lockfile' ships and is not, 'extension' ships
 * nothing at all.
 */
function driftRemote(
  tagAt?: 'old' | 'new',
  differsIn: 'src' | 'lockfile' | 'extension' = 'src',
): { dir: string; oldSha: string; newSha: string; tag: string } {
  const dir = mkdtempSync(join(tmpdir(), 'wbb-drift-remote-'));
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', dir]);
  const seed = mkdtempSync(join(tmpdir(), 'wbb-drift-seed-'));
  git(seed, 'init', '-q', '-b', 'main');
  git(seed, 'config', 'user.email', 't@example.com');
  git(seed, 'config', 'user.name', 'T');
  git(seed, 'remote', 'add', 'origin', dir);
  const oldSha = commit(seed, {
    'src/x.ts': 'export const x = 1;\n',
    'package-lock.json': '{"lockfileVersion":3}\n',
    'extension/popup.css': 'body{}\n',
    'deploy/rsync-filter': REAL_FILTER,
  }, 'old');
  git(seed, 'push', '-q', 'origin', 'main');
  const changed = {
    src: { 'src/x.ts': 'export const x = 2;\n' },
    lockfile: { 'package-lock.json': '{"lockfileVersion":3,"bumped":true}\n' },
    extension: { 'extension/popup.css': 'body{color:red}\n' },
  }[differsIn];
  const newSha = commit(seed, changed, 'new');
  git(seed, 'push', '-q', 'origin', 'main');
  const tag = 'autodeploy-20260824T120000Z';
  if (tagAt) {
    git(seed, 'tag', tag, tagAt === 'old' ? oldSha : newSha);
    git(seed, 'push', '-q', 'origin', tag);
  }
  return { dir, oldSha, newSha, tag };
}

/** A remote whose commits carry NO rsync-filter: the fail-closed case. */
function driftRemoteWithoutFilter(): { dir: string; oldSha: string; newSha: string } {
  const dir = mkdtempSync(join(tmpdir(), 'wbb-drift-nofilter-'));
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', dir]);
  const seed = mkdtempSync(join(tmpdir(), 'wbb-drift-nofilter-seed-'));
  git(seed, 'init', '-q', '-b', 'main');
  git(seed, 'config', 'user.email', 't@example.com');
  git(seed, 'config', 'user.name', 'T');
  git(seed, 'remote', 'add', 'origin', dir);
  const oldSha = commit(seed, { 'src/x.ts': 'export const x = 1;\n' }, 'old');
  git(seed, 'push', '-q', 'origin', 'main');
  const newSha = commit(seed, { 'src/x.ts': 'export const x = 2;\n' }, 'new');
  git(seed, 'push', '-q', 'origin', 'main');
  return { dir, oldSha, newSha };
}
```

Add a new describe block after the `#490 drift episode` block:

```typescript
describe('#527 drift is drift only when something ships', () => {
  it('says nothing and opens no episode when the only difference never ships', () => {
    // The 2026-08-28 incident. An extension-only merge leaves production
    // permanently behind main — there is nothing to deploy, so the baseline
    // never advances — and a daily reminder about a condition nobody can
    // clear is the failure mode #490 already had to remove once.
    const r = driftRemote(undefined, 'extension');
    const h = driftHarness(r.dir, { DEPLOYED_SHA: r.oldSha, PREVIOUS_SHA: '' });
    const notifyLog = join(h.bin, 'notify.log');
    const notify = stub(h.bin, 'notify', `cat >> "${notifyLog}" <<< "$1"`);

    expect(run(h, { WBB_NOTIFY_CMD: notify, WBB_NOW_S: '1000000' }).code).toBe(0);

    expect(existsSync(notifyLog)).toBe(false);
    // Measured in the state file, not by the absence of a message: an episode
    // that opens now would announce fifteen minutes from now.
    expect(readState(h.stateDir).DRIFT_SINCE ?? '').toBe('');
  });

  it('still announces when a shipping path differs', () => {
    const r = driftRemote(undefined, 'src');
    const h = driftHarness(r.dir, {
      DEPLOYED_SHA: r.oldSha, PREVIOUS_SHA: '', DRIFT_SINCE: '1000000',
    });
    const notifyLog = join(h.bin, 'notify.log');
    const notify = stub(h.bin, 'notify', `cat >> "${notifyLog}" <<< "$1"`);

    expect(run(h, { WBB_NOTIFY_CMD: notify, WBB_NOW_S: String(1000000 + 900) }).code).toBe(0);

    expect(countLines(notifyLog)).toBe(1);
    expect(readFileSync(notifyLog, 'utf8')).toMatch(/BLOCKED/);
  });

  it('reports the non-blocking variant when only the lockfile ships', () => {
    const r = driftRemote(undefined, 'lockfile');
    const h = driftHarness(r.dir, {
      DEPLOYED_SHA: r.oldSha, PREVIOUS_SHA: '', DRIFT_SINCE: '1000000',
    });
    const notifyLog = join(h.bin, 'notify.log');
    const notify = stub(h.bin, 'notify', `cat >> "${notifyLog}" <<< "$1"`);

    expect(run(h, { WBB_NOTIFY_CMD: notify, WBB_NOW_S: String(1000000 + 900) }).code).toBe(0);

    expect(countLines(notifyLog)).toBe(1);
    expect(readFileSync(notifyLog, 'utf8')).not.toMatch(/BLOCKED/);
    expect(readFileSync(notifyLog, 'utf8')).toMatch(/still works/);
  });

  it('does NOT go silent when it cannot classify the diff', () => {
    // The trap this change creates. The quiet branch above is quieter than
    // #499's reassuring message: a classification failure and "nothing ships"
    // would otherwise be the same outcome — total silence.
    const r = driftRemoteWithoutFilter();
    const h = driftHarness(r.dir, {
      DEPLOYED_SHA: r.oldSha, PREVIOUS_SHA: '', DRIFT_SINCE: '1000000',
    });
    const notifyLog = join(h.bin, 'notify.log');
    const notify = stub(h.bin, 'notify', `cat >> "${notifyLog}" <<< "$1"`);

    expect(run(h, { WBB_NOTIFY_CMD: notify, WBB_NOW_S: String(1000000 + 900) }).code).toBe(0);

    expect(countLines(notifyLog)).toBe(1);
    expect(readFileSync(notifyLog, 'utf8')).toMatch(/cannot tell|cannot assess/i);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run scripts/autodeploy/autodeploy.test.ts`
Expected: FAIL — the extension-only case announces ⚠️ BLOCKED and writes
`DRIFT_SINCE`; the lockfile case may pass already; the cannot-classify case
sends nothing.

- [ ] **Step 3: Add the shipping helper and rewrite the classification**

In `deploy/autodeploy.sh`, add the seam beside the other `*_BIN` definitions:

```bash
# #527 — same install-path pattern as the guard and read-env.
SHIPS_BIN="${WBB_SHIPS:-/usr/local/bin/wbb-ships}"
```

Add this helper immediately above `report_drift_once`:

```bash
# #527 — the paths of diff(DEPLOYED_SHA, $1) that actually reach production,
# one per line on stdout.
#
# Non-zero exit means WE COULD NOT TELL. That is not the same statement as
# "nothing ships", and the caller must not collapse them: the quiet branch in
# report_drift_once is quieter than #499's reassuring message, so a failure
# folded into it would be an outage nobody hears about.
shipping_paths() {
  local main_sha="$1" filter_file diff_out classified
  filter_file=$(mktemp) || return 1

  if ! git -C "$REPO" show "${main_sha}:deploy/rsync-filter" > "$filter_file" 2>/dev/null; then
    rm -f "$filter_file"
    return 1
  fi
  if ! diff_out=$(git -C "$REPO" diff --name-only "$DEPLOYED_SHA" "$main_sha" 2>/dev/null); then
    rm -f "$filter_file"
    return 1
  fi
  if ! classified=$(printf '%s\n' "$diff_out" | "$SHIPS_BIN" "$filter_file" 2>/dev/null); then
    rm -f "$filter_file"
    return 1
  fi
  rm -f "$filter_file"

  printf '%s\n' "$classified" | sed -n 's/^SHIP //p'
}
```

In `report_drift_once`, change the locals line and replace the
`DEPLOYED_SHA = main_sha` block:

```bash
  local main_sha today behind shipping outside_count
```

Insert directly after the two `[ -n ... ] || return 0` guards:

```bash
  # #527 — classify BEFORE deciding anything. A failure here is its own state.
  if ! shipping=$(shipping_paths "$main_sha"); then
    if [ "$LAST_DRIFT_NOTICE" != "$today" ]; then
      notify "⚠️ autodeploy cannot tell whether production is behind main: classifying the diff against ${main_sha}:deploy/rsync-filter failed. Treat autodeploy as blocked until this is understood."
      LAST_DRIFT_NOTICE="$today"
      write_state "$DEPLOYED_SHA" "$PREVIOUS_SHA" "$LAST_FAILED_SHA"
    fi
    return 0
  fi
```

Then replace `if [ "$DEPLOYED_SHA" = "$main_sha" ]; then` with:

```bash
  # No drift: nothing that reaches production differs. Commit equality is one
  # case of this rather than a separate condition — an extension-only merge is
  # the other, and it is why this function used to siren forever about a
  # difference nobody could deploy away.
  if [ -z "$shipping" ]; then
```

(the body of that branch is unchanged.)

Finally replace the `behind`/`outside` computation and the two messages:

```bash
  behind=$(git -C "$REPO" rev-list --count "${DEPLOYED_SHA}..${main_sha}" 2>/dev/null || echo '?')

  # Counted in THIS shell, not in a pipeline whose last element is a `{ ... }`
  # group. That shape is #499's body: a failure inside it is invisible and
  # yields 0, which reads as "nothing to worry about".
  outside_count=0
  while IFS= read -r f; do
    if [ -z "$f" ]; then continue; fi
    case "$f" in
      package.json|package-lock.json) ;;
      *) outside_count=$((outside_count + 1)) ;;
    esac
  done <<< "$shipping"

  if [ "$outside_count" != "0" ]; then
    notify "⚠️ autodeploy is BLOCKED: production is ${behind} commit(s) behind main, and ${outside_count} path(s) that ship to the server differ. Every security tag will be refused until production is deployed. Run ./deploy/deploy.sh."
  else
    notify "ℹ️ production is ${behind} commit(s) behind main, but the only paths that ship are the manifest and lockfile — autodeploy still works."
  fi
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run scripts/autodeploy/autodeploy.test.ts`
Expected: PASS — including every pre-existing `#490 drift episode` test, which
now runs against fixtures that carry a filter.

Also run: `bash -n deploy/autodeploy.sh`
Expected: no output, exit 0.

- [ ] **Step 5: Mutation-prove the silence and the alarm**

Restoring after each:

1. Change `if ! shipping=$(shipping_paths "$main_sha"); then` to
   `shipping=$(shipping_paths "$main_sha" || true)`. Expected red: *"does NOT go
   silent when it cannot classify the diff"*. Restore.
2. Delete the `if [ -z "$shipping" ]` condition's use of `$shipping` and put
   back `[ "$DEPLOYED_SHA" = "$main_sha" ]`. Expected red: *"says nothing and
   opens no episode when the only difference never ships"*. Restore.
3. In `shipping_paths`, change `sed -n 's/^SHIP //p'` to `sed -n 's/^S[HK]I[PP]* //p'`
   so SKIP lines leak through. Expected red: the extension-only silence test.
   Restore.

- [ ] **Step 6: Commit**

```bash
git add deploy/autodeploy.sh scripts/autodeploy/autodeploy.test.ts
git commit -m "fix(#527): production is behind main only when it is behind in something that ships"
```

---

### Task 4: install the fifth file, and make forgetting it impossible

**Files:**
- Modify: `deploy/install-autodeploy.sh`
- Modify: `deploy/autodeploy.sh` (`installed_is_stale`, the pair list)
- Create: `scripts/autodeploy/install-invariant.test.ts`

**Interfaces:**
- Consumes: `deploy/ships.sh` (Task 1) and the `SHIPS_BIN` variable already
  defined in `deploy/autodeploy.sh` (Task 3).
- Produces: `/usr/local/bin/wbb-ships` as a fifth installed copy, covered by the
  staleness check like the other four.

- [ ] **Step 1: Write the failing invariant test**

Create `scripts/autodeploy/install-invariant.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const autodeploy = readFileSync(resolve(__dirname, '../../deploy/autodeploy.sh'), 'utf8');
const installer = readFileSync(resolve(__dirname, '../../deploy/install-autodeploy.sh'), 'utf8');

/**
 * #527 — a fifth installed file is a fifth way to be silently stale, and it
 * has to be added in two files that nothing ties together: the pair list in
 * `installed_is_stale`, which decides what staleness MEANS, and the installer,
 * which decides what is actually put there. A copy named in one and missing
 * from the other is either never checked or never installed, and both failures
 * are quiet.
 */
describe('every checked installed copy is actually installed', () => {
  const block = autodeploy.slice(autodeploy.indexOf('installed_is_stale()'));
  const declared = [
    ...new Set([...block.matchAll(/"(deploy\/[A-Za-z0-9._-]+)=/g)].map((m) => m[1])),
  ];

  it('names the four original scripts and ships.sh', () => {
    // Pinned explicitly. Without this the loop below is vacuously green the
    // moment a pair is deleted from the list.
    expect(declared).toContain('deploy/autodeploy.sh');
    expect(declared).toContain('deploy/autodeploy-guard.sh');
    expect(declared).toContain('deploy/read-env.sh');
    expect(declared).toContain('deploy/installed-current.sh');
    expect(declared).toContain('deploy/ships.sh');
  });

  it.each(() => declared.map((p) => [p] as const))('installs %s', (path) => {
    expect(installer).toContain(path);
  });
});
```

If `it.each` with a thunk is awkward in this Vitest version, use a plain loop
inside a single `it`:

```typescript
  it('installs every declared copy', () => {
    for (const path of declared) expect(installer).toContain(path);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run scripts/autodeploy/install-invariant.test.ts`
Expected: FAIL on *"names the four original scripts and ships.sh"* —
`deploy/ships.sh` is in neither file yet.

- [ ] **Step 3: Add the pair and the install line**

In `deploy/autodeploy.sh`, add to the `installed_is_stale` pair list:

```bash
  ! STALE_REPORT=$("$INSTALLED_CHECK_BIN" "$REPO" origin/main \
      "deploy/autodeploy.sh=$0" \
      "deploy/autodeploy-guard.sh=$GUARD_BIN" \
      "deploy/read-env.sh=$READ_ENV_BIN" \
      "deploy/ships.sh=$SHIPS_BIN" \
      "deploy/installed-current.sh=$INSTALLED_CHECK_BIN" 2>&1)
```

In `deploy/install-autodeploy.sh`, add the install line and the listing:

```bash
install -m 0755 deploy/ships.sh               /usr/local/bin/wbb-ships
```

```bash
ls -l /usr/local/bin/wbb-autodeploy /usr/local/bin/wbb-autodeploy-guard \
      /usr/local/bin/wbb-read-env /usr/local/bin/wbb-ships \
      /usr/local/bin/wbb-installed-current
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run scripts/autodeploy/install-invariant.test.ts`
Expected: PASS.

Also run: `bash -n deploy/install-autodeploy.sh && bash -n deploy/autodeploy.sh`
Expected: no output, exit 0.

- [ ] **Step 5: Mutation-prove it**

Delete the `install -m 0755 deploy/ships.sh` line. Expected red: *"installs
deploy/ships.sh"*. Restore. Then delete the `"deploy/ships.sh=$SHIPS_BIN"`
pair. Expected red: *"names the four original scripts and ships.sh"*. Restore.

- [ ] **Step 6: Commit**

```bash
git add deploy/install-autodeploy.sh deploy/autodeploy.sh scripts/autodeploy/install-invariant.test.ts
git commit -m "feat(#527): install wbb-ships, and tie the staleness list to the installer"
```

---

### Task 5: documentation, and the whole-suite gate

**Files:**
- Modify: `deploy/README.md:139-142`
- Review (likely unchanged): `spec.md:1632`

**Interfaces:**
- Consumes: everything from Tasks 1-4.
- Produces: no code interface. This task's deliverable is that the docs no
  longer describe the removed rule, and that the full suite is green.

- [ ] **Step 1: Correct the autodeploy section of `deploy/README.md`**

Replace:

```markdown
A timer checks for an `autodeploy-*` tag and deploys it only if the change
touches nothing but the root `package.json` and `package-lock.json`. See
`docs/superpowers/specs/2026-08/2026-08-16-435-dependency-security-autofix-design.md`.
```

with:

```markdown
A timer checks for an `autodeploy-*` tag and deploys it only if the change
touches nothing that **reaches production** except the root `package.json` and
`package-lock.json`. What reaches production is decided by `deploy/rsync-filter`
and read by `deploy/ships.sh`; a merge that changes only `extension/**`,
`docs/**` or `spec.md` ships nothing, so it neither blocks a security tag nor
counts as drift. See
`docs/superpowers/specs/2026-08/2026-08-16-435-dependency-security-autofix-design.md`
and `docs/superpowers/specs/2026-08/2026-08-28-527-guard-ships-predicate-design.md`.
```

- [ ] **Step 2: Review `spec.md` and record the outcome**

`spec.md:1632` reads "Деплой: rsync allowlist build/runtime-файлів із working
tree → `/opt`", which stays true — `spec.md` describes the deploy payload, not
the autodeploy guard's refusal rule, and this change does not alter the payload.

**Make no edit.** State in the pull request description that `spec.md` was
reviewed and needs no change, and why. (Project rule: every implementation is
reviewed against `spec.md`; "reviewed, no change needed" is a reportable
outcome, silently skipping it is not.)

No `extension/**` file is touched, so the `docs/extension-install-uk.md` rule
does not apply here.

- [ ] **Step 3: Run the whole suite and the typechecker**

Run: `npm test`
Expected: PASS, no regressions anywhere.

Run: `npm run typecheck`
Expected: clean.

Run: `bash -n deploy/ships.sh deploy/autodeploy.sh deploy/autodeploy-guard.sh deploy/install-autodeploy.sh`
Expected: no output.

Run: `git diff --check`
Expected: no output.

- [ ] **Step 4: Verify prediction P1 against the real repository**

The guard is a pure function of four arguments, so the measured incident
replays without deploying anything. From the repository root:

```bash
bash deploy/autodeploy-guard.sh . d48413c82d07441a7680b954482d0be2099f948d feb0ed57d1cfad21e0a713bdad8fb49be0d022b1 origin/main
```

Note: run it with `WBB_SHIPS=deploy/ships.sh` in the environment, since
`/usr/local/bin/wbb-ships` does not exist until the rollout installs it:

```bash
WBB_SHIPS=deploy/ships.sh bash deploy/autodeploy-guard.sh . \
  d48413c82d07441a7680b954482d0be2099f948d \
  feb0ed57d1cfad21e0a713bdad8fb49be0d022b1 origin/main
```

Expected: `ACCEPT`, exit 0, and a list naming all 7 non-shipping paths
(`.gitignore`, the `.impeccable/` critique, both `docs/extension-install-*.md`,
both `extension/src/popup/*`, `spec.md`).

Before the change the identical command printed `REFUSE: 7 path(s) outside the
allowlist` and exited 1. Record the actual output in the pull request.

- [ ] **Step 5: Commit**

```bash
git add deploy/README.md
git commit -m "docs(#527): the autodeploy rule is about what reaches production"
```

---

## Self-review notes

- **Spec coverage.** Change 1 → Task 1. Change 2 → Task 2. Change 3 → Task 3.
  Change 4 → Task 3 Step 3 (the `shipping_paths` failure branch) and its test.
  Testing section → Tasks 1-4. Install invariant → Task 4. Rollout → executed
  after merge, not by this plan. Predictions P1 → Task 5 Step 4; P2 → the Task 3
  extension-only test; P3 → the Task 2 `src/` and `tsconfig.json` tests.
- **Naming consistency.** `SHIPS_BIN` / `WBB_SHIPS` / `/usr/local/bin/wbb-ships`
  / `deploy/ships.sh` are used identically in Tasks 2, 3 and 4. `REAL_FILTER` is
  redefined in each test file rather than shared — the test files do not import
  from each other today, and a shared fixture module is not worth a new import
  graph for eight lines.
- **Deliberately out of scope**, do not "fix" while passing through: #498
  (`LAST_FAILED_SHA=72448d9` in production state), #499 (the reassuring message
  when the baseline SHA will not resolve), and
  `scripts/autodeploy/manifest-scope.ts`.

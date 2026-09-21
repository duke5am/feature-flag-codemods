# feature-flag-codemods

Remove feature flags that are fully rolled out — and **refuse rather than corrupt**
when a rewrite is not provably safe.

Zero dependencies. Dry-run by default.

```bash
node codemods/find-stale-flags.js src              # inventory: what flags exist
node codemods/remove-enabled-flag.js --flag new_dashboard src   # dry run
node codemods/remove-enabled-flag.js --flag new_dashboard src --write
```

## The safety property is the product

A codemod that rewrites a flag conditional it did not fully understand corrupts
your code silently, and you find out at runtime. So this one **refuses** anything
it cannot prove:

```
REFUSED (11) -- left untouched on purpose, a human has to look at these
  hard/loop-side-effects.js:23:9  LOOP_CARRIED_MUTATION  [refused]
      this flag sits inside a loop and the branch it would delete has effects on
      state that outlives one iteration ("stats.queued": +=, call queue()).
      Whether the loop still behaves the same after the branch is gone needs
      whole-function reasoning, which this tool does not attempt.
```

Verified here: a refused file is **byte-identical** afterwards. And `--dry-run` is
the default — the whole fixture tree hashes the same before and after.

## What it refuses

`LOOP_CARRIED_MUTATION` · `DYNAMIC_FLAG_NAME` (computed `flags[name]`) ·
`SHARED_MUTATION` (both branches write the same variable) ·
`NON_PURE_CONDITION` (removing the flag would also remove a side effect) ·
`MULTI_FLAG_CONDITION` · `FLAG_USED_AS_VALUE` · `BLOCK_SCOPE_HOIST` ·
`UNSUPPORTED_OPERATOR` · and more.

Every refusal names the file, line and **reason**, and most can be relaxed with
`--allow <CODE>` when you have reviewed that specific case.

## What it handles

`if (flags.x)` · ternaries · `&&` short-circuits · `!flag` · early returns ·
alias imports (`const f = flags`) · destructured bindings · renamed imports ·
`useFlag()` / `isFeatureEnabled()` call forms · wrapper components
(`<FeatureFlag name="x">…</FeatureFlag>`, including nested) · and multi-file
reference cleanup (unused imports and declarations removed).

## The inventory is a lower bound — and says so

```
find-stale-flags 1.0.0
files scanned: 21    flags found: 5    references: 37

refs  files  flag             where
  24     11  new_dashboard    dashboard.js (7), hard/unsafe-shapes.js (6) +9 more

DYNAMIC LOOKUPS (7) -- flag names computed at runtime; this inventory cannot see them
  flags-ui.js:12:10  computed-member  (name)
```

Computed flag names are invisible to static analysis, so the count is a **lower
bound**. Those lookups are listed explicitly rather than omitted, and a file
containing one *plus* a real reference is refused wholesale.

## The rule that matters most

**The flag's state is an input, not a finding.** You tell it `remove-enabled` or
`remove-disabled`; it never contacts your flag provider and makes no network calls.
That split is deliberate: a tool that both decides a flag is dead *and* deletes it
has no independent check on its own premise.

Confirm the state from your provider's data, then remove. And do it in a dedicated
commit so a revert still works.

## Requirements

Node 18.17+. Nothing to install.

## The full pack

The paid kit adds the `WORKFLOW.md` process for clearing a backlog, the full
fixture project with every hard case, and 84 tests.

<!-- RELATED:START -->

## Related tools

- **[actions-audit](https://github.com/duke5am/actions-audit)** — Audit GitHub Actions workflows for supply chain risk: unpinned actions, script injection, pull_request_target, missing permissions and timeouts.
  *(if you were searching for "github actions security audit")*
- **[dockerfile-hardening-lint](https://github.com/duke5am/dockerfile-hardening-lint)** — Static Dockerfile audit for hardening mistakes: root user, secrets in build args, latest tags, cache-busting layer order. No Docker daemon needed.
  *(if you were searching for "dockerfile security check")*
- **[eslint-architecture-rules](https://github.com/duke5am/eslint-architecture-rules)** — ESLint rules that fail CI when architecture boundaries erode: layer and feature imports, public entry points, hermetic tests, console in libraries.
  *(if you were searching for "eslint architecture boundaries")*
- **[playwright-flaky-test-classifier](https://github.com/duke5am/playwright-flaky-test-classifier)** — Turn Playwright's flaky label into a ranked cause: parse JSON run reports and classify each flaky test as timing, ordering, network or test-data.
  *(if you were searching for "playwright flaky tests")*
- **[pr-review-lint](https://github.com/duke5am/pr-review-lint)** — First-pass pull request review driven by your own markdown rules, with a dry-run that shows exactly what it would post before it posts anything.
  *(if you were searching for "automate pr review")*

All 28 tools in this set, grouped by what they check: **[dev-tools-index](https://duke5am.github.io/dev-tools-index/)**

If you arrived here searching for one of these, this is the tool: **remove stale feature flags** · **feature flag cleanup** · **delete launchdarkly flag** · **flag debt codemod**

<!-- RELATED:END -->

→ **[Feature Flag Cleanup Codemods](https://duke5am.gumroad.com/l/28-feature-flag-codemods)** — $29 on Gumroad <!-- GUMROAD-LINK -->

# SAFETY: why this is dangerous work, and how these tools are built for it

A feature flag removal tool is a program that deletes code it did not write, in
a repository it does not understand, on the strength of a fact it learned
somewhere else (the flag's state in your provider). That is a serious thing to
run. This document explains the specific ways it goes wrong, and the specific
mechanisms in this pack that exist to stop each one.

If you read one section, read **"Never let one tool decide and delete"**.

---

## 1. The ways a flag codemod damages a codebase

Not hypotheticals. Each of these has bitten teams that did this work with a
regex, with a script, or with an LLM asked to "remove the flag".

| Failure | What it looks like | Why it happens |
|---|---|---|
| **Deleted a branch that still runs** | The off-branch is gone, but the flag is not actually on for every user, so a segment of traffic loses a feature or hits a crash | The flag's state was inferred from "we rolled it out" rather than read from the provider's targeting rules |
| **Half-removed flag** | The `if` is gone, but a reference survives in a config object, a template string, or a dynamic lookup, so the flag still exists in the provider forever and the code still reads it | The tool only matched the syntaxes it knew and said nothing about the rest |
| **Corrupted syntax** | A file no longer parses; the build breaks; the diff is 400 files so nobody can find it by eye | Text substitution with no parse check |
| **Dropped a side effect** | `if (flag && sendAnalytics())` becomes `if (sendAnalytics())`, or the whole condition is deleted and the call disappears with it | Short-circuit semantics ignored |
| **Changed behaviour while looking like a cleanup** | Both branches assigned the same variable; the tool picked one; the surviving behaviour is subtly different | The tool guessed where the correct answer was a product decision |
| **Silent miss** | The report says "no references left", the flag is deleted in the provider, and one code path still reads it and now gets the SDK's default | The reference was in a form the tool did not recognise, and the tool reported success anyway |
| **Unreviewable diff** | 60 flags removed in one commit across 900 files; review is a rubber stamp; a regression is impossible to bisect | No batching discipline |
| **Stale references in the provider** | Code is clean, but the flag still exists in the dashboard, in everyone's mental model, and in the next migration | Nothing removes the provider-side flag for you |

## 2. Mechanism: dry run by default, and the diff is the interface

Nothing is written unless you pass `--write`. The default output is a unified
diff of every change the tool would make, followed by every refusal and every
advisory. There is also `--check`, which writes nothing and exits 3 when work
is pending, so CI can fail a build that still references a flag you have
retired.

```
node codemods/remove-enabled-flag.js --flag new_dashboard src/
node codemods/remove-enabled-flag.js --flag new_dashboard src/ --write
node codemods/remove-enabled-flag.js --flag new_dashboard src/ --check
```

The pack's test suite asserts that the dry run leaves every byte of the target
tree unchanged (see `tests/*.test.js`, "writes nothing at all").

## 3. Mechanism: refuse rather than corrupt

Every reference to the flag is either rewritten or **refused with a file, a
line, a code and a reason**. There is no third outcome. A refusal never blocks
the rest of the file's safe rewrites unless the reason is structural, and the
exit code tells CI whether anything was refused (exit 2).

The refusal codes, and why each one exists:

| Code | Why the tool will not touch it |
|---|---|
| `DYNAMIC_FLAG_NAME` | A computed lookup (`flags[someName]`) can read *any* flag. When such a lookup and a real reference share a file, the whole file is refused: a partial rewrite would look clean while the dynamic read survived. (If the file has no reference to your flag at all, you get an advisory instead of a refusal, so provider shims do not produce noise on every run.) |
| `LOOP_CONDITION` | The flag gates a loop. If the provider's answer is wrong, removing the gate turns a bounded loop into a hang. Removing an exit condition is the one change that can take down a process rather than a feature. |
| `NON_PURE_CONDITION` | The second operand of `&&` only ran while the flag was on, and it has effects (a call, an await). Deleting the flag deletes the call. This is the classic short-circuit trap. |
| `MULTI_FLAG_CONDITION` | Two flags in one condition. Mechanically removable, but it couples two rollouts: reverting one no longer restores the old behaviour. One flag per change. |
| `UNSUPPORTED_OPERATOR` | `flag \|\| fallback`, `flag === true`, `flag + 1`. What these evaluate to depends on the flag's *runtime value*, which is not always a boolean: providers return variants, strings, numbers and defaults. A text transform cannot know. |
| `FLAG_AS_RIGHT_OPERAND` | `something && flag` — the value also depends on the left-hand side. |
| `FLAG_USED_AS_VALUE` | The flag is assigned, returned, passed or stored rather than tested. Replacing it with `true` is only correct if the flag is a boolean. Rewrite the read (`Boolean(flags.x)`) and re-run, or pass `--assume-boolean` if every flag in your project really is a boolean. |
| `VALUE_CONTEXT_DISABLED` | The value of a disabled flag is used. Disabled is `false` in most SDKs, `"off"` in some, `0` or `undefined` in others. |
| `SHARED_MUTATION` | Both branches write the same binding. The survival of one branch is usually right, but this is a product decision that was maintained by hand in two places. A human confirms it. |
| `LOOP_CARRIED_MUTATION` | The flag sits in a loop and the branch being deleted has effects on state that outlives one iteration. Whether the loop still means the same thing needs whole-function reasoning, which this tool does not attempt. |
| `BLOCK_SCOPE_HOIST` | Unwrapping the conditional would move a `const`/`let`/`class`/`function` declaration out of its block, and that name is declared more than once in the file. |
| `ALIAS_AMBIGUOUS` | The local variable holding the flag is reassigned or redeclared, so treating it as the flag could be wrong. |
| `UNPARSEABLE` | The file could not be tokenized reliably (unbalanced brackets, an unterminated string). Nothing in that file is touched. |
| `VALIDATION_FAILED` | The rewrite was made, then failed to parse, so **the file was restored and nothing was written**. If you ever see this, it is a bug in the pack, not a problem with your code: please report it with the file. |
| `WRAPPER_*` | The wrapper component has several children (hoisting needs a fragment, and where it goes changes layout), a render-prop child (the flag value is consumed by a function), extra props (`fallback`, inverted logic), a non-literal name, or no children at all. |

Four of these have a documented escape hatch — `--allow DYNAMIC_FLAG_NAME`,
`--allow SHARED_MUTATION`, `--allow LOOP_CARRIED_MUTATION`,
`--allow VALUE_CONTEXT_DISABLED`, or `--assume-boolean`. Using one records the
decision in the tool output, and the affected reference is still reported, now
as an advisory. Everything else cannot be relaxed, because the tool has no
idea what the right answer is.

## 4. Mechanism: parse the result before writing it

A codemod bug must not be able to write a file that does not compile. Every
rewrite goes through three checks before a single byte reaches disk:

1. **Bracket balance**, using the same lexer as the transforms, so strings,
   templates, comments and regex literals cannot be mistaken for brackets.
2. **A real parse by V8**, via `node --check`. This never executes your code.
   For `.ts`, type annotations are stripped first using Node's built-in
   `module.stripTypeScriptTypes`. For `.jsx`/`.tsx`, JSX elements are replaced
   by a placeholder so the surrounding JavaScript can be parsed, and every
   `{ ... }` expression container is parsed separately (in an async-function
   wrapper, so `await` inside a container works) — masking the element wholesale
   would otherwise hide a broken expression inside it.
3. **Tag structure** for JSX files: every opening tag matched to its closing
   tag, in order, by this pack's own checker.

If any check fails, the file is returned **unchanged** and a
`VALIDATION_FAILED` refusal is reported. That is why the answer to "what if the
codemod has a bug?" is "then it stops, loudly, on that file".

## 5. Mechanism: one flag per commit

Every tool takes exactly one `--flag`. There is no "remove all stale flags"
mode, by design. A commit that removes one flag can be reviewed by reading one
diff, reverted with one `git revert`, and bisected by one flag name. A commit
that removes forty cannot.

## 6. Mechanism: your tests still have to pass

This tool parses code. It does not run it. A rewrite can be syntactically
perfect and behaviourally wrong — precisely because the premise ("this flag is
permanently on") is an input, not a fact the tool verified.

So `docs/WORKFLOW.md` requires, as a hard step, that you run your own test
suite plus lint/typecheck after `--write` and before committing, and that you
look at what the diff *means* rather than only at whether the build is green.
Advisories such as `DEAD_CODE_AFTER_GUARD` exist to tell you where the tool
removed a guard and left unreachable code behind for you to deal with.

## 7. Never let one tool decide a flag is dead *and* delete it

This is the rule that matters more than every mechanism above.

A tool that both reads the flag's state and removes the code has no independent
check on its own premise. If it reads the provider wrong, or you point it at the
wrong flag name, or the flag is on for 99.8% of traffic rather than 100%, the
code is already gone by the time anybody notices.

The design here splits the decision from the execution:

- **The decision is yours, made from the provider.** This pack never contacts
  your flag provider. It makes no network calls at all. You confirm the flag's
  state in the dashboard or the provider's API, and you tell the tool which
  state it is in (`remove-enabled-flag` vs `remove-disabled-flag`). The tool's
  name for its input is honest: `--flag new_dashboard` plus a mode you chose.
  Nothing about "is this flag dead?" is automated.
- **The execution is the tool's, and it is conservative.** It rewrites the
  syntaxes it can prove, refuses the rest, and refuses the entire file when a
  dynamic lookup means it cannot know the full reference set.
- **The review is yours.** The diff is the artifact a human approves.

Three specific traps this protects you from:

1. **"100% rollout" is not the same as "no longer read".** A flag at 100% can
   still be a kill switch: the on-call engineer's only way to turn a feature
   off during an incident. Removing it removes the switch. Racier still, some
   SDKs return the *default* value when the flag is missing from the payload —
   so deleting the flag in the provider before the code can flip a feature on
   for users whose SDK has a stale payload.
2. **Prerequisites and dependencies.** In LaunchDarkly, Unleash, Split and
   Statsig a flag can depend on another flag, or be evaluated only inside a
   segment. "This flag is on" can mean "on when its prerequisite is on". The
   tool cannot see the dependency graph; you can.
3. **Boolean flags only.** If the flag is multivariate (`control`/`variant-a`),
   the correct removal is not `true`, it is the variant string. The tool refuses
   value positions for exactly this reason, and that refusal is the feature
   doing its job.

The correct order of operations is therefore: **code first, provider last.**
While the flag still exists in the provider, a `git revert` restores the old
behaviour completely. The moment the provider-side flag is deleted, the revert
restores code that reads a flag that is gone — which is usually the old default,
not necessarily the old behaviour. `docs/WORKFLOW.md` walks through this,
including the rollback.

## 8. What to do when the tool refuses

1. Read the code. The refusal names the file and line.
2. Decide which of three things is true: the tool's shape knowledge is
   incomplete (rewrite by hand — it is now one file), the code needs a
   structural change first (rename a shadowed variable, extract the flag read
   into a boolean, replace a computed lookup with a literal), or the premise is
   wrong (this flag is *not* simple to remove, and possibly not dead).
3. Re-run. Refusals that remain after a manual pass are the honest residue:
   work you chose not to do, not work the tool silently skipped.

## 9. Review checklist for a flag-removal commit

- [ ] The flag's state was read from the provider today, not remembered.
- [ ] No pre-existing failing tests before you started (so a failure is
       attributable).
- [ ] `--dry-run` output was read, including every refusal and advisory.
- [ ] Each refusal is either fixed by hand or explicitly deferred, with a note.
- [ ] The diff contains only this flag; no other flag names appear in it.
- [ ] The test suite, lint/typecheck and build pass after `--write`.
- [ ] `DEAD_CODE_AFTER_GUARD` advisories were followed up (unreachable code
       deleted, or left deliberately).
- [ ] Tests that asserted on the flag branch were updated in the *same* commit;
       a test that can no longer fail is worse than no test.
- [ ] The commit message names the flag and its intended state.
- [ ] The provider-side flag is deleted in a *later* step, after the code
       deploy is verified.

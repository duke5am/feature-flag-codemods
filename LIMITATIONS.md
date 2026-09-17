# LIMITATIONS: the honest scope of this pack

Everything below is a real boundary of the implementation, not a disclaimer. If
a limitation here would block your use case, that is worth knowing before you
buy rather than after.

## 1. These are token-level source transforms, not a compiler

There is no type checker, no control-flow analysis, no cross-module reasoning.
The pack lexes your files (`codemods/lib/tokenize.js`), matches the shapes a
flag reference takes, plans byte-range edits, and then verifies the result by
parsing it with V8. It follows references within a single file, and only
within the syntaxes listed in section 3.

Concretely, what that means:

- It does not know whether the branch it keeps is *correct*, only that it is the
  branch the flag now selects.
- It does not follow a flag through your own helper functions. If you wrap the
  SDK (`export const isOn = (n) => sdk.bool(n)`), references through `isOn(...)`
  are invisible unless you teach it with `--function isOn` **and** the argument
  is a string literal in the same file.
- It does not track values across functions, modules, hooks or classes.

## 2. The flag's true state must come from your provider

This pack never contacts your flag provider. It makes no network requests at
all. It is told the state (`remove-enabled-flag` or `remove-disabled-flag`) and
it acts on that input. The premise is yours to verify, and it is the one input
that determines whether the output is correct. `docs/SAFETY.md` section 7
explains why splitting the decision from the execution is deliberate, and
`docs/WORKFLOW.md` step 2 lists what to check in the provider.

Corollaries:

- **Non-boolean values are out of reach.** An "off" flag is `false` in most
  SDKs, `"off"` in some, `0` or `undefined` in others, and a variant name in a
  multivariate setup. The pack refuses every position where the flag's *value*
  is observable (an assignment, a return, an object property, a function
  argument, a template interpolation, `||`, `??`, a comparison, arithmetic).
  Those refusals are the honest answer, not a gap to be worked around —
  `--assume-boolean` exists for teams whose flags are all `true`/`false`, and it
  is an assumption you are making, not one the tool verified.
- **Default values are invisible.** If your SDK is configured with a default per
  flag read (`client.variation('x', false)`), removing the code removes the read
  and the default with it. The pack cannot see your SDK configuration.
- **Targeting rules are invisible.** Prerequisites, segments, individual user
  overrides, experiment traffic and percentage rollouts all live in the
  provider. "On for 100%" may still mean "on when the prerequisite is on".

## 3. Supported syntaxes, and what is refused

Rewritten (when the flag's state makes the branch determinate):

- `if (flag) { A } else { B }` and the no-`else` form, including braceless bodies
- `if (!flag) return X;` early-return guards
- `if (flag && pureExpression)` in an `if` or `while` condition (only truthiness
  is observed, and the rest must be free of effects)
- `flag ? A : B`
- `flag && expression` (statement and value positions)
- `!flag`, `!!flag`
- `while`/`do-while`/`for` headers: **refused**
- wrapper components: `<FeatureFlag name="flag">singleChild</FeatureFlag>`
- HOCs: `withFeatureFlag('flag')(Component)`
- aliases: `const on = useFlag('flag')` and `const { flag } = useFlags()` /
  `const { flag: on } = useFlags()`, when the local is not reassigned and not
  redeclared

Recognised reference forms (the inventory finds all of these):

```
flags.new_dashboard        featureFlags?.new_dashboard     ff["new_dashboard"]
useFlag('new_dashboard')   isFeatureEnabled('new_dashboard', false)
const { new_dashboard } = useFlags()
const { new_dashboard: on } = useFlags()
<FeatureFlag name="new_dashboard">    withFeatureFlag('new_dashboard')(Page)
```

Object roots (`flags`, `featureFlags`, `features`, `ff`, `gates`, `toggles`,
anything ending in `Flags`/`Features`/`Toggles`/`Gates`) and reader functions
(`useFlag`, `useFeatureFlag`, `isFeatureEnabled`, `isFlagEnabled`,
`flagEnabled`, `featureFlagEnabled`, `getFlag`, `getFeatureFlag`,
`getFlagValue`, `featureEnabled`, `useFeature`, `useFlagValue`) are the
defaults. Extend them with `--object`, `--function`, `--component`, `--hoc`,
`--prop`.

**Not supported at all**: `switch (flag)` on the flag value, bitwise operators,
`flag` inside a string in a non-JS file, JSX spread wrappers
(`<FeatureFlag {...props}>`) without a literal `name`, render-prop children,
wrapper children with several sibling elements, and flags read through a
provider client method that is not in the reader list (`ldClient.variation(...)`
is reported as an *unknown API* advisory rather than transformed).

## 4. Dynamic and computed flag names are not handled

```js
flags[flagName]            // computed member
useFlag(someVariable)      // computed argument
const { [key]: value } = useFlags()
```

These cannot be resolved by reading text, and the pack does not try. Where such
a lookup shares a file with a real reference to the flag you are removing, the
**whole file is refused** — a partial rewrite would look clean while the
dynamic lookup survived. Where the file has no other reference, you get an
advisory instead (so a provider shim does not produce a warning on every run).

The practical consequence: an inventory with dynamic lookups is a **lower
bound**. `find-stale-flags` lists those lookups explicitly, with file and line,
so you can review them by hand. Do not treat a flag's absence from the inventory
as proof it is unreferenced.

## 5. JSX is checked in two halves, not parsed as JSX

`node --check` cannot parse JSX, and this pack ships no parser dependency. So
for `.jsx`/`.tsx` files it does this instead:

1. checks every opening tag against its closing tag for balance and nesting,
   with this pack's own checker;
2. replaces each JSX element with a placeholder identifier and parses the
   surrounding JavaScript with V8;
3. parses the contents of each `{ ... }` expression container separately, in an
   async-function wrapper (so `await` inside a container works).

That catches the damage a codemod can realistically do — a dropped closing tag,
a hoisted child that breaks the surrounding expression, a container left
unbalanced. It is not a substitute for your own toolchain:

**Run `tsc`, your bundler, and your linter afterwards.** The workflow in
`docs/WORKFLOW.md` requires it. A JSX element inside a template-literal
interpolation cannot be masked, so such a file fails the parse check and is left
untouched rather than written half-checked.

## 6. Formatting is not preserved perfectly

The transforms preserve untouched bytes exactly, but a rewritten region is
re-emitted from the branch's own text, re-indented to the statement it replaces.
Expect these cosmetic artifacts:

- A template interpolation collapses to `${'new'}` rather than the tidier
  `new`; a formatter removes the braces.
- Deleting a declaration can leave a single blank line behind inside a function
  body.
- A wrapper's children inherit the wrapper's line indentation, which may differ
  from what a human would write.

Run your formatter as part of the workflow. (The test suite asserts indentation
is not *doubled*, which is the failure that makes a diff look untrustworthy.)

## 7. What the pack deliberately will not do

- **Remove more than one flag per run.** `--flag` takes one name. Coupling two
  rollouts into one commit is how a revert stops working.
- **Delete dead code.** When a guard that always returns is hoisted, the
  statements after it become unreachable. The pack reports
  `DEAD_CODE_AFTER_GUARD` and leaves them: deleting code you were not asked
  about is not this tool's job.
- **Fix your lint errors.** Anything your lint rules would catch afterwards —
  unused variables, imports that became unused in a way this pack did not track,
  unreachable code, a hook called conditionally — remains yours to fix. The pack
  prunes the bindings *it* made unused (the flag alias, the destructured flag
  property, the import of the wrapper or reader it removed) and nothing else.
- **Run your tests.** It cannot know whether your off-branch test should now be
  deleted or rewritten.
- **Touch non-JS/TS files.** JSON, YAML, SQL, `.env`, i18n bundles, Terraform and
  documentation are not scanned. A flag name in a config file will survive the
  cleanup, and only `git grep` will find it.
- **Report a flag as gone with confidence.** It reports "no references were
  found *in the files scanned*, in the syntaxes I know". If that is not the same
  statement as "the flag is unused", the difference is on you: see section 4.

## 8. Scale and performance boundaries

- Each file is re-analysed per rewrite pass, and a pass applies as many
  non-overlapping rewrites as it can. Wrapper unwrapping needs one pass per
  nesting level. There is a hard cap of 64 passes per file; a file that hits it
  is reported (a pathological case; the fixtures' nested wrappers need two).
- The diff is Myers' algorithm, so the cost is proportional to the size of the
  change rather than the file. Nothing here is optimised for million-line
  generated files; generated and vendored directories are skipped by default
  (`node_modules`, `dist`, `build`, `out`, `coverage`, `vendor`, and others,
  plus `--ignore`).
- Syntax validation spawns one `node --check` per changed file, and per JSX
  container batch. On a very large change set, expect the validation step to
  dominate the runtime.

## 9. Test coverage of this pack, so you know what is verified

The suite (84 tests, 242 assertions, 13 suites) verifies, against a fixture project
that contains every supported shape plus the deliberately hard cases:

- exact byte-for-byte output for five different flag-removal runs (golden
  files in `tests/expected/`);
- that every rewritten file parses, re-checked from disk;
- that hard cases are left byte-identical with a file-and-line refusal;
- that a dry run writes nothing, for every tool;
- that a run changes exactly the files it reports as changed;
- that a second run finds nothing to do (idempotence);
- that the pack has no dependencies: every import is relative or `node:`;
- that a rewrite that fails validation is reverted, not written.

What the suite does **not** verify: your syntax. The fixture uses CommonJS-free
ESM, no decorators, no TypeScript-only constructs in the transform path, and one
JSX dialect. Always run the dry run against your own codebase first — that is
what it is for.

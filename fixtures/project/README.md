# Fixture: acme-console

A small, deliberately ordinary web app used by the test suite of
**Feature Flag Cleanup Codemods**. It is not a real product and it has no
dependencies: every module below exists to exercise one shape of feature flag
usage.

Flags in play:

| flag              | state | why it is here |
|-------------------|-------|----------------|
| `new_dashboard`   | ON    | the happy path: if/else, ternary, `&&`, guard clauses, template interpolation, wrapper components, a `useFlag()` alias and a destructured binding |
| `legacy_checkout` | OFF   | the mirror image, plus value-position cases that must be refused |
| `beta_exports`    | ON    | destructured and aliased flag bindings that become unused after the rewrite |
| `smart_search`    | ON    | referenced through a computed name, so the codemods must refuse the file |
| `old_banner`      | ON    | a single reference, the kind of flag a team should remove first |

The files under `src/hard/` are the negative controls. Every one of them is a
case where a mechanical rewrite is either provably unsafe or a judgement call,
and the codemod is required to leave the file alone and say why. If a future
change to these codemods starts "helpfully" rewriting those files, the test
suite fails.

`src/hard/dynamic-name.js` is special: it contains a computed flag lookup
(`flags[computedName]`), which means the complete set of references cannot be
known statically. The codemods refuse that entire file, including the
references in it that they could otherwise have rewritten.

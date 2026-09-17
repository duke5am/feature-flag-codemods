/**
 * analyze.js -- decide what to do with every reference to one flag.
 *
 * Part of Feature Flag Cleanup Codemods.
 *
 * For a file and a flag this module produces two lists:
 *
 *   sites    -- rewrites that are provably safe, as { start, end, replacement }
 *   refusals -- references this tool will NOT touch, each with a code, a
 *               human-readable reason, and the line where it was found
 *
 * The refusals are the point of the product. A codemod that guesses on a hard
 * case is worse than no codemod: the damage arrives as a diff that "looks
 * fine" and surfaces in production weeks later. Every refusal below is either
 * a case this tool cannot prove safe, or a case where the rewrite is probably
 * right but a human should confirm the intent.
 */

import { meaningful, collectTokens, lineIndex, lineCol, tokenize, matchBalanced } from './tokenize.js';
import {
  buildIndex, parseIfStatement, statementRange, lexicalContext, mutationTargets,
  impurity, needsParens, indentAt, reindent, isBlank, commentsIn, declaredNames,
  ASSIGN_OPERATORS, enclosingGroups,
} from './scan.js';
import { findFlagReferences, defaultConfig, isObjectRoot, literalNameAt } from './flags.js';

/** Refusal codes. `downgradable` marks review gates that `--allow` may relax. */
export const REFUSALS = {
  UNPARSEABLE: { downgradable: false, meaning: 'the file could not be tokenized reliably' },
  DYNAMIC_FLAG_NAME: { downgradable: true, meaning: 'a flag name is computed at runtime, so the set of references cannot be known' },
  LOOP_CONDITION: { downgradable: false, meaning: 'the flag gates a loop; removing the gate can turn a bounded loop into a hang' },
  NON_PURE_CONDITION: { downgradable: false, meaning: 'the condition has effects, so removing it would change behaviour' },
  UNSUPPORTED_CONDITION: { downgradable: false, meaning: 'the condition is not a shape this tool rewrites' },
  MULTI_FLAG_CONDITION: { downgradable: false, meaning: 'more than one flag is involved; remove one flag per change' },
  UNSUPPORTED_OPERATOR: { downgradable: false, meaning: 'the flag is combined with an operator this tool does not rewrite' },
  FLAG_AS_RIGHT_OPERAND: { downgradable: false, meaning: 'the flag is the right-hand operand of an expression' },
  FLAG_USED_AS_VALUE: { downgradable: true, meaning: 'the flag value is used, not merely tested' },
  VALUE_CONTEXT_DISABLED: { downgradable: true, meaning: 'the expression value is observable and the disabled flag value is not statically known' },
  SHARED_MUTATION: { downgradable: true, meaning: 'both branches write the same binding' },
  LOOP_CARRIED_MUTATION: { downgradable: true, meaning: 'a branch writes state that outlives one loop iteration' },
  BLOCK_SCOPE_HOIST: { downgradable: false, meaning: 'hoisting the branch would move a declaration out of its block' },
  TERNARY_SHAPE: { downgradable: false, meaning: 'the conditional expression could not be delimited' },
  ALIAS_AMBIGUOUS: { downgradable: false, meaning: 'the local variable holding the flag is reassigned or redeclared' },
  VALIDATION_FAILED: { downgradable: false, meaning: 'the rewrite did not parse; the file was left untouched' },
  WRAPPER_NO_CHILDREN: { downgradable: false, meaning: 'the wrapper has no children to hoist' },
  WRAPPER_MULTIPLE_CHILDREN: { downgradable: false, meaning: 'the wrapper has several children; hoisting them needs a fragment this tool will not invent' },
  WRAPPER_EXTRA_PROPS: { downgradable: false, meaning: 'the wrapper carries other props whose semantics are unknown' },
  WRAPPER_DYNAMIC_NAME: { downgradable: false, meaning: 'the wrapper flag name is not a literal' },
  WRAPPER_SHAPE: { downgradable: false, meaning: 'the wrapper usage is not a shape this tool rewrites' },
};

/** Default prop names that carry a flag name on a wrapper component. */
export const DEFAULT_WRAPPER_PROPS = ['name', 'flag', 'flagName', 'feature', 'flagKey'];

/* -------------------------------------------------------------------------
 * Expression extent helpers
 * ---------------------------------------------------------------------- */

/** Tokens that end a `&&`-level expression (precedence lower than `&&`). */
const LOW_PRECEDENCE = new Set([
  '||', '??', '?', ':', ',', ';', ')', ']', '}', '=>',
  ...ASSIGN_OPERATORS,
]);

/** Last token index of the `&&`-level expression beginning at `startIdx`. */
function expressionEnd(index, startIdx) {
  const toks = index.toks;
  let last = startIdx;
  for (let j = startIdx; j < toks.length; j += 1) {
    const t = toks[j];
    if (t.type === 'punct') {
      if (t.value === '(' || t.value === '[' || t.value === '{') {
        const m = index.open.get(j);
        if (m !== undefined) {
          last = m;
          j = m;
          continue;
        }
      }
      if (LOW_PRECEDENCE.has(t.value)) break;
    }
    last = j;
  }
  return last;
}

/** Last token index of a ternary alternate (extends as far right as possible). */
function alternateEnd(index, startIdx) {
  const toks = index.toks;
  let last = startIdx;
  for (let j = startIdx; j < toks.length; j += 1) {
    const t = toks[j];
    if (t.type === 'punct') {
      if (t.value === '(' || t.value === '[' || t.value === '{') {
        const m = index.open.get(j);
        if (m !== undefined) {
          last = m;
          j = m;
          continue;
        }
      }
      if ([';', ',', ')', ']', '}', '=>'].includes(t.value)) break;
      if (ASSIGN_OPERATORS.has(t.value)) break;
    }
    last = j;
  }
  return last;
}

/** Index of the `:` matching the ternary `?` at `questionIdx`, or -1. */
function matchingColon(index, questionIdx) {
  const toks = index.toks;
  let depth = 0;
  for (let j = questionIdx + 1; j < toks.length; j += 1) {
    const t = toks[j];
    if (t.type !== 'punct') continue;
    if (t.value === '(' || t.value === '[' || t.value === '{') {
      const m = index.open.get(j);
      if (m !== undefined) {
        j = m;
        continue;
      }
    }
    if (t.value === ';') return -1;
    if (t.value === '?') depth += 1;
    else if (t.value === ':') {
      if (depth === 0) return j;
      depth -= 1;
    }
  }
  return -1;
}

/** Strip redundant parentheses around a token range. */
function stripParens(index, startIdx, endIdx) {
  let s = startIdx;
  let e = endIdx;
  while (
    index.toks[s] && index.toks[s].type === 'punct' && index.toks[s].value === '(' &&
    index.open.get(s) === e
  ) {
    s += 1;
    e -= 1;
  }
  return { startIdx: s, endIdx: e };
}

/* -------------------------------------------------------------------------
 * Removal analysis (remove-enabled-flag / remove-disabled-flag)
 * ---------------------------------------------------------------------- */

const HEADER_KEYWORDS = new Set(['if', 'while', 'for', 'do', 'switch', 'with']);

/**
 * @param {string} src
 * @param {object} opts
 * @param {string} opts.flag
 * @param {'on'|'off'} opts.mode  'on' = flag permanently enabled
 * @param {object} [opts.config]
 * @param {Set<string>} [opts.allowed] refusal codes relaxed by --allow
 * @param {boolean} [opts.assumeBoolean]
 * @param {string} [opts.file] for messages
 */
export function analyzeFlagRemoval(src, opts) {
  const config = opts.config || defaultConfig();
  const allowed = opts.allowed || new Set();
  const mode = opts.mode;

  const toks = meaningful(collectTokens(src));
  const index = buildIndex(toks);
  const lines = lineIndex(src);

  const refusals = [];
  const advisories = [];
  const sites = [];

  const refuse = (code, message, offset, extra = {}) => {
    const at = lineCol(lines, offset);
    const entry = {
      code,
      message,
      line: at.line,
      column: at.column,
      offset,
      file: opts.file,
      downgradable: REFUSALS[code] ? REFUSALS[code].downgradable : false,
      relaxed: allowed.has(code),
      ...extra,
    };
    refusals.push(entry);
    return null;
  };
  const advise = (code, message, offset) => {
    const at = lineCol(lines, offset);
    advisories.push({ code, message, line: at.line, column: at.column, offset, file: opts.file });
  };

  const { tokens: rawTokens, errors: lexErrors } = tokenize(src);
  for (const e of lexErrors) refuse('UNPARSEABLE', `lexer: ${e.message}`, e.offset);
  if (rawTokens.length && !allGroupsClosed(index)) {
    refuse('UNPARSEABLE', 'unbalanced brackets; refusing to rewrite this file', 0);
  }

  const refs = findFlagReferences(index, opts.flag, config, src);
  const declared = declaredNames(index);

  // Dynamic names: the set of references is not knowable, so nothing is safe.
  //
  // If the file also holds a reference to the flag we were asked to remove, the
  // whole file is refused. If it holds none, the file would not have been edited
  // anyway, so it is reported as an advisory instead of a refusal -- otherwise
  // every provider shim in the repository would produce noise on every run, and
  // a warning that is always present is a warning nobody reads.
  const hasStaticRefs = refs.static.length > 0;
  for (const d of refs.dynamic) {
    if (allowed.has('DYNAMIC_FLAG_NAME')) {
      advise('DYNAMIC_FLAG_NAME', `${d.reason}; continuing because --allow DYNAMIC_FLAG_NAME was given, so references may remain`, d.start);
      continue;
    }
    if (!hasStaticRefs) {
      advise(
        'DYNAMIC_LOOKUP_PRESENT',
        `${d.reason}. This file has no other reference to "${opts.flag}", so it is left untouched -- but that lookup may still read the flag you are removing.`,
        d.start,
      );
      continue;
    }
    refuse(
      'DYNAMIC_FLAG_NAME',
      `${d.reason}. Because the name is computed (${JSON.stringify(d.value)}), this tool cannot prove that no reference to "${opts.flag}" is left behind, so it will not rewrite this file -- not even the references in it that it could resolve. Replace this lookup with a literal first, or pass --allow DYNAMIC_FLAG_NAME to rewrite the resolvable references anyway.`,
      d.start,
    );
  }
  for (const a of refs.advisories) advise('UNKNOWN_API', a.message, a.start);

  // ---------------------------------------------------------------- aliases
  const aliasMap = new Map(); // local name -> { name, kind, ... }
  const aliasInitializerIdx = new Set();
  const aliasDecls = [];

  for (const a of refs.aliases) {
    if (!a.singleDeclarator) continue;
    const decls = declared.get(a.name) || [];
    if (decls.length !== 1) {
      refuse('ALIAS_AMBIGUOUS', `the local variable "${a.name}" that holds the flag is declared ${decls.length} times (shadowing); resolve this by hand`, a.nameStart);
      continue;
    }
    if (isMutated(index, a.name)) {
      refuse('ALIAS_AMBIGUOUS', `the local variable "${a.name}" that holds the flag is reassigned elsewhere; resolve this by hand`, a.nameStart);
      continue;
    }
    const stmt = statementRange(index, a.startIdx);
    const record = {
      name: a.name,
      kind: 'variable',
      nameIdx: a.nameIdx,
      declStart: stmt.start,
      declEnd: stmt.end,
    };
    aliasMap.set(a.name, record);
    aliasDecls.push(record);
    aliasInitializerIdx.add(a.refStartIdx);
  }

  for (const d of refs.destructured) {
    for (const r of refs.static) {
      if (r.form !== 'destructured') continue;
      if (r.start < d.start || r.end > d.end) continue;
      const local = r.local;
      if (!local) continue;
      const decls = declared.get(local) || [];
      if (decls.length !== 1) {
        refuse('ALIAS_AMBIGUOUS', `the destructured flag binding "${local}" is declared ${decls.length} times (shadowing); resolve this by hand`, r.start);
        continue;
      }
      if (isMutated(index, local)) {
        refuse('ALIAS_AMBIGUOUS', `the destructured flag binding "${local}" is reassigned; resolve this by hand`, r.start);
        continue;
      }
      const stmt = statementRange(index, d.startIdx);
      const record = {
        name: local,
        kind: 'destructured',
        propStart: r.start,
        propEnd: r.end,
        propIdx: r.startIdx,
        statementStart: stmt.start,
        statementEnd: stmt.end,
        declarationStartIdx: d.startIdx,
        braceOpenIdx: d.braceOpenIdx,
        braceCloseIdx: d.braceCloseIdx,
        // Names bound by the same pattern that are not the flag. The prune step
        // must never delete a declaration that still feeds one of these.
        otherNames: [...new Set(refs.static
          .filter((o) => o.form === 'destructured' && o.start >= d.start && o.end <= d.end && o.local && o.local !== local)
          .map((o) => o.local))],
      };
      aliasMap.set(local, record);
      aliasDecls.push(record);
      aliasInitializerIdx.add(r.startIdx);
    }
  }

  // ---------------------------------------------- references to be rewritten
  const refsToClassify = [];
  for (const r of refs.static) {
    if (r.form === 'destructured') continue; // handled by the alias/prune path
    if (aliasInitializerIdx.has(r.startIdx)) continue; // declaration site
    refsToClassify.push(r);
  }
  for (const [name, record] of aliasMap) {
    for (const use of aliasUseRefs(index, name, record)) refsToClassify.push(use);
  }
  refsToClassify.sort((a, b) => a.start - b.start);

  const ctx = {
    mode,
    config,
    allowed,
    allowBoolean: Boolean(opts.assumeBoolean) || allowed.has('FLAG_USED_AS_VALUE'),
    refs: { static: refsToClassify },
    declared,
    flag: opts.flag,
    file: opts.file,
  };

  for (const ref of refsToClassify) {
    const plan = classify(index, src, ref, ctx, refuse, advise);
    if (plan) sites.push(plan);
  }

  return {
    flag: opts.flag,
    mode,
    sites,
    refusals,
    advisories,
    refs,
    aliasMap,
    aliasDecls,
    destructuring: refs.destructured,
  };
}

/** All identifier uses of an alias local, excluding property accesses/keys. */
function aliasUseRefs(index, name, record) {
  const toks = index.toks;
  const out = [];
  for (let i = 0; i < toks.length; i += 1) {
    const t = toks[i];
    if (t.type !== 'ident' || t.value !== name) continue;
    if (record.nameIdx !== undefined && i === record.nameIdx) continue;
    if (record.propIdx !== undefined && i === record.propIdx) continue;
    const prev = toks[i - 1];
    const next = toks[i + 1];
    if (prev && prev.type === 'punct' && (prev.value === '.' || prev.value === '?.')) continue;
    if (next && next.type === 'punct' && next.value === ':') continue; // object key or label
    if (prev && prev.type === 'punct' && prev.value === '{') continue; // shorthand key in a fresh object
    out.push({ form: 'alias-use', alias: name, start: t.start, end: t.end, startIdx: i, endIdx: i });
  }
  return out;
}

function allGroupsClosed(index) {
  const toks = index.toks;
  for (let i = 0; i < toks.length; i += 1) {
    const t = toks[i];
    if (t.type !== 'punct') continue;
    if ((t.value === '(' || t.value === '{' || t.value === '[') && !index.open.has(i)) return false;
  }
  return true;
}

function isMutated(index, name) {
  const toks = index.toks;
  for (let i = 0; i < toks.length; i += 1) {
    const t = toks[i];
    if (t.type !== 'punct') continue;
    if (t.value === '++' || t.value === '--') {
      const before = toks[i - 1];
      const after = toks[i + 1];
      if ((before && before.type === 'ident' && before.value === name) ||
          (after && after.type === 'ident' && after.value === name)) return true;
      continue;
    }
    if (!ASSIGN_OPERATORS.has(t.value)) continue;
    const prev = toks[i - 1];
    if (!(prev && prev.type === 'ident' && prev.value === name)) continue;
    // `const name = ...` initialises the binding; it does not mutate it.
    const beforePrev = toks[i - 2];
    if (beforePrev && beforePrev.type === 'ident' && ['const', 'let', 'var'].includes(beforePrev.value)) continue;
    return true;
  }
  return false;
}

/* -------------------------------------------------------------------------
 * Classification of a single reference
 * ---------------------------------------------------------------------- */

function classify(index, src, ref, ctx, refuse, advise) {
  const toks = index.toks;
  const { mode } = ctx;
  const describe = ref.alias ? `local alias "${ref.alias}" of the flag` : 'the flag';

  // Unary `!` chain in front of the reference.
  let negCount = 0;
  let coreStart = ref.startIdx;
  while (coreStart - 1 >= 0 && toks[coreStart - 1].type === 'punct' && toks[coreStart - 1].value === '!') {
    negCount += 1;
    coreStart -= 1;
  }
  const coreEnd = ref.endIdx;

  // Widen over enclosing parentheses: `if ((flags.x))`, `(flags.x) ? a : b`.
  let ws = coreStart;
  let we = coreEnd;
  while (
    toks[ws - 1] && toks[ws - 1].type === 'punct' && toks[ws - 1].value === '(' &&
    index.open.get(ws - 1) === we + 1
  ) {
    ws -= 1;
    we += 1;
  }

  const truthy = (negCount % 2 === 0) === (mode === 'on');
  const exactBoolean = negCount % 2 === 1;
  const before = toks[ws - 1];
  const after = toks[we + 1];

  // A reference inside a `for (...)` / `while (...)` / `do ... while (...)`
  // header is refused before anything else: those headers are not statements
  // that can be deleted, and removing a loop's exit gate can hang a process.
  const groups = enclosingGroups(index, toks[coreStart].start);
  const innermost = groups.length ? groups[groups.length - 1] : null;
  if (innermost && innermost.label === 'loop-header') {
    return refuse(
      'LOOP_CONDITION',
      `${describe} is part of a loop header (${toks[innermost.openIdx - 1] ? toks[innermost.openIdx - 1].value : 'loop'}). Removing a loop's gate can turn a bounded loop into a hang if the provider state is wrong, so loops are refused on purpose -- rewrite this one by hand.`,
      toks[coreStart].start,
    );
  }

  // -------------------------------------- if / while / switch header
  let condOpenIdx = -1;
  let condCloseIdx = -1;
  let headerKeyword = null;
  if (before && before.type === 'ident' && HEADER_KEYWORDS.has(before.value)) {
    // Widening pulled the range out to the condition's own parentheses.
    condOpenIdx = ws;
    condCloseIdx = index.open.get(ws);
    headerKeyword = before.value;
  } else if (before && before.type === 'punct' && before.value === '(') {
    const kw = toks[ws - 2];
    if (kw && kw.type === 'ident' && HEADER_KEYWORDS.has(kw.value)) {
      condOpenIdx = ws - 1;
      condCloseIdx = index.open.get(condOpenIdx);
      headerKeyword = kw.value;
    }
  }
  if (headerKeyword && condOpenIdx !== -1 && condCloseIdx !== undefined) {
    return planHeader(index, src, ref, {
      ...ctx, ws, we, coreStart, coreEnd, truthy, exactBoolean,
      keyword: headerKeyword, condOpenIdx, condCloseIdx,
    }, refuse, advise, describe);
  }

  // ---------------------------------------------------------------- ternary
  if (after && after.type === 'punct' && after.value === '?') {
    return planTernary(index, src, ref, { ...ctx, ws, we, truthy }, refuse, describe);
  }

  // ----------------------------------------------------------- logical and
  if (after && after.type === 'punct' && after.value === '&&') {
    return planLogicalAnd(index, src, ref, { ...ctx, ws, we, truthy, exactBoolean }, refuse, describe);
  }

  // --------------------------------------------------------- other operators
  if (after && after.type === 'punct' && (after.value === '||' || after.value === '??')) {
    return refuse(
      'UNSUPPORTED_OPERATOR',
      `${describe} is combined with ${after.value}. A flag's runtime value is not always a boolean (providers return variants, strings and defaults), so the value of this expression cannot be reduced mechanically.`,
      toks[ws].start,
    );
  }
  if (after && after.type === 'punct' && ['==', '===', '!=', '!==', '<', '>', '<=', '>='].includes(after.value)) {
    return refuse(
      'UNSUPPORTED_OPERATOR',
      `${describe} is compared with ${after.value}. Whether the comparison survives depends on the flag's runtime type, which this tool does not read from your provider.`,
      toks[ws].start,
    );
  }
  if (after && after.type === 'punct' && ['+', '-', '*', '/', '%'].includes(after.value)) {
    return refuse(
      'UNSUPPORTED_OPERATOR',
      `${describe} is used in arithmetic (${after.value}); this tool only rewrites boolean positions.`,
      toks[ws].start,
    );
  }
  if (before && before.type === 'punct' && before.value === '&&') {
    return refuse(
      'FLAG_AS_RIGHT_OPERAND',
      `${describe} is the right-hand operand of &&, so the value of this expression also depends on the left-hand side.`,
      toks[ws].start,
    );
  }
  if (before && before.type === 'punct' && before.value === '!') {
    return refuse('UNSUPPORTED_CONDITION', `unexpected unary ! before ${describe}`, toks[ws].start);
  }

  // ------------------------------------------------------ statement position
  const stmt = wholeExpressionStatement(index, ws, we);
  if (stmt) {
    const del = expandStatementDeletion(src, stmt.start, stmt.end);
    return {
      start: del.start,
      end: del.end,
      replacement: '',
      kind: 'delete-no-effect-statement',
      deleteStatement: true,
      note: 'the expression is a whole statement and its value is discarded',
    };
  }

  // ---------------------------------------------------------- value position
  if (exactBoolean) {
    return {
      start: toks[ws].start,
      end: toks[we].end,
      replacement: truthy ? 'true' : 'false',
      kind: 'replace-with-boolean',
      note: `a negated flag is exactly boolean, so ${describe} becomes ${truthy ? 'true' : 'false'}`,
    };
  }
  if (ctx.allowBoolean) {
    return {
      start: toks[ws].start,
      end: toks[we].end,
      replacement: truthy ? 'true' : 'false',
      kind: 'replace-with-boolean-assumed',
      note: `assumes the flag is a boolean (--assume-boolean): ${describe} becomes ${truthy ? 'true' : 'false'}`,
    };
  }
  return refuse(
    'FLAG_USED_AS_VALUE',
    `${describe} is used here as a value rather than only tested: it is assigned, returned, passed or stored, so the replacement depends on the flag's runtime type (many providers return "on"/"off", variants or defaults). Convert it to a boolean where the flag is read (Boolean(flags.x)) and run this codemod again, or pass --assume-boolean if every flag in your project is a boolean.`,
    toks[ws].start,
  );
}

/** `if (...)`, `while (...)`, `for (...)`, `do`, `switch (...)` headers. */
function planHeader(index, src, ref, ctx, refuse, advise, describe) {
  const toks = index.toks;
  const { coreStart, coreEnd, truthy, keyword, mode, condOpenIdx, condCloseIdx } = ctx;

  if (keyword === 'while' || keyword === 'for' || keyword === 'do') {
    return refuse(
      'LOOP_CONDITION',
      `${describe} gates a ${keyword === 'do' ? 'do/while' : keyword} loop. If the provider's state is wrong, or the flag is read again by something else, removing this gate turns a bounded loop into a hang. Loops are refused on purpose -- rewrite this one by hand.`,
      toks[coreStart].start,
    );
  }
  if (keyword === 'switch' || keyword === 'with') {
    return refuse('UNSUPPORTED_CONDITION', `${describe} appears in a ${keyword} header`, toks[coreStart].start);
  }

  // keyword === 'if'
  const inner = stripParens(index, condOpenIdx + 1, condCloseIdx - 1);
  const soleCondition = inner.startIdx === coreStart && inner.endIdx === coreEnd;

  if (!soleCondition) {
    return planCompoundCondition(index, src, ref, ctx, refuse, advise, describe);
  }

  const ifIdx = condOpenIdx - 1;
  const stmt = parseIfStatement(index, ifIdx);
  if (!stmt) {
    return refuse('UNSUPPORTED_CONDITION', 'could not delimit this if-statement', toks[coreStart].start);
  }

  const taken = truthy ? stmt.consequent : stmt.alternate;
  const dropped = truthy ? stmt.alternate : stmt.consequent;

  // ------------------------------------------------- review gate: mutation
  if (dropped) {
    const keptMut = mutationTargets(index, taken ? taken.startIdx : stmt.consequent.startIdx, taken ? taken.endIdx : stmt.consequent.endIdx);
    const dropMut = mutationTargets(index, dropped.startIdx, dropped.endIdx);
    const shared = [...keptMut].filter((n) => dropMut.has(n));
    if (shared.length) {
      if (!ctx.allowed.has('SHARED_MUTATION')) {
        return refuse(
          'SHARED_MUTATION',
          `both branches of this if write ${shared.map((n) => `"${n}"`).join(', ')}. The surviving branch is probably correct, but the two branches were maintained in parallel, so a human should confirm which one is the intended final state. Pass --allow SHARED_MUTATION to rewrite it anyway.`,
          toks[coreStart].start,
          { details: { shared } },
        );
      }
      advise('SHARED_MUTATION', `both branches write ${shared.map((n) => `"${n}"`).join(', ')}; rewritten because --allow SHARED_MUTATION was given`, toks[coreStart].start);
    }
  }

  // ------------------------------------------ review gate: loop-carried state
  const lexCtx = lexicalContext(index, ifIdx);
  let loopMutated = [];
  if (lexCtx.inLoop && dropped) {
    const loopStart = lexCtx.loopOpenIdx !== null ? toks[lexCtx.loopOpenIdx].start : 0;
    const declared = ctx.declared;
    const outerDeclared = (name) => {
      const decls = declared.get(name.split('.')[0]) || [];
      return decls.some((off) => off < loopStart);
    };
    const dropMut = mutationTargets(index, dropped.startIdx, dropped.endIdx);
    loopMutated = [...dropMut].filter(outerDeclared);
    const dropImp = impurity(toks.slice(dropped.startIdx, dropped.endIdx + 1), {
      allowCalls: new Set(ctx.config.flagFunctions),
    });
    if (loopMutated.length && dropImp.impure) {
      if (!ctx.allowed.has('LOOP_CARRIED_MUTATION')) {
        return refuse(
          'LOOP_CARRIED_MUTATION',
          `this flag sits inside a loop and the branch it would delete has effects on state that outlives one iteration (${loopMutated.map((n) => `"${n}"`).join(', ')}: ${dropImp.reasons.join(', ')}). Whether the loop still behaves the same after the branch is gone needs whole-function reasoning, which this tool does not attempt. Pass --allow LOOP_CARRIED_MUTATION to rewrite it anyway.`,
          toks[coreStart].start,
          { details: { carried: loopMutated, reasons: dropImp.reasons } },
        );
      }
      advise('LOOP_CARRIED_MUTATION', `deleted a loop-body branch with effects on ${loopMutated.map((n) => `"${n}"`).join(', ')}; --allow LOOP_CARRIED_MUTATION was given`, toks[coreStart].start);
    }
  }

  // ------------------------------------------- review gate: block hoisting
  if (taken && taken.kind === 'block') {
    const hoist = hoistedDeclarations(index, taken);
    const collisions = hoist.filter((name) => (ctx.declared.get(name) || []).length > 1);
    if (collisions.length) {
      return refuse(
        'BLOCK_SCOPE_HOIST',
        `removing this if-statement would move the declaration of ${collisions.map((n) => `"${n}"`).join(', ')} out of its block, and ${collisions.length === 1 ? 'that name is' : 'those names are'} declared more than once in this file. Rename or restructure first.`,
        toks[coreStart].start,
        { details: { collisions } },
      );
    }
  }

  if (dropped) {
    const comments = commentsIn(src, dropped.start, dropped.end);
    if (comments.length) {
      advise('COMMENT_REMOVED', `removing the dead branch also removes ${comments.length} comment(s): ${comments.slice(0, 3).map((c) => JSON.stringify(c)).join(', ')}`, dropped.start);
    }
  }

  // ------------------------------------------------------------ the rewrite
  if (!taken || isBlank(src.slice(taken.innerStart, taken.innerEnd))) {
    const del = expandStatementDeletion(src, stmt.start, stmt.end);
    return {
      start: del.start,
      end: del.end,
      replacement: '',
      kind: 'delete-if-statement',
      deleteStatement: true,
      note: `the ${truthy ? 'then' : 'else'} branch is taken and is empty, and there is no other branch`,
    };
  }

  const hoisted = hoistPlan(src, stmt, taken);
  if (hoisted) {
    // Honesty about what is left behind: turning `if (!flag) return X; rest;`
    // into `return X; rest;` makes `rest` unreachable. Removing the flag is
    // correct, but the caller should know the dead code is still there.
    const following = toks[stmt.endIdx + 1];
    if (
      branchAlwaysExits(index, taken) &&
      following &&
      !(following.type === 'punct' && (following.value === '}' || following.value === ')' || following.value === ';'))
    ) {
      advise(
        'DEAD_CODE_AFTER_GUARD',
        'the branch that now always runs ends in a return/throw/break/continue, so the statements after it in this block can no longer execute. Your linter will flag them; this codemod does not delete code it was not asked about.',
        toks[stmt.endIdx].end,
      );
    }
    return { ...hoisted, kind: 'unwrap-if-statement', mode, note: truthy
      ? 'kept the then-branch, deleted the else-branch'
      : 'kept the else-branch, deleted the then-branch' };
  }
  return null;
}

/** Does the branch text end with a statement that always leaves the block? */
function branchAlwaysExits(index, branch) {
  const toks = index.toks;
  const inner = toks.slice(branch.startIdx, branch.endIdx + 1).filter((t) => t.start >= branch.innerStart);
  if (!inner.length) return false;
  // Walk back over trailing `;` / `}` and find the statement's first keyword.
  let i = inner.length - 1;
  while (i >= 0 && inner[i].type === 'punct' && (inner[i].value === ';' || inner[i].value === '}')) i -= 1;
  if (i < 0) return false;
  const last = inner[i];
  if (last.type === 'ident' && ['return', 'throw', 'break', 'continue'].includes(last.value)) return true;
  // `return foo()` / `return;` -- find the start of the last line of the branch.
  const lineStartToken = [...inner].reverse().find(
    (t) => t.type === 'ident' && ['return', 'throw', 'break', 'continue'].includes(t.value),
  );
  if (!lineStartToken) return false;
  const idx = inner.indexOf(lineStartToken);
  // Only count it when everything after it is part of the same expression.
  for (let k = idx + 1; k < inner.length; k += 1) {
    if (inner[k].type === 'punct' && inner[k].value === ';') continue;
    if (inner[k].type === 'ident' && ['if', 'for', 'while', 'const', 'let', 'var', 'function'].includes(inner[k].value)) return false;
  }
  return true;
}

/**
 * Replace an if-statement with the text of the branch that survives.
 *
 * When the if-statement starts its own line, the replacement consumes that
 * line's indentation and re-indents the branch to match; otherwise the branch
 * is inserted where it stands with no indentation added, which is what an
 * inline `if` needs.
 */
function hoistPlan(src, stmt, taken) {
  if (!taken) return null;
  const lineStart = src.lastIndexOf('\n', stmt.start - 1) + 1;
  const prefix = src.slice(lineStart, stmt.start);
  const ownLine = /^[ \t]*$/.test(prefix);
  const indent = ownLine ? prefix : '';
  const body = reindent(src.slice(taken.innerStart, taken.innerEnd), indent);
  return {
    start: ownLine ? lineStart : stmt.start,
    end: stmt.end,
    replacement: body,
    deleteStatement: false,
  };
}

/**
 * `if (FLAG && rest)` -- provably safe when the flag is truthy and `rest` is
 * pure, because only the truthiness of the whole condition is observed.
 * `if (FLAG && compute())` is refused: dropping the flag would drop the call.
 */
function planCompoundCondition(index, src, ref, ctx, refuse, advise, describe) {
  const toks = index.toks;
  const { coreStart, coreEnd, truthy, keyword, condOpenIdx, condCloseIdx } = ctx;

  const beforeFlag = toks.slice(condOpenIdx + 1, coreStart);
  if (beforeFlag.length) {
    return refuse('UNSUPPORTED_CONDITION', `${describe} is not the first test in this condition`, toks[coreStart].start);
  }
  const op = toks[coreEnd + 1];
  if (!(op && op.type === 'punct' && op.value === '&&')) {
    return refuse(
      'UNSUPPORTED_CONDITION',
      `this ${keyword} condition combines ${describe} with ${op ? `"${op.value}"` : 'something'} that this tool does not rewrite.`,
      toks[coreStart].start,
    );
  }
  const rhsStart = coreEnd + 2;
  const rhsEnd = expressionEnd(index, rhsStart);
  const rhsToks = toks.slice(rhsStart, rhsEnd + 1);
  const trailing = toks.slice(rhsEnd + 1, condCloseIdx);
  if (!rhsToks.length) {
    return refuse('UNSUPPORTED_CONDITION', 'this && has no right-hand side', toks[coreStart].start);
  }
  if (referencesOtherFlag(rhsToks, ctx)) {
    return refuse(
      'MULTI_FLAG_CONDITION',
      `this condition combines more than one feature flag. Remove one flag per change, so that a revert reverts exactly one thing.`,
      toks[coreStart].start,
    );
  }
  if (trailing.length) {
    return refuse('UNSUPPORTED_CONDITION', `this condition has more than one test after ${describe}`, toks[coreStart].start);
  }
  if (!truthy) {
    return refuse(
      'UNSUPPORTED_CONDITION',
      `${describe} is the first test of a compound condition and is now false, so the whole condition is false and the block is dead. This tool will not delete the enclosing ${keyword} for you: the block may be documenting intent, and deleting it is a judgement call. Do that by hand.`,
      toks[coreStart].start,
    );
  }
  const imp = impurity(rhsToks, { allowCalls: new Set(ctx.config.flagFunctions) });
  if (imp.impure) {
    return refuse(
      'NON_PURE_CONDITION',
      `removing ${describe} from this condition would also remove the effects that follow it (${imp.reasons.join(', ')}). This is the classic short-circuit trap: the second operand only ran when the flag was on. Rewrite this one by hand.`,
      toks[coreStart].start,
      { details: { reasons: imp.reasons } },
    );
  }
  const text = src.slice(toks[rhsStart].start, toks[rhsEnd].end);
  void advise;
  return {
    // The whole `FLAG && rest` sub-expression is replaced by `rest`: replacing
    // only the flag would leave `rest && rest` behind.
    start: toks[coreStart].start,
    end: toks[rhsEnd].end,
    replacement: text,
    kind: 'condition-drop-flag',
    note: `condition becomes ${text.trim()} (only truthiness is observed, and the provider has confirmed the flag is on)`,
  };
}

/** True when the range is a whole expression statement whose value is unused. */
function wholeExpressionStatement(index, s, e) {
  const toks = index.toks;
  const before = toks[s - 1];
  const after = toks[e + 1];
  const startsStatement =
    !before ||
    (before.type === 'punct' && [';', '{', '}'].includes(before.value)) ||
    (before.type === 'ident' && ['else', 'do'].includes(before.value));
  if (!startsStatement) return null;
  if (!after) return { start: toks[s].start, end: toks[e].end };
  if (after.type === 'punct' && after.value === ';') return { start: toks[s].start, end: after.end };
  if (after.type === 'punct' && after.value === '}') return { start: toks[s].start, end: toks[e].end };
  return null;
}

/** Names declared by const/let/class/function inside a branch. */
function hoistedDeclarations(index, branch) {
  const toks = index.toks;
  const names = [];
  for (let i = branch.startIdx; i <= branch.endIdx; i += 1) {
    const t = toks[i];
    if (t.start < branch.innerStart) continue;
    if (t.type !== 'ident') continue;
    if (!['const', 'let', 'class', 'function'].includes(t.value)) continue;
    const next = toks[i + 1];
    if (next && next.type === 'ident') names.push(next.value);
    else if (next && next.type === 'punct' && (next.value === '{' || next.value === '[')) {
      const closeIdx = index.open.get(i + 1);
      if (closeIdx !== undefined) {
        for (let k = i + 2; k < closeIdx; k += 1) {
          if (toks[k].type === 'ident' && !toks[k].keyword) names.push(toks[k].value);
        }
      }
    }
  }
  return [...new Set(names)];
}

function planTernary(index, src, ref, ctx, refuse, describe) {
  const toks = index.toks;
  const { ws, we, truthy } = ctx;
  const qIdx = we + 1;
  const colonIdx = matchingColon(index, qIdx);
  if (colonIdx === -1) {
    return refuse('TERNARY_SHAPE', `could not find the ":" that matches this "?" for ${describe}`, toks[ws].start);
  }
  const consStart = qIdx + 1;
  const consEnd = colonIdx - 1;
  const altStart = colonIdx + 1;
  const altEnd = alternateEnd(index, altStart);
  if (consEnd < consStart || altEnd < altStart || !toks[altStart]) {
    return refuse('TERNARY_SHAPE', `this conditional expression has an empty branch`, toks[ws].start);
  }
  const takenStart = truthy ? consStart : altStart;
  const takenEnd = truthy ? consEnd : altEnd;
  const text = src.slice(toks[takenStart].start, toks[takenEnd].end);
  const replacement = needsParens(text) ? `(${text})` : text;
  return {
    start: toks[ws].start,
    end: toks[altEnd].end,
    replacement,
    kind: 'collapse-ternary',
    note: `kept the ${truthy ? 'consequent' : 'alternate'} of the conditional expression`,
    dropped: src.slice(
      toks[truthy ? altStart : consStart].start,
      toks[truthy ? altEnd : consEnd].end,
    ).trim().slice(0, 120),
  };
}

function planLogicalAnd(index, src, ref, ctx, refuse, describe) {
  const toks = index.toks;
  const { ws, we, truthy, exactBoolean } = ctx;
  const rhsStart = we + 2;
  const rhs = toks[rhsStart];
  if (!rhs) return refuse('UNSUPPORTED_CONDITION', `this && has no right-hand side`, toks[ws].start);
  const rhsEnd = expressionEnd(index, rhsStart);
  const rhsText = src.slice(rhs.start, toks[rhsEnd].end);
  const fullEnd = toks[rhsEnd].end;

  if (truthy) {
    return {
      start: toks[ws].start,
      end: fullEnd,
      replacement: rhsText,
      kind: 'collapse-logical-and',
      note: 'the flag is always truthy, so && always reaches its right-hand side',
    };
  }
  const stmt = wholeExpressionStatement(index, ws, rhsEnd);
  if (stmt) {
    const del = expandStatementDeletion(src, stmt.start, stmt.end);
    return {
      start: del.start,
      end: del.end,
      replacement: '',
      kind: 'delete-logical-and',
      deleteStatement: true,
      note: 'the && never reaches its right-hand side and its value is discarded',
    };
  }
  if (exactBoolean) {
    return {
      start: toks[ws].start,
      end: fullEnd,
      replacement: 'false',
      kind: 'collapse-logical-and',
      note: 'a negated flag is exactly boolean, so this expression is false',
    };
  }
  if (ctx.allowBoolean) {
    return {
      start: toks[ws].start,
      end: fullEnd,
      replacement: 'false',
      kind: 'collapse-logical-and-assumed',
      note: 'assumes the disabled flag value is false (--assume-boolean)',
    };
  }
  return refuse(
    'VALUE_CONTEXT_DISABLED',
    `this && never reaches its right-hand side, and its value is used. The result then depends on what your provider returns for a disabled flag (false, "off", 0 or undefined), which this tool does not know. Pass --allow VALUE_CONTEXT_DISABLED (or --assume-boolean) to write false, or rewrite by hand.`,
    toks[ws].start,
  );
}

/** True when a region mentions some flag other than the one being removed. */
function referencesOtherFlag(toks, ctx) {
  const config = ctx.config;
  for (let i = 0; i < toks.length; i += 1) {
    const t = toks[i];
    if (t.type !== 'ident') continue;
    if (isObjectRoot(t.value, config)) {
      const nxt = toks[i + 1];
      if (nxt && nxt.type === 'punct' && (nxt.value === '.' || nxt.value === '?.')) return true;
    }
    if (config.flagFunctions.includes(t.value)) {
      const nxt = toks[i + 1];
      if (nxt && nxt.type === 'punct' && nxt.value === '(') return true;
    }
  }
  return false;
}

/* -------------------------------------------------------------------------
 * Deletion helper
 * ---------------------------------------------------------------------- */

/**
 * When a whole statement is deleted, also consume the line it occupied so the
 * output does not accumulate blank lines. Only when the line holds nothing else.
 *
 * If the line before the deletion is blank and the line after it is blank too,
 * the following blank line is consumed as well: otherwise every removed guard
 * would widen the gap around it by one line, and a diff full of whitespace
 * noise is a diff reviewers stop reading.
 */
export function expandStatementDeletion(src, start, end) {
  const lineStart = src.lastIndexOf('\n', start - 1) + 1;
  const before = src.slice(lineStart, start);
  const nl = src.indexOf('\n', end);
  const after = nl === -1 ? src.slice(end) : src.slice(end, nl);
  if (!/^[ \t]*$/.test(before) || !/^[ \t]*$/.test(after) || nl === -1) {
    return { start, end };
  }
  let newEnd = nl + 1;
  const previousLineIsBlank = lineStart >= 2 && src[lineStart - 1] === '\n' && src[lineStart - 2] === '\n';
  if (previousLineIsBlank && src[newEnd] === '\n') newEnd += 1;
  return { start: lineStart, end: newEnd };
}

/* -------------------------------------------------------------------------
 * Wrapper analysis (unwrap-provider)
 * ---------------------------------------------------------------------- */

/**
 * Find flag wrapper components and HOCs to unwrap.
 * @param {string} src
 * @param {object} opts { flag, config, propNames, file }
 */
export function analyzeWrapper(src, opts) {
  const config = opts.config || defaultConfig();
  const propNames = opts.propNames || DEFAULT_WRAPPER_PROPS;
  const toks = meaningful(collectTokens(src));
  const lines = lineIndex(src);

  const sites = [];
  const refusals = [];
  const advisories = [];
  const removedNames = new Set();

  const refuse = (code, message, offset) => {
    const at = lineCol(lines, offset);
    refusals.push({
      code,
      message,
      line: at.line,
      column: at.column,
      offset,
      file: opts.file,
      downgradable: REFUSALS[code] ? REFUSALS[code].downgradable : false,
      relaxed: false,
    });
    return null;
  };

  const { errors: lexErrors } = tokenize(src);
  for (const e of lexErrors) refuse('UNPARSEABLE', `lexer: ${e.message}`, e.offset);

  const handled = new Set();

  /**
   * Build the rewrite that replaces a wrapper element with `innerText`.
   * When the element starts its own line, the edit also consumes that line's
   * indentation and re-indents the hoisted text to match; otherwise the text is
   * inserted where it stands with no indentation added. Getting this wrong
   * produces doubled indentation, which is the kind of cosmetic damage that
   * makes a reviewer distrust the whole diff.
   */
  const hoistSite = (node, innerText, extra) => {
    const lineStart = src.lastIndexOf('\n', node.start - 1) + 1;
    const prefix = src.slice(lineStart, node.start);
    const ownLine = /^[ \t]*$/.test(prefix);
    const indent = ownLine ? prefix : '';
    return {
      start: ownLine ? lineStart : node.start,
      end: node.end,
      replacement: reindent(innerText, indent),
      ...extra,
    };
  };

  // ------------------------------------------------ wrapper components
  for (const tok of toks) {
    if (tok.type !== 'jsx' || !tok.nodes) continue;
    for (let n = 0; n < tok.nodes.length; n += 1) {
      const node = tok.nodes[n];
      if (!config.wrapperComponents.includes(node.name)) continue;
      if (handled.has(node.start)) continue;
      handled.add(node.start);

      const flagAttrs = node.attrs.filter((a) => a.name && propNames.includes(a.name));
      if (!flagAttrs.length) continue; // a wrapper usage for some other purpose
      const attr = flagAttrs[0];
      const literal = attr.valueType === 'string'
        ? attr.literal
        : literalFromRange(src, attr.valueStart, attr.valueEnd);

      if (literal === null) {
        refuse(
          'WRAPPER_DYNAMIC_NAME',
          `<${node.name}> is given a flag name that is not a string literal in this file, so this tool cannot tell whether it is the flag you are removing. Pass a literal, or unwrap this one by hand.`,
          node.start,
        );
        continue;
      }
      if (literal !== opts.flag) continue; // a different flag: leave it alone

      const others = node.attrs.filter((a) => a !== attr);
      if (others.length) {
        refuse(
          'WRAPPER_EXTRA_PROPS',
          `<${node.name} ${attr.name}="${literal}"> also carries ${others.map((a) => a.name || 'a spread').join(', ')}. Those props change what the wrapper renders (fallbacks, inverted logic, loading states), so unwrapping it mechanically would change behaviour.`,
          node.start,
        );
        continue;
      }

      if (node.selfClosing) {
        refuse('WRAPPER_NO_CHILDREN', `<${node.name} ${attr.name}="${literal}" /> has no children to hoist`, node.start);
        continue;
      }

      const childrenStart = node.openEnd;
      const childrenEnd = node.closeStart;
      const childrenText = src.slice(childrenStart, childrenEnd);
      if (!childrenText.trim()) {
        refuse('WRAPPER_NO_CHILDREN', `<${node.name} ${attr.name}="${literal}"> is empty; there is nothing to hoist`, node.start);
        continue;
      }

      const directChildren = tok.nodes.filter((c) => c.parent === n);
      const trimmedStart = childrenStart + (childrenText.length - childrenText.trimStart().length);
      const trimmedEnd = childrenEnd - (childrenText.length - childrenText.trimEnd().length);

      // (a) exactly one child element
      if (directChildren.length === 1) {
        const child = directChildren[0];
        if (child.start === trimmedStart && child.end === trimmedEnd) {
          sites.push(hoistSite(node, src.slice(child.start, child.end), {
            kind: 'unwrap-component',
            note: `hoisted the single child of <${node.name} ${attr.name}="${literal}">`,
          }));
          removedNames.add(node.name);
          continue;
        }
      }

      // (b) exactly one expression container
      const container = singleContainer(src, trimmedStart, trimmedEnd);
      if (container) {
        const inner = src.slice(container.start + 1, container.end);
        if (looksLikeRenderProp(indexOfTokens(inner))) {
          refuse(
            'WRAPPER_SHAPE',
            `<${node.name} ${attr.name}="${literal}"> passes the flag value to a function child (a render prop). The flag value is used by that function, so hoisting the children alone would change behaviour.`,
            node.start,
          );
          continue;
        }
        if (!inner.trim()) {
          refuse('WRAPPER_NO_CHILDREN', `<${node.name} ${attr.name}="${literal}"> has an empty expression child`, node.start);
          continue;
        }
        sites.push(hoistSite(node, inner, {
          kind: 'unwrap-component',
          note: `hoisted the single expression child of <${node.name} ${attr.name}="${literal}">`,
        }));
        removedNames.add(node.name);
        continue;
      }

      // (c) plain text child
      const text = src.slice(trimmedStart, trimmedEnd);
      if (!/[<>{}]/.test(text)) {
        sites.push(hoistSite(node, text, {
          kind: 'unwrap-component',
          note: `hoisted the text child of <${node.name} ${attr.name}="${literal}">`,
        }));
        removedNames.add(node.name);
        continue;
      }

      refuse(
        'WRAPPER_MULTIPLE_CHILDREN',
        `<${node.name} ${attr.name}="${literal}"> has ${directChildren.length || 'several'} children. Hoisting them needs a fragment (<>...</>), and guessing where to put it can change whitespace and layout, so this tool refuses. Wrap the children in a single element or fragment by hand, then run this codemod again.`,
        node.start,
      );
    }
  }

  // ------------------------------------------------------------- HOC calls
  const hocIndex = buildIndex(toks);
  for (let i = 0; i < toks.length; i += 1) {
    const t = toks[i];
    if (t.type !== 'ident' || !config.hocFunctions.includes(t.value)) continue;
    const open1 = i + 1;
    if (!(toks[open1] && toks[open1].value === '(')) continue;
    const close1 = hocIndex.open.get(open1);
    if (close1 === undefined) continue;
    const argToks = toks.slice(open1 + 1, close1);
    const literal = argToks.length ? literalNameAt(argToks[0]) : null;
    const open2 = close1 + 1;
    if (!(toks[open2] && toks[open2].value === '(')) {
      refuse(
        'WRAPPER_SHAPE',
        `${t.value}(...) is used without being called on a component in this file, so there is nothing to unwrap here.`,
        t.start,
      );
      continue;
    }
    const close2 = hocIndex.open.get(open2);
    if (close2 === undefined) continue;
    if (literal !== opts.flag) continue;
    const componentToks = toks.slice(open2 + 1, close2);
    if (!componentToks.length) {
      refuse('WRAPPER_NO_CHILDREN', `${t.value}("${opts.flag}")(...) wraps nothing`, t.start);
      continue;
    }
    sites.push({
      start: t.start,
      end: toks[close2].end,
      replacement: src.slice(componentToks[0].start, componentToks[componentToks.length - 1].end),
      kind: 'unwrap-hoc',
      note: `removed the ${t.value}("${opts.flag}") HOC`,
    });
    removedNames.add(t.value);
  }

  return { sites, refusals, advisories, removedNames: [...removedNames], flag: opts.flag };
}

/** Tokenize a fragment for shape checks. */
function indexOfTokens(text) {
  return meaningful(tokenize(text).tokens);
}

/** Is the child a render prop (a function receiving the flag value)? */
function looksLikeRenderProp(toks) {
  if (!toks.length) return false;
  if (toks[0].type === 'ident' && toks[0].value === 'function') return true;
  if (toks[0].type === 'ident' && toks[1] && toks[1].value === '=>') return true;
  if (toks[0].type === 'punct' && toks[0].value === '(') {
    // `(props) => ...` or `(flag) => ...`
    let depth = 0;
    for (let i = 0; i < toks.length; i += 1) {
      const t = toks[i];
      if (t.type !== 'punct') continue;
      if (t.value === '(') depth += 1;
      else if (t.value === ')') {
        depth -= 1;
        if (depth === 0) {
          const next = toks[i + 1];
          return Boolean(next && next.type === 'punct' && next.value === '=>');
        }
      }
    }
  }
  return false;
}

/** If [start, end) is exactly one `{...}` container, return its brace range. */
function singleContainer(src, start, end) {
  if (src[start] !== '{') return null;
  const close = matchBalanced(src, start, '{', '}');
  if (close === -1 || close + 1 !== end) return null;
  return { start, end: close + 1 };
}

/** Literal flag name inside a `{...}` JSX attribute value, or null. */
function literalFromRange(src, start, end) {
  if (start === null || end === null) return null;
  const text = src.slice(start, end);
  const toks = meaningful(tokenize(text).tokens);
  if (toks.length !== 1) return null;
  return literalNameAt(toks[0]);
}

export { LOW_PRECEDENCE, expressionEnd, matchingColon };

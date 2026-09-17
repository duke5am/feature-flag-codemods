/**
 * scan.js -- structural helpers over a token stream.
 *
 * Part of Feature Flag Cleanup Codemods.
 *
 * This is the "shape" layer: matching bracket pairs, finding the statement a
 * token belongs to, locating the enclosing block/function/loop, deciding
 * whether an expression is pure, and collecting what an expression mutates.
 * The flag-specific rules live in flags.js and analyze.js.
 *
 * Index conventions:
 *   - `toks` is the array of MEANINGFUL tokens (comments removed), in source
 *     order, with absolute byte offsets.
 *   - A "token index" is a position in `toks`; a "byte offset" is a position
 *     in the source string. Function names are explicit about which they take.
 */

import { tokenize, Lexer } from './tokenize.js';

/**
 * Build the lookup tables every rule uses.
 * @param {Array<object>} toks meaningful tokens
 */
export function buildIndex(toks) {
  const idxByStart = new Map();
  const open = new Map(); // opener idx -> closer idx
  const close = new Map(); // closer idx -> opener idx
  const stack = [];

  for (let i = 0; i < toks.length; i += 1) {
    idxByStart.set(toks[i].start, i);
    const t = toks[i];
    if (t.type !== 'punct') continue;
    if (t.value === '(' || t.value === '{' || t.value === '[') {
      stack.push(i);
    } else if (t.value === ')' || t.value === '}' || t.value === ']') {
      const opener = stack.pop();
      if (opener === undefined) continue; // unbalanced: ignore
      open.set(opener, i);
      close.set(i, opener);
    }
  }
  return { toks, idxByStart, open, close };
}

/** Token index starting at a byte offset, or -1. */
export function indexAtOffset(index, offset) {
  const i = index.idxByStart.get(offset);
  return i === undefined ? -1 : i;
}

/* -------------------------------------------------------------------------
 * Statement boundaries
 * ---------------------------------------------------------------------- */

const STATEMENT_KEYWORDS = new Set([
  'if', 'for', 'while', 'do', 'switch', 'try', 'return', 'throw', 'break',
  'continue', 'function', 'class', 'const', 'let', 'var', 'export', 'import',
  'with', 'debugger',
]);

/** Scan forward to the end of a simple statement (`;` at depth 0, block `}`). */
function scanToStatementEnd(index, i) {
  const toks = index.toks;
  let last = i;
  for (let j = i; j < toks.length; j += 1) {
    const t = toks[j];
    if (t.type === 'punct') {
      if (t.value === '(' || t.value === '[' || t.value === '{') {
        const matched = index.open.get(j);
        if (matched !== undefined) {
          last = matched;
          j = matched;
          continue;
        }
      } else if (t.value === '}') {
        const opener = index.close.get(j);
        if (opener !== undefined && opener < i) {
          return { start: toks[i].start, end: toks[last].end, endIdx: last };
        }
      } else if (t.value === ';') {
        return { start: toks[i].start, end: t.end, endIdx: j };
      }
    }
    last = j;
  }
  return { start: toks[i].start, end: toks[last].end, endIdx: last };
}

/**
 * Byte range of the statement that begins at token index `i`.
 * @returns {{ start: number, end: number, endIdx: number }}
 */
export function statementRange(index, i) {
  const toks = index.toks;
  if (i < 0 || i >= toks.length) return { start: -1, end: -1, endIdx: -1 };
  const t = toks[i];

  if (t.type === 'punct' && t.value === '{' && index.open.has(i)) {
    const j = index.open.get(i);
    return { start: t.start, end: toks[j].end, endIdx: j };
  }
  if (t.type === 'ident' && t.value === 'if') {
    const stmt = parseIfStatement(index, i);
    if (stmt) return { start: stmt.start, end: stmt.end, endIdx: stmt.endIdx };
  }
  if (
    t.type === 'ident' &&
    (t.value === 'function' || t.value === 'class' || t.value === 'export' || t.value === 'try')
  ) {
    const body = findBodyGroup(index, i);
    if (body) return { start: t.start, end: toks[body].end, endIdx: body };
  }
  return scanToStatementEnd(index, i);
}

/** Index of the `{...}` body group belonging to the construct at `i`. */
function findBodyGroup(index, i) {
  const toks = index.toks;
  for (let j = i + 1; j < toks.length; j += 1) {
    const t = toks[j];
    if (t.type === 'punct' && t.value === '{') {
      const closer = index.open.get(j);
      if (closer !== undefined) return closer;
      return -1;
    }
    if (t.type === 'punct' && t.value === ';') return -1;
  }
  return -1;
}

/**
 * Parse `if (...) <stmt> [else <stmt>]` starting at token index `i`.
 * @returns {null|{
 *   start: number, end: number, endIdx: number,
 *   cond: {startIdx: number, endIdx: number, innerStart: number, innerEnd: number},
 *   consequent: object, alternate: null|object
 * }}
 */
export function parseIfStatement(index, i) {
  const toks = index.toks;
  if (!(toks[i] && toks[i].type === 'ident' && toks[i].value === 'if')) return null;

  let j = i + 1;
  if (!(toks[j] && toks[j].type === 'punct' && toks[j].value === '(')) return null;
  const condEndIdx = index.open.get(j);
  if (condEndIdx === undefined) return null;

  const consequent = parseBranch(index, condEndIdx + 1);
  if (!consequent) return null;

  let alternate = null;
  let endIdx = consequent.endIdx;
  let end = consequent.end;

  const elseIdx = consequent.endIdx + 1;
  if (toks[elseIdx] && toks[elseIdx].type === 'ident' && toks[elseIdx].value === 'else') {
    const altStart = elseIdx + 1;
    const altTok = toks[altStart];
    if (!altTok) return null;
    if (altTok.type === 'ident' && altTok.value === 'if') {
      const nested = parseIfStatement(index, altStart);
      if (!nested) return null;
      alternate = {
        kind: 'if',
        start: nested.start,
        end: nested.end,
        innerStart: nested.start,
        innerEnd: nested.end,
        endIdx: nested.endIdx,
      };
    } else {
      alternate = parseBranch(index, altStart);
      if (!alternate) return null;
    }
    endIdx = alternate.endIdx;
    end = alternate.end;
  }

  return {
    start: toks[i].start,
    end,
    endIdx,
    cond: {
      startIdx: j,
      endIdx: condEndIdx,
      innerStart: toks[j].end,
      innerEnd: toks[condEndIdx].start,
    },
    consequent,
    alternate,
  };
}

/** Parse a single branch: a `{...}` block or one statement. */
function parseBranch(index, i) {
  const toks = index.toks;
  const t = toks[i];
  if (!t) return null;
  if (t.type === 'punct' && t.value === '{') {
    const endIdx = index.open.get(i);
    if (endIdx === undefined) return null;
    return {
      kind: 'block',
      start: t.start,
      end: toks[endIdx].end,
      innerStart: t.end,
      innerEnd: toks[endIdx].start,
      startIdx: i,
      endIdx,
    };
  }
  const range = statementRange(index, i);
  if (range.start < 0 || range.endIdx < i) return null;
  return {
    kind: 'statement',
    start: range.start,
    end: range.end,
    innerStart: range.start,
    innerEnd: range.end,
    startIdx: i,
    endIdx: range.endIdx,
  };
}

/* -------------------------------------------------------------------------
 * Enclosing scopes
 * ---------------------------------------------------------------------- */

/**
 * Bracketed groups containing a byte offset, outermost first.
 * @returns {Array<{openIdx: number, closeIdx: number, kind: string, label: string}>}
 */
export function enclosingGroups(index, offset) {
  const toks = index.toks;
  const out = [];
  for (let i = 0; i < toks.length; i += 1) {
    const t = toks[i];
    if (t.start >= offset) break;
    if (t.type !== 'punct') continue;
    if (t.value !== '(' && t.value !== '{' && t.value !== '[') continue;
    const closer = index.open.get(i);
    if (closer === undefined) continue;
    if (toks[closer].start > offset) {
      out.push({
        openIdx: i,
        closeIdx: closer,
        kind: t.value,
        label: describeGroupHeader(index, i),
      });
    }
  }
  return out;
}

/**
 * Lexical context of the statement beginning at token index `stmtIdx`.
 * @returns {{ inLoop: boolean, loopOpenIdx: number|null, inFunction: boolean,
 *            inTry: boolean, labels: string[] }}
 */
export function lexicalContext(index, stmtIdx) {
  const toks = index.toks;
  const offset = toks[stmtIdx] ? toks[stmtIdx].start : 0;
  const groups = enclosingGroups(index, offset);
  const labels = groups.map((g) => g.label);

  let inLoop = false;
  let loopOpenIdx = null;
  let inFunction = false;
  let inTry = false;

  for (let g = groups.length - 1; g >= 0; g -= 1) {
    const label = groups[g].label;
    if (!inLoop && (label === 'loop-body' || label === 'loop-header')) {
      inLoop = true;
      loopOpenIdx = groups[g].openIdx;
    }
    if (!inFunction && label === 'function-body') inFunction = true;
    if (!inTry && (label === 'try-block' || label === 'catch-block')) inTry = true;
  }

  // Braceless loop body: the loop header's `)` sits immediately before it.
  if (!inLoop) {
    const prev = toks[stmtIdx - 1];
    if (prev && prev.type === 'punct' && prev.value === ')') {
      const opener = index.close.get(stmtIdx - 1);
      const kw = opener !== undefined ? toks[opener - 1] : null;
      if (kw && kw.type === 'ident' && (kw.value === 'for' || kw.value === 'while')) {
        inLoop = true;
        loopOpenIdx = opener;
      }
    }
  }
  return { inLoop, loopOpenIdx, inFunction, inTry, labels };
}

/** If `while (...)` / `for (...)` at index `i` is a loop header. */
export function isLoopHeader(index, i) {
  const t = index.toks[i];
  return Boolean(
    t && t.type === 'ident' && (t.value === 'for' || t.value === 'while' || t.value === 'do'),
  );
}

function describeGroupHeader(index, openIdx) {
  const toks = index.toks;
  const opener = toks[openIdx];
  const before = toks[openIdx - 1];
  if (!before) return 'top';

  if (opener.value === '(') {
    if (before.type === 'ident') {
      if (before.value === 'for' || before.value === 'while') return 'loop-header';
      if (['if', 'switch', 'with', 'catch'].includes(before.value)) return 'header';
      return 'call';
    }
    return 'paren';
  }
  if (opener.value === '[') return 'bracket';

  // opener.value === '{'
  if (before.type === 'punct' && before.value === ')') {
    const parenOpen = index.close.get(openIdx - 1);
    const kw = parenOpen !== undefined ? toks[parenOpen - 1] : null;
    if (kw && kw.type === 'ident') {
      if (kw.value === 'for' || kw.value === 'while') return 'loop-body';
      if (kw.value === 'catch') return 'catch-block';
      if (['if', 'switch', 'with', 'else'].includes(kw.value)) return 'header-body';
    }
    return 'function-body';
  }
  if (before.type === 'punct' && before.value === '=>') return 'function-body';
  if (before.type === 'punct' && before.value === 'else') return 'header-body';
  if (before.type === 'ident') {
    if (before.value === 'do') return 'loop-body';
    if (before.value === 'try') return 'try-block';
    if (before.value === 'function' || before.value === 'class') return 'function-body';
  }
  return 'block';
}

/* -------------------------------------------------------------------------
 * Expression analysis
 * ---------------------------------------------------------------------- */

const BUILTIN_PURE_CALLS = new Set(['String', 'Number', 'Boolean', 'BigInt']);

const ASSIGN_OPERATORS = new Set([
  '=', '+=', '-=', '*=', '/=', '%=', '**=', '&&=', '||=', '??=', '&=', '|=',
  '^=', '<<=', '>>=', '>>>=',
]);

/** Index of the `(`/`[`/`{` opening the group closed at `closeIdx`, or -1. */
export function matchingOpen(index, closeIdx) {
  const opener = index.close.get(closeIdx);
  return opener === undefined ? -1 : opener;
}

/**
 * Root name written by an assignment whose operator is at token index `opIdx`:
 * `a = ..` -> `a`, `a.b = ..` -> `a.b`, `a[i] = ..` -> `a` (root only, which
 * makes distinct writes collide on purpose: collisions cause refusals).
 */
export function assignmentTarget(index, opIdx) {
  const toks = index.toks;
  let j = opIdx - 1;
  if (j < 0 || !toks[j]) return null;
  if (toks[j].type === 'punct' && toks[j].value === ']') {
    const opener = matchingOpen(index, j);
    if (opener <= 0) return null;
    const root = toks[opener - 1];
    return root && root.type === 'ident' ? root.value : null;
  }
  if (toks[j].type !== 'ident') return null;
  let name = toks[j].value;
  let k = j - 1;
  while (k >= 1 && toks[k].type === 'punct' && (toks[k].value === '.' || toks[k].value === '?.')) {
    const obj = toks[k - 1];
    if (!obj || obj.type !== 'ident') break;
    name = `${obj.value}.${name}`;
    k -= 2;
  }
  return name;
}

/** Root name updated by `++`/`--` at token index `i`, or null. */
export function updateTarget(index, i) {
  const toks = index.toks;
  const before = toks[i - 1];
  const after = toks[i + 1];
  const endsValue = (t) => t && (t.type === 'ident' || (t.type === 'punct' && (t.value === ']' || t.value === ')')));
  if (endsValue(before)) {
    if (before.type === 'ident') {
      // `a++` (postfix)
      let name = before.value;
      let k = i - 2;
      while (k >= 1 && toks[k].type === 'punct' && (toks[k].value === '.' || toks[k].value === '?.')) {
        const obj = toks[k - 1];
        if (!obj || obj.type !== 'ident') break;
        name = `${obj.value}.${name}`;
        k -= 2;
      }
      return name;
    }
    if (before.type === 'punct' && before.value === ']') {
      const opener = matchingOpen(index, i - 1);
      const root = opener > 0 ? toks[opener - 1] : null;
      return root && root.type === 'ident' ? root.value : null;
    }
    return null;
  }
  if (after && after.type === 'ident') return after.value; // `++a` (prefix)
  return null;
}

/**
 * Names mutated in the token range [startIdx, endIdx] inclusive.
 * @returns {Set<string>}
 */
export function mutationTargets(index, startIdx, endIdx) {
  const toks = index.toks;
  const out = new Set();
  const from = Math.max(0, startIdx);
  const to = Math.min(toks.length - 1, endIdx);
  for (let i = from; i <= to; i += 1) {
    const t = toks[i];
    if (t.type === 'punct' && (t.value === '++' || t.value === '--')) {
      const target = updateTarget(index, i);
      if (target) out.add(target);
      continue;
    }
    if (t.type === 'punct' && ASSIGN_OPERATORS.has(t.value)) {
      const target = assignmentTarget(index, i);
      if (target) out.add(target);
    }
  }
  return out;
}

/**
 * Effects that make a region unsafe to delete or relocate: calls to anything
 * that is not an allow-listed name, assignments, updates, `await`, `yield`,
 * `new`, `delete`, `throw`.
 * Deliberately conservative: `list.map(fn)` counts as a call.
 * @returns {{ impure: boolean, reasons: string[] }}
 */
export function impurity(toks, opts = {}) {
  const allowCalls = opts.allowCalls || new Set();
  const reasons = [];
  for (let i = 0; i < toks.length; i += 1) {
    const t = toks[i];
    if (t.type === 'punct') {
      if (t.value === '++' || t.value === '--' || t.value === 'delete') reasons.push(t.value);
      else if (ASSIGN_OPERATORS.has(t.value)) reasons.push(t.value);
      continue;
    }
    if (t.type !== 'ident') continue;
    if (t.value === 'await' || t.value === 'yield' || t.value === 'new' || t.value === 'throw') {
      reasons.push(t.value);
      continue;
    }
    const next = toks[i + 1];
    if (!(next && next.type === 'punct' && next.value === '(')) continue;
    const prev = toks[i - 1];
    const isMethod = prev && prev.type === 'punct' && (prev.value === '.' || prev.value === '?.');
    if (isMethod) reasons.push(`call .${t.value}()`);
    else if (!BUILTIN_PURE_CALLS.has(t.value) && !allowCalls.has(t.value)) reasons.push(`call ${t.value}()`);
  }
  return { impure: reasons.length > 0, reasons: [...new Set(reasons)] };
}

/**
 * Does replacing this expression require parentheses to keep precedence?
 * True when a binary/conditional/comma/assignment operator appears at depth 0.
 */
export function needsParens(text) {
  const { tokens } = tokenize(text);
  let depth = 0;
  for (const t of tokens) {
    if (t.type === 'comment') continue;
    if (t.type === 'punct') {
      if (t.value === '(' || t.value === '[' || t.value === '{') depth += 1;
      else if (t.value === ')' || t.value === ']' || t.value === '}') depth -= 1;
      else if (depth === 0) {
        if (t.value === '=>') return false; // arrow function body
        if (
          ['+', '-', '*', '/', '%', '**', '==', '===', '!=', '!==', '<', '>',
            '<=', '>=', '&&', '||', '??', '&', '|', '^', '<<', '>>', '>>>',
            '?', ':', '=', ...ASSIGN_OPERATORS].includes(t.value)
        ) {
          return true;
        }
      }
    }
    if (t.type === 'ident' && depth === 0 && (t.value === 'instanceof' || t.value === 'in')) return true;
  }
  return false;
}

/* -------------------------------------------------------------------------
 * Declarations
 * ---------------------------------------------------------------------- */

/**
 * Names declared in the file: `let`/`const`/`var`, `function`/`class`, import
 * bindings, and function/arrow parameters. Parameters matter because a
 * parameter can shadow a flag alias, and a shadowed name must never be treated
 * as the flag.
 * @returns {Map<string, number[]>} name -> byte offsets of declarations
 */
export function declaredNames(index) {
  const toks = index.toks;
  const out = new Map();
  const add = (name, offset) => {
    if (!out.has(name)) out.set(name, []);
    out.get(name).push(offset);
  };

  for (let i = 0; i < toks.length; i += 1) {
    const t = toks[i];
    if (t.type !== 'ident') continue;

    if (t.value === 'let' || t.value === 'const' || t.value === 'var') {
      let j = i + 1;
      if (toks[j] && toks[j].type === 'punct' && (toks[j].value === '{' || toks[j].value === '[')) {
        const closeIdx = index.open.get(j);
        if (closeIdx === undefined) continue;
        for (let k = j + 1; k < closeIdx; k += 1) {
          const inner = toks[k];
          if (inner.type !== 'ident' || inner.keyword) continue;
          const prev = toks[k - 1];
          const next = toks[k + 1];
          if (prev && prev.type === 'ident' && prev.value === 'as') continue;
          if (prev && prev.type === 'punct' && prev.value === ':') continue; // local of `{ key: local }`
          if (prev && prev.type === 'punct' && prev.value === '...') continue; // spread element
          if (next && next.type === 'punct' && next.value === ':') {
            const local = toks[k + 2];
            if (local && local.type === 'ident') add(local.value, local.start);
            continue;
          }
          if (next && next.type === 'punct' && next.value === '=') continue; // default value
          add(inner.value, inner.start);
        }
        continue;
      }
      if (toks[j] && toks[j].type === 'ident') add(toks[j].value, toks[j].start);
      continue;
    }
    if (t.value === 'function' || t.value === 'class') {
      const name = toks[i + 1];
      if (name && name.type === 'ident') add(name.value, name.start);
      continue;
    }
    if (t.value === 'import') {
      for (let j = i + 1; j < toks.length; j += 1) {
        const u = toks[j];
        if (u.type === 'string') break;
        if (u.type === 'ident' && u.value === 'from') break;
        if (u.type === 'ident' && u.value !== 'as' && u.value !== 'import') {
          const prev = toks[j - 1];
          const next = toks[j + 1];
          if (prev && prev.type === 'ident' && prev.value === 'as') {
            add(u.value, u.start);
            continue;
          }
          if (next && next.type === 'ident' && next.value === 'as') continue;
          if (prev && prev.type === 'punct' && prev.value === '.') continue;
          add(u.value, u.start);
        }
      }
      continue;
    }
  }

  // Parameters of `function (...)`, `(...) =>` and `name =>`.
  for (let i = 0; i < toks.length; i += 1) {
    const t = toks[i];
    if (t.type === 'punct' && t.value === '(') {
      const closeIdx = index.open.get(i);
      if (closeIdx === undefined) continue;
      const next = toks[closeIdx + 1];
      const prev = toks[i - 1];
      const isArrowParams = next && next.type === 'punct' && next.value === '=>';
      const isFunctionParams =
        prev && prev.type === 'ident' &&
        (prev.value === 'function' || toks[i - 2] && toks[i - 2].type === 'ident' && toks[i - 2].value === 'function');
      if (!isArrowParams && !isFunctionParams) continue;
      for (let k = i + 1; k < closeIdx; k += 1) {
        const p = toks[k];
        if (p.type !== 'ident' || p.keyword) continue;
        const before = toks[k - 1];
        if (before && before.type === 'punct' && (before.value === '.' || before.value === '?.')) continue;
        add(p.value, p.start);
      }
      continue;
    }
    // `name => ...` with a single unparenthesised parameter.
    if (
      t.type === 'ident' && !t.keyword &&
      toks[i + 1] && toks[i + 1].type === 'punct' && toks[i + 1].value === '=>'
    ) {
      const before = toks[i - 1];
      const isParam = !before || (before.type === 'punct' && ['(', ',', '{', '['].includes(before.value));
      if (isParam) add(t.value, t.start);
    }
  }

  return out;
}

/* -------------------------------------------------------------------------
 * Text utilities
 * ---------------------------------------------------------------------- */

/** Leading whitespace of the line containing `offset`. */
export function indentAt(src, offset) {
  const lineStart = src.lastIndexOf('\n', offset - 1) + 1;
  const m = /^[ \t]*/.exec(src.slice(lineStart, offset));
  return m ? m[0] : '';
}

/**
 * Shift a block of source text from its own indentation base to `toIndent`.
 *
 * The base is normally the smallest indent of the non-blank lines. When the
 * first line starts at column 0 but the text continues on later lines -- which
 * is what happens when a construct is lifted out of the middle of a line, for
 * instance the `if (y) { ... }` that follows `} else ` -- the base is taken
 * from the last non-blank line instead, because for a block that line is the
 * closing brace and it carries the construct's own indentation.
 */
export function reindent(text, toIndent) {
  const trimmed = text.replace(/^\s*\n/, '').replace(/\s+$/, '');
  if (!trimmed.trim()) return '';
  const lines = trimmed.split('\n');
  const leading = (line) => (/^[ \t]*/.exec(line) || [''])[0];

  let base = leading(lines[0]);
  if (base === '' && lines.length > 1) {
    const last = [...lines].reverse().find((line) => line.trim());
    base = leading(last);
  } else if (base === '' || lines.length > 1) {
    for (const line of lines) {
      if (!line.trim()) continue;
      if (leading(line).length < base.length) base = leading(line);
    }
  }
  return lines
    .map((line) => {
      if (!line.trim()) return '';
      const stripped = line.startsWith(base) && base !== '' ? line.slice(base.length) : line.replace(/^[ \t]*/, '');
      return toIndent + stripped;
    })
    .join('\n');
}

/** True when the text contains only whitespace and comments. */
export function isBlank(text) {
  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .trim();
  return stripped.length === 0;
}

/** Comment bodies contained in a byte range (for reporting what a deletion removes). */
export function commentsIn(src, start, end) {
  const out = [];
  const lexer = new Lexer(src, { from: start });
  for (let t = lexer.nextToken(); t && t.start < end; t = lexer.nextToken()) {
    if (t.type === 'comment') out.push(t.value.trim());
  }
  return out;
}

export { ASSIGN_OPERATORS };

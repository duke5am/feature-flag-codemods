/**
 * tokenize.js -- a dependency-free JavaScript / JSX lexer.
 *
 * Part of Feature Flag Cleanup Codemods.
 *
 * Why a hand-written lexer instead of a parser dependency:
 *
 *   1. A codemod must run inside the buyer's repo with no install step and no
 *      supply-chain surface. This file uses Node built-ins only.
 *   2. The transforms in this pack need *byte offsets* into the original text
 *      (so untouched bytes stay untouched), not a full AST.
 *   3. Refusing a transform is the safe failure mode, so an imperfect lexer
 *      degrades into "we refuse" rather than "we corrupt". Every file that is
 *      written is additionally parsed by V8 before saving (see validate.js),
 *      which is the real backstop.
 *
 * Everything (tokenization, bracket matching, JSX scanning, expression
 * position lookups) goes through the single `Lexer` class below. There is
 * deliberately no second, "quick and dirty" text scanner anywhere in this
 * pack: the one that existed during development mistook the `/>` of a nested
 * JSX element for a regular expression and silently produced a broken
 * rewrite, which is precisely the failure this product exists to prevent.
 *
 * Token shape:
 *   { type, value, start, end }
 *   type: 'ident' | 'number' | 'string' | 'template' | 'regex' | 'punct'
 *         | 'comment' | 'jsx'
 *   start/end are byte offsets into the source (end exclusive).
 *
 * A complete JSX element is emitted as ONE 'jsx' token so the surrounding
 * expression grammar stays intact. That token additionally carries:
 *   token.elements -> tag names seen inside it, e.g. ['Flag', 'div']
 *   token.segments -> { start, end } ranges covering the inner text of every
 *                     `{ ... }` expression container, so flag references in
 *                     JSX attributes and children can still be found.
 *   token.nodes    -> flat list of every element inside the token:
 *                     { name, start, end, openEnd, closeStart, selfClosing,
 *                       parent, attrs: [{ name, valueStart, valueEnd,
 *                       valueType, literal, start, end }] }
 *                     `parent` indexes the enclosing node in the same list, so
 *                     wrapper components can be located at any nesting depth.
 * If `<` does not begin a balanced JSX element (TypeScript generics, `a < b`),
 * it is emitted as an ordinary '<' punct token.
 */

const KEYWORDS = new Set([
  'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
  'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false',
  'finally', 'for', 'function', 'if', 'implements', 'import', 'in',
  'instanceof', 'interface', 'let', 'new', 'null', 'package', 'private',
  'protected', 'public', 'return', 'static', 'super', 'switch', 'this',
  'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield',
]);

/** Keywords after which a `/` begins a regex literal rather than a division. */
const REGEX_PRECEDING_KEYWORDS = new Set([
  'await', 'case', 'delete', 'do', 'else', 'extends', 'in', 'instanceof',
  'new', 'of', 'return', 'throw', 'typeof', 'void', 'yield',
]);

/** Punctuators, longest first, so greedy matching yields the right token. */
const PUNCTUATORS = [
  '>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '&&=', '||=', '??=',
  '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--',
  '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '**', '<<', '>>',
  '{', '}', '(', ')', '[', ']', ';', ',', '<', '>', '+', '-', '*', '/', '%',
  '&', '|', '^', '!', '~', '?', ':', '=', '.', '@', '#',
];

/** Punctuators after which a `/` is a division, not a regex. */
const NO_REGEX_AFTER = new Set([')', ']', '}', '++', '--']);

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$]/;
const WHITESPACE = /[ \t\n\r\f\v\u00a0\ufeff]/;

function isDigit(ch) {
  return ch >= '0' && ch <= '9';
}

/** Single-pass lexer. Tokens are produced on demand and offsets are absolute. */
export class Lexer {
  /**
   * @param {string} src
   * @param {{ jsx?: boolean, from?: number }} [opts]
   */
  constructor(src, opts = {}) {
    this.src = src;
    this.jsx = opts.jsx !== false;
    this.i = opts.from || 0;
    this.prev = null; // last non-comment token, used for regex/JSX disambiguation
    this.errors = [];
  }

  /** @returns {object|null} next token, or null at end of input */
  nextToken() {
    const src = this.src;
    while (this.i < src.length && WHITESPACE.test(src[this.i])) this.i += 1;
    if (this.i >= src.length) return null;

    const start = this.i;
    const ch = src[start];

    // ------------------------------------------------------------- comments
    if (ch === '/' && src[start + 1] === '/') {
      let j = start + 2;
      while (j < src.length && src[j] !== '\n') j += 1;
      this.i = j;
      return { type: 'comment', value: src.slice(start, j), start, end: j };
    }
    if (ch === '/' && src[start + 1] === '*') {
      const close = src.indexOf('*/', start + 2);
      const j = close === -1 ? src.length : close + 2;
      if (close === -1) this.errors.push({ message: 'unterminated block comment', offset: start });
      this.i = j;
      return { type: 'comment', value: src.slice(start, j), start, end: j };
    }

    // -------------------------------------------------------------- strings
    if (ch === '"' || ch === "'") {
      const end = scanQuoted(src, start);
      if (end === -1) {
        this.errors.push({ message: 'unterminated string literal', offset: start });
        this.i = src.length;
        return this.#emit('string', start, src.length);
      }
      this.i = end;
      return this.#emit('string', start, end);
    }

    // ------------------------------------------------------------ templates
    if (ch === '`') {
      const scanned = scanTemplate(src, start);
      if (scanned === null) {
        this.errors.push({ message: 'unterminated template literal', offset: start });
        this.i = src.length;
        return this.#emit('template', start, src.length);
      }
      this.i = scanned.end;
      return this.#emit('template', start, scanned.end, { segments: scanned.segments });
    }

    // -------------------------------------------------------------- numbers
    if (isDigit(ch) || (ch === '.' && isDigit(src[start + 1]))) {
      const end = scanNumber(src, start);
      this.i = end;
      return this.#emit('number', start, end);
    }

    // ---------------------------------------------------------- identifiers
    if (IDENT_START.test(ch)) {
      let j = start + 1;
      while (j < src.length && IDENT_PART.test(src[j])) j += 1;
      this.i = j;
      return this.#emit('ident', start, j, { keyword: KEYWORDS.has(src.slice(start, j)) });
    }

    // ------------------------------------------------------------------ JSX
    if (this.jsx && ch === '<' && looksLikeJsxStart(this.prev)) {
      const scanned = scanJsxElement(src, start);
      if (scanned) {
        this.i = scanned.end;
        return this.#emit('jsx', start, scanned.end, {
          elements: scanned.elements,
          segments: scanned.segments,
          nodes: scanned.nodes,
        });
      }
    }

    // ---------------------------------------------------------------- regex
    if (ch === '/' && regexAllowedAfter(this.prev)) {
      const end = scanRegex(src, start);
      if (end !== -1) {
        this.i = end;
        return this.#emit('regex', start, end);
      }
    }

    // ----------------------------------------------------------- punctuator
    const punct = matchPunctuator(src, start);
    if (punct) {
      // `a?.5:b` is a ternary followed by a number, not optional chaining.
      if (punct === '?.' && isDigit(src[start + 2])) {
        this.i = start + 1;
        return this.#emit('punct', start, start + 1);
      }
      this.i = start + punct.length;
      return this.#emit('punct', start, start + punct.length);
    }

    this.errors.push({ message: `unexpected character ${JSON.stringify(ch)}`, offset: start });
    this.i = start + 1;
    return this.#emit('punct', start, start + 1);
  }

  #emit(type, start, end, extra) {
    const tok = { type, value: this.src.slice(start, end), start, end };
    if (extra) Object.assign(tok, extra);
    if (type !== 'comment') this.prev = tok;
    return tok;
  }
}

/**
 * Tokenize an entire source string.
 * @returns {{ tokens: Array<object>, errors: Array<{message: string, offset: number}> }}
 */
export function tokenize(src, opts = {}) {
  const lexer = new Lexer(src, opts);
  const tokens = [];
  for (let t = lexer.nextToken(); t; t = lexer.nextToken()) tokens.push(t);
  return { tokens, errors: lexer.errors };
}

/** Tokens with comments removed. */
export function meaningful(tokens) {
  return tokens.filter((t) => t.type !== 'comment');
}

/**
 * All tokens in the file, including tokens inside JSX `{ ... }` containers and
 * inside template literal `${ ... }` interpolations, recursively. Offsets are
 * absolute, so an edit computed from these tokens can be applied straight to
 * the original text.
 */
export function collectTokens(src, opts = {}) {
  const out = [];
  const walk = (from, to) => {
    const lexer = new Lexer(src, { jsx: opts.jsx !== false, from });
    for (let t = lexer.nextToken(); t && t.start < to; t = lexer.nextToken()) {
      out.push(t);
      if (t.segments && (t.type === 'jsx' || t.type === 'template')) {
        for (const seg of t.segments) walk(seg.start, seg.end);
      }
    }
  };
  walk(0, src.length);
  out.sort((a, b) => a.start - b.start || a.end - b.end);
  return out;
}

/* -------------------------------------------------------------------------
 * Round-trip: JSX <-> JavaScript, used only by the syntax validator.
 * ---------------------------------------------------------------------- */

/**
 * Replace every complete JSX element with a single placeholder identifier.
 * The result is ordinary JavaScript, which V8 can parse with `node --check`.
 * This is how JSX files get a real parse check without a JSX parser: the
 * markup itself is checked separately for tag balance by `jsxBalanced`, and
 * the surrounding JavaScript is checked by V8.
 */
export function maskJsx(src, placeholder = '__JSX_placeholder__') {
  const out = [];
  let i = 0;
  let prev = null;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '<') {
      const lexer = new Lexer(src, { from: i });
      const tok = lexer.nextToken();
      if (tok && tok.type === 'jsx') {
        out.push(placeholder);
        i = tok.end;
        prev = { type: 'ident', value: placeholder };
        continue;
      }
    }
    if (ch === '"' || ch === "'") {
      const e = scanQuoted(src, i);
      if (e === -1) {
        out.push(src.slice(i));
        break;
      }
      out.push(src.slice(i, e));
      prev = { type: 'string' };
      i = e;
      continue;
    }
    if (ch === '`') {
      const scanned = scanTemplate(src, i);
      if (scanned === null) {
        out.push(src.slice(i));
        break;
      }
      // A JSX element inside a template interpolation is left in place: the
      // masked text then fails to parse, so the codemod refuses to write the
      // file rather than writing something it could not check.
      out.push(src.slice(i, scanned.end));
      prev = { type: 'template' };
      i = scanned.end;
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') {
      let j = i;
      while (j < src.length && src[j] !== '\n') j += 1;
      out.push(src.slice(i, j));
      i = j;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const c = src.indexOf('*/', i + 2);
      const j = c === -1 ? src.length : c + 2;
      out.push(src.slice(i, j));
      i = j;
      continue;
    }
    if (ch === '/' && regexAllowedAfter(prev)) {
      const e = scanRegex(src, i);
      if (e !== -1) {
        out.push(src.slice(i, e));
        prev = { type: 'regex' };
        i = e;
        continue;
      }
    }
    if (IDENT_START.test(ch)) {
      let j = i + 1;
      while (j < src.length && IDENT_PART.test(src[j])) j += 1;
      out.push(src.slice(i, j));
      const value = src.slice(i, j);
      prev = { type: 'ident', value, keyword: KEYWORDS.has(value) };
      i = j;
      continue;
    }
    if (isDigit(ch)) {
      const e = scanNumber(src, i);
      out.push(src.slice(i, e));
      prev = { type: 'number' };
      i = e;
      continue;
    }
    out.push(ch);
    prev = WHITESPACE.test(ch) ? prev : { type: 'punct', value: ch };
    i += 1;
  }
  return out.join('');
}

/**
 * Verify that every JSX tag in the source is balanced, and report the first
 * problem found. Used as the markup half of JSX syntax validation.
 * @returns {{ ok: boolean, message?: string, offset?: number }}
 */
export function jsxBalanced(src, opts = {}) {
  const stack = [];
  const lexer = new Lexer(src, opts);
  for (let t = lexer.nextToken(); t; t = lexer.nextToken()) {
    if (t.type !== 'jsx') continue;
    // Each top-level JSX token is re-scanned tag by tag for depth checking.
    const res = checkJsxDepth(src, t.start, t.end);
    if (!res.ok) return res;
  }
  return { ok: true };
}

function checkJsxDepth(src, start, end) {
  const stack = [];
  let i = start;
  while (i < end) {
    if (src[i] === '<') {
      if (src[i + 1] === '/') {
        const tag = scanTag(src, i, true);
        if (!tag) return { ok: false, message: `malformed closing tag at offset ${i}`, offset: i };
        const open = stack.pop();
        if (open === undefined) return { ok: false, message: `closing tag </${tag.name}> with no opening tag`, offset: i };
        if (open !== tag.name) {
          return { ok: false, message: `expected </${open}> but found </${tag.name}>`, offset: i };
        }
        i = tag.end;
        continue;
      }
      const tag = scanTag(src, i, false);
      if (!tag) return { ok: false, message: `malformed opening tag at offset ${i}`, offset: i };
      if (!tag.selfClosing) stack.push(tag.name);
      i = tag.end;
      continue;
    }
    i += 1;
  }
  if (stack.length) return { ok: false, message: `unclosed JSX tag <${stack[stack.length - 1]}>` };
  return { ok: true };
}

/* -------------------------------------------------------------------------
 * Low-level scanners
 * ---------------------------------------------------------------------- */

function matchPunctuator(src, i) {
  for (const p of PUNCTUATORS) {
    if (src.startsWith(p, i)) return p;
  }
  return null;
}

function regexAllowedAfter(prev) {
  if (!prev) return true;
  if (prev.type === 'ident') return prev.keyword === true && REGEX_PRECEDING_KEYWORDS.has(prev.value);
  if (prev.type === 'punct') return !NO_REGEX_AFTER.has(prev.value);
  if (prev.type === 'keyword') return REGEX_PRECEDING_KEYWORDS.has(prev.value);
  return false; // number/string/template/regex/jsx -> division
}

function looksLikeJsxStart(prev) {
  if (!prev) return true;
  if (prev.type === 'ident') return prev.keyword === true && REGEX_PRECEDING_KEYWORDS.has(prev.value);
  if (prev.type === 'punct') return !NO_REGEX_AFTER.has(prev.value);
  return false;
}

function scanQuoted(src, start) {
  const quote = src[start];
  let i = start + 1;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === quote) return i + 1;
    if (ch === '\n') return -1; // JS/JSX strings do not span lines
    i += 1;
  }
  return -1;
}

/**
 * Scan a template literal starting at a backtick.
 * Interpolations (`${ ... }`) are recorded as segments so that flags used
 * inside a template still count as references -- a silently missed reference
 * is the worst possible failure for this tool.
 * @returns {{ end: number, segments: Array<{start: number, end: number}> }|null}
 */
function scanTemplate(src, start) {
  const segments = [];
  let i = start + 1;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '`') return { end: i + 1, segments };
    if (ch === '$' && src[i + 1] === '{') {
      const end = matchBalanced(src, i + 1, '{', '}');
      if (end === -1) return null;
      segments.push({ start: i + 2, end });
      i = end + 1;
      continue;
    }
    i += 1;
  }
  return null;
}

function scanNumber(src, start) {
  let i = start;
  if (src[i] === '0' && /[xXbBoO]/.test(src[i + 1] || '')) {
    i += 2;
    while (i < src.length && /[0-9a-fA-F_]/.test(src[i])) i += 1;
  } else {
    while (i < src.length && /[0-9_]/.test(src[i])) i += 1;
    if (src[i] === '.') {
      i += 1;
      while (i < src.length && /[0-9_]/.test(src[i])) i += 1;
    }
    if (src[i] === 'e' || src[i] === 'E') {
      let j = i + 1;
      if (src[j] === '+' || src[j] === '-') j += 1;
      if (isDigit(src[j])) {
        i = j;
        while (i < src.length && /[0-9_]/.test(src[i])) i += 1;
      }
    }
  }
  if (src[i] === 'n') i += 1; // BigInt suffix
  return i;
}

function scanRegex(src, start) {
  let i = start + 1;
  let inClass = false;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '\n') return -1;
    if (inClass) {
      if (ch === ']') inClass = false;
    } else if (ch === '[') {
      inClass = true;
    } else if (ch === '/') {
      i += 1;
      while (i < src.length && /[a-z]/i.test(src[i])) i += 1;
      return i;
    }
    i += 1;
  }
  return -1;
}

/**
 * Given an opening bracket at `start`, return the offset of its matching
 * close, or -1. Uses the Lexer, so strings, templates, comments, regex
 * literals and nested JSX are all skipped correctly.
 */
export function matchBalanced(src, start, open = '{', close = '}') {
  if (src[start] !== open) return -1;
  const lexer = new Lexer(src, { from: start });
  let depth = 0;
  for (let t = lexer.nextToken(); t; t = lexer.nextToken()) {
    if (t.type !== 'punct') continue;
    if (t.value === open) depth += 1;
    else if (t.value === close) {
      depth -= 1;
      if (depth === 0) return t.start;
    }
  }
  return -1;
}

/* -------------------------------------------------------------------------
 * JSX
 * ---------------------------------------------------------------------- */

/**
 * Scan one balanced JSX element starting at `<` (offset `start`).
 * Returns null when the angle brackets do not form a balanced element, so the
 * caller falls back to plain tokenization.
 */
function scanJsxElement(src, start) {
  const elements = [];
  const segments = [];
  const nodes = [];
  const stack = [];
  let i = start;

  const openNode = (tag, parent) => {
    const node = {
      name: tag.name,
      start: tag.start,
      end: tag.end,
      openEnd: tag.end,
      closeStart: null,
      selfClosing: tag.selfClosing,
      parent,
      attrs: tag.attrs,
    };
    nodes.push(node);
    return nodes.length - 1;
  };

  while (i < src.length) {
    const ch = src[i];
    if (ch === '<') {
      const closing = src[i + 1] === '/';
      const tag = scanTag(src, i, closing);
      if (!tag) return null;
      if (!closing) elements.push(tag.name);
      for (const s of tag.segments) segments.push(s);
      i = tag.end;
      if (closing) {
        const idx = stack.pop();
        if (idx === undefined) return null;
        nodes[idx].closeStart = tag.start;
        nodes[idx].end = i;
        if (stack.length === 0) return { end: i, elements, segments, nodes };
        continue;
      }
      const parent = stack.length ? stack[stack.length - 1] : -1;
      const idx = openNode(tag, parent);
      if (tag.selfClosing) {
        if (stack.length === 0) return { end: i, elements, segments, nodes };
        continue;
      }
      stack.push(idx);
      continue;
    }
    if (ch === '{') {
      const end = matchBalanced(src, i, '{', '}');
      if (end === -1) return null;
      segments.push({ start: i + 1, end });
      i = end + 1;
      continue;
    }
    i += 1; // JSX text (may contain quotes, entities, `}`)
  }
  return null;
}

/** Scan `<name ...attrs...>`, `</name>` or `<>` starting at `<`. */
function scanTag(src, start, closing) {
  const segments = [];
  const attrs = [];
  let i = start + 1;
  if (src[i] === '/') i += 1;

  if (src[i] === '>') {
    // Fragment: <> or </>
    return { name: '', start, end: i + 1, selfClosing: false, segments, attrs };
  }

  const nameStart = i;
  while (i < src.length && /[A-Za-z0-9_$.:\-]/.test(src[i])) i += 1;
  const name = src.slice(nameStart, i);
  if (!name) return null;

  if (closing) {
    while (i < src.length && WHITESPACE.test(src[i])) i += 1;
    if (src[i] !== '>') return null;
    return { name, start, end: i + 1, selfClosing: false, segments, attrs };
  }

  while (i < src.length) {
    const ch = src[i];
    if (WHITESPACE.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === '/' && src[i + 1] === '>') {
      return { name, start, end: i + 2, selfClosing: true, segments, attrs };
    }
    if (ch === '>') {
      return { name, start, end: i + 1, selfClosing: false, segments, attrs };
    }
    if (ch === '{') {
      const attrStart = i;
      const end = matchBalanced(src, i, '{', '}');
      if (end === -1) return null;
      segments.push({ start: i + 1, end });
      const spread = src[i + 1] === '.' && src[i + 2] === '.';
      attrs.push({
        name: spread ? '...' : null,
        start: attrStart,
        end: end + 1,
        valueStart: i + 1,
        valueEnd: end,
        valueType: spread ? 'spread' : 'expression',
        literal: null,
      });
      i = end + 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const attrStart = i;
      const e = scanQuoted(src, i);
      if (e === -1) return null;
      // Attribute value for a preceding bare name: recorded by the name branch.
      if (attrs.length && attrs[attrs.length - 1].valueType === 'pending') {
        const attr = attrs[attrs.length - 1];
        attr.valueType = 'string';
        attr.valueStart = i + 1;
        attr.valueEnd = e - 1;
        attr.literal = src.slice(i + 1, e - 1);
        attr.end = e;
        attr.nameEnd = attrStart;
      }
      i = e;
      continue;
    }
    if (ch === '<') {
      const nested = scanJsxElement(src, i);
      if (!nested) return null;
      for (const s of nested.segments) segments.push(s);
      i = nested.end;
      continue;
    }
    if (ch === '=') {
      const attr = attrs[attrs.length - 1];
      if (attr && attr.valueType === 'none') attr.valueType = 'pending';
      i += 1;
      continue;
    }
    if (IDENT_START.test(ch)) {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_$.:\-]/.test(src[j])) j += 1;
      attrs.push({
        name: src.slice(i, j),
        start: i,
        nameEnd: j,
        end: j,
        valueStart: null,
        valueEnd: null,
        valueType: 'none',
        literal: null,
      });
      i = j;
      continue;
    }
    i += 1;
  }
  return null;
}

/* -------------------------------------------------------------------------
 * Position helpers
 * ---------------------------------------------------------------------- */

/** Build a line-start index for O(log n) offset -> line/column lookups. */
export function lineIndex(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i += 1) {
    if (src[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

/** 1-based line and column for a byte offset. */
export function lineCol(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - starts[lo] + 1 };
}

export { KEYWORDS, REGEX_PRECEDING_KEYWORDS };

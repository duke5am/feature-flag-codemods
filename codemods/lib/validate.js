/**
 * validate.js -- prove that rewritten code still parses, before it is written.
 *
 * Part of Feature Flag Cleanup Codemods.
 *
 * Nothing is written to disk until the rewritten text has been parsed. The
 * parser is V8 itself, through `node --check`, which parses without executing,
 * so there is no risk of running the buyer's code. No parser dependency is
 * installed and no network access is needed.
 *
 * What "valid" means per file type, stated precisely because the difference
 * matters:
 *
 *   .js .mjs .cjs   full parse by V8 in module goal (imports/exports allowed)
 *   .ts .mts .cts   type annotations stripped with Node's built-in
 *                   module.stripTypeScriptTypes(), then parsed by V8
 *   .jsx .tsx       JSX elements replaced by a placeholder identifier and the
 *                   result parsed by V8 (this checks the surrounding
 *                   JavaScript) PLUS every JSX tag pair checked for balance
 *                   and correct nesting by this pack's own checker
 *
 * So JSX is not parsed by a real JSX parser here -- that would mean shipping a
 * dependency. It is checked as JavaScript scaffolding plus tag structure. See
 * docs/LIMITATIONS.md: run your own build (tsc, your bundler, your linter)
 * afterwards regardless, which the workflow in docs/WORKFLOW.md requires.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { maskJsx, jsxBalanced, Lexer, tokenize } from './tokenize.js';

/** Load Node's built-in TypeScript stripper without emitting a warning banner. */
async function loadStripper() {
  const mod = await import('node:module');
  if (typeof mod.stripTypeScriptTypes !== 'function') return null;
  return (code) => {
    const original = process.emitWarning;
    process.emitWarning = () => {};
    try {
      return mod.stripTypeScriptTypes(code, { mode: 'strip' });
    } finally {
      process.emitWarning = original;
    }
  };
}

let stripperPromise = null;
/**
 * Strip type annotations. Returns { ok, text, message }: invalid TypeScript
 * makes the stripper throw, and a throw here must become "this does not
 * parse", never an exception that escapes the codemod.
 */
async function stripTypes(code) {
  if (!stripperPromise) stripperPromise = loadStripper();
  const fn = await stripperPromise;
  if (!fn) return { ok: true, text: null, message: 'no TypeScript stripper in this Node version' };
  try {
    return { ok: true, text: fn(code) };
  } catch (err) {
    return { ok: false, text: null, message: String(err && err.message ? err.message : err) };
  }
}

/** Does this path need JSX masking and/or type stripping? */
export function fileKind(filePath) {
  const lower = String(filePath || '').toLowerCase();
  const jsx = lower.endsWith('.jsx') || lower.endsWith('.tsx');
  const ts = lower.endsWith('.ts') || lower.endsWith('.tsx') || lower.endsWith('.mts') || lower.endsWith('.cts');
  return { jsx, ts };
}

/**
 * Collect the inner text of every JSX `{ ... }` expression container in the
 * file, at any depth. Masking a JSX element replaces it wholesale, which would
 * hide a broken expression inside one of its containers, so containers are
 * parsed separately.
 */
function jsxContainers(code) {
  const found = [];
  const walk = (from, to) => {
    const lexer = new Lexer(code, { from });
    for (let t = lexer.nextToken(); t && t.start < to; t = lexer.nextToken()) {
      if (t.type === 'jsx' && t.segments) {
        for (const segment of t.segments) {
          found.push(code.slice(segment.start, segment.end));
          walk(segment.start, segment.end);
        }
      } else if (t.type === 'template' && t.segments) {
        for (const segment of t.segments) walk(segment.start, segment.end);
      }
    }
  };
  walk(0, code.length);
  return found.filter((text) => {
    const stripped = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').trim();
    if (!stripped) return false; // `{/* comment */}` and `{ }` are fine
    if (stripped.startsWith('...')) return false; // `{...props}` is only valid inside JSX
    return true;
  });
}

/** Run `node --check` on a string, returning the result rather than throwing. */
function parseWithV8(text) {
  const dir = mkdtempSync(join(tmpdir(), 'ffc-validate-'));
  const target = join(dir, 'check.mjs');
  try {
    writeFileSync(target, text, 'utf8');
    const res = spawnSync(process.execPath, ['--check', target], { encoding: 'utf8' });
    if (res.status === 0) return { ok: true };
    const stderr = (res.stderr || '')
      .split('\n')
      .filter((line) => line.trim() && !line.includes('Node.js v'))
      .slice(0, 4)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    return { ok: false, message: stderr || `node --check exited ${res.status}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Parse the given source with V8 and report whether it is syntactically valid.
 * Never executes the code.
 *
 * @param {string} code
 * @param {{ file?: string, jsx?: boolean, ts?: boolean }} opts
 * @returns {Promise<{ ok: boolean, method: string, message?: string, jsxChecked?: boolean }>}
 */
export async function validateSyntax(code, opts = {}) {
  const kind = fileKind(opts.file);
  const jsx = opts.jsx === undefined ? kind.jsx : opts.jsx;
  const ts = opts.ts === undefined ? kind.ts : opts.ts;

  const finish = (text) => {
    if (!ts) return Promise.resolve({ text });
    return stripTypes(text).then((stripped) => (stripped.ok
      ? { text: stripped.text }
      : { error: { ok: false, method: 'typescript-strip', message: stripped.message } }));
  };

  const describe = (base) => {
    if (jsx && ts) return `${base} (JSX masked, types stripped)`;
    if (jsx) return `${base} (JSX masked)`;
    if (ts) return `${base} (types stripped)`;
    return base;
  };

  if (jsx) {
    const balance = jsxBalanced(code);
    if (!balance.ok) {
      return {
        ok: false,
        method: 'jsx-tag-balance',
        jsxChecked: false,
        message: `JSX structure broken after rewrite: ${balance.message}`,
      };
    }
  }

  const prepared = await finish(jsx ? maskJsx(code) : code);
  if (prepared.error) return { ...prepared.error, jsxChecked: jsx };

  const main = parseWithV8(prepared.text);
  if (!main.ok) {
    return { ok: false, method: describe('node --check'), jsxChecked: jsx, message: main.message };
  }

  if (jsx) {
    const containers = jsxContainers(code);
    if (containers.length) {
      const wrapped = containers
        .map((text, i) => `async function __container${i}() {\n  return (\n${maskJsx(text)}\n  );\n}`)
        .join('\n');
      const containerCheck = await finish(wrapped);
      if (containerCheck.error) {
        return { ...containerCheck.error, jsxChecked: false };
      }
      const res = parseWithV8(containerCheck.text);
      if (!res.ok) {
        return {
          ok: false,
          method: describe('node --check (JSX containers)'),
          jsxChecked: false,
          message: `a JSX expression container does not parse: ${res.message}`,
        };
      }
    }
  }

  return { ok: true, method: describe('node --check'), jsxChecked: jsx };
}

/**
 * A cheap pre-flight on the result, using the same lexer as the transforms, so
 * that strings, templates, comments and regex literals cannot be mistaken for
 * brackets. JSX is opaque to the lexer, so this complements rather than
 * replaces the JSX tag check.
 */
export function bracketBalance(code) {
  const pairs = { ')': '(', ']': '[', '}': '{' };
  const stack = [];
  let line = 1;
  const { tokens, errors } = tokenize(code);
  if (errors.length) return { ok: false, message: `lexer: ${errors[0].message}` };
  for (const token of tokens) {
    if (token.value === '\n') line += 1;
    if (token.type === 'comment') line += (token.value.match(/\n/g) || []).length;
    if (token.type !== 'punct') continue;
    if (token.value === '(' || token.value === '[' || token.value === '{') {
      stack.push(token);
      continue;
    }
    if (!pairs[token.value]) continue;
    const top = stack.pop();
    if (!top || top.value !== pairs[token.value]) {
      return { ok: false, message: `unbalanced "${token.value}" at offset ${token.start}` };
    }
  }
  if (stack.length) {
    const open = stack[stack.length - 1];
    return { ok: false, message: `unclosed "${open.value}" at offset ${open.start}` };
  }
  return { ok: true };
}

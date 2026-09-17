/**
 * inventory.js -- find every feature flag a codebase mentions.
 *
 * Part of Feature Flag Cleanup Codemods.
 *
 * This is what find-stale-flags is built on. It does not need to be told any
 * flag names: it recognises the shapes a flag reference takes and reports the
 * name it found, how many times, and where.
 *
 * Recognised:
 *   flags.new_ui                      featureFlags?.new_ui         ff['new_ui']
 *   useFlag('new_ui')                 isFeatureEnabled('new_ui', false)
 *   const { new_ui } = useFlags()     const { new_ui: on } = flagsContext()
 *   <FeatureFlag name="new_ui">       withFeatureFlag('new_ui')(Page)
 *
 * Reported separately, because the name cannot be resolved statically:
 *   flags[userKey]                    useFlag(someName)
 *
 * Reported as advisory only (the string may be unrelated to any flag):
 *   anyOtherSdk('new_ui')
 */

import { meaningful, collectTokens, lineIndex, lineCol, tokenize } from './tokenize.js';
import { buildIndex } from './scan.js';
import { defaultConfig, isObjectRoot, literalNameAt, callCalleeAt } from './flags.js';
import { DEFAULT_WRAPPER_PROPS } from './analyze.js';

/**
 * Scan one file.
 * @param {string} src
 * @param {{ config?: object, propNames?: string[] }} [opts]
 * @returns {{ references: Array<object>, dynamic: Array<object>, advisories: Array<object> }}
 */
const FLAG_NAME_SHAPE = /^[A-Za-z_][A-Za-z0-9_.:-]*$/;

export function inventoryFile(src, opts = {}) {
  const config = opts.config || defaultConfig();
  const propNames = opts.propNames || DEFAULT_WRAPPER_PROPS;
  const toks = meaningful(collectTokens(src));
  const index = buildIndex(toks);
  const lines = lineIndex(src);
  const at = (offset) => lineCol(lines, offset);

  const references = [];
  const dynamic = [];
  const advisories = [];
  const add = (name, form, offset, extra = {}) => {
    const pos = at(offset);
    references.push({ name, form, offset, line: pos.line, column: pos.column, ...extra });
  };

  for (let i = 0; i < toks.length; i += 1) {
    const t = toks[i];

    // ------------------------------------------------------- flags.new_ui
    if (t.type === 'ident' && isObjectRoot(t.value, config)) {
      const dot = toks[i + 1];
      const prop = toks[i + 2];
      const isRoot = !(toks[i - 1] && toks[i - 1].type === 'punct' && (toks[i - 1].value === '.' || toks[i - 1].value === '?.'));
      if (isRoot && dot && dot.type === 'punct' && (dot.value === '.' || dot.value === '?.') && prop && prop.type === 'ident') {
        add(prop.value, 'member', prop.start, { object: t.value });
      }
      // --------------------------------------------- flags['new_ui'] / flags[k]
      const bracket = toks[i + 1];
      if (isRoot && bracket && bracket.type === 'punct' && bracket.value === '[') {
        const closeIdx = index.open.get(i + 1);
        if (closeIdx !== undefined) {
          const keyToks = toks.slice(i + 2, closeIdx);
          const literal = keyToks.length === 1 ? literalNameAt(keyToks[0]) : null;
          if (literal !== null) add(literal, 'member-index', t.start, { object: t.value });
          else {
            const pos = at(t.start);
            dynamic.push({
              kind: 'computed-member',
              value: keyToks.map((x) => x.value).join(' '),
              line: pos.line,
              column: pos.column,
              offset: t.start,
            });
          }
        }
      }
    }

    // ------------------------------------------------- useFlag('new_ui')
    if (t.type === 'ident' && config.flagFunctions.includes(t.value)) {
      const paren = toks[i + 1];
      if (paren && paren.type === 'punct' && paren.value === '(') {
        const closeIdx = index.open.get(i + 1);
        if (closeIdx !== undefined) {
          const argToks = toks.slice(i + 2, closeIdx);
          const literal = argToks.length ? literalNameAt(argToks[0]) : null;
          if (literal !== null) add(literal, 'call', t.start, { call: t.value });
          else if (argToks.length) {
            const pos = at(t.start);
            dynamic.push({
              kind: 'computed-call',
              value: argToks.map((x) => x.value).join(' '),
              line: pos.line,
              column: pos.column,
              offset: t.start,
            });
          }
        }
      }
    }

    // ------------------------------ const { new_ui } = useFlags() / flagObject
    if (
      t.type === 'ident' && (t.value === 'const' || t.value === 'let' || t.value === 'var') &&
      toks[i + 1] && toks[i + 1].type === 'punct' && toks[i + 1].value === '{'
    ) {
      const braceOpen = i + 1;
      const braceClose = index.open.get(braceOpen);
      if (braceClose !== undefined) {
        const eq = toks[braceClose + 1];
        const rhs = toks[braceClose + 2];
        const rhsIsFlags = rhs && (
          (rhs.type === 'ident' && isObjectRoot(rhs.value, config)) ||
          (rhs.type === 'ident' && config.flagFunctions.includes(rhs.value))
        );
        if (eq && eq.value === '=' && rhsIsFlags) {
          for (let k = braceOpen + 1; k < braceClose; k += 1) {
            const prop = toks[k];
            if (prop.type === 'punct' && prop.value === '[') {
              const inner = index.open.get(k);
              if (inner !== undefined) {
                const pos = at(prop.start);
                dynamic.push({
                  kind: 'computed-destructure',
                  value: toks.slice(k + 1, inner).map((x) => x.value).join(' '),
                  line: pos.line,
                  column: pos.column,
                  offset: prop.start,
                });
                k = inner;
              }
              continue;
            }
            if (prop.type !== 'ident') continue;
            const prev = toks[k - 1];
            const next = toks[k + 1];

            // `{ flag_name: localName }` -- the key is what names the flag.
            if (prev && prev.type === 'punct' && prev.value === ':') {
              const key = toks[k - 2];
              if (key && key.type === 'ident') {
                add(key.value, 'destructured', key.start, { source: rhs.value, local: prop.value });
              }
              continue;
            }
            if (prev && prev.type === 'punct' && prev.value === '...') continue; // spread element
            if (next && next.type === 'punct' && next.value === ':') continue; // handled from the local name
            if (next && next.type === 'punct' && (next.value === ',' || next.value === '}' || next.value === '=')) {
              add(prop.value, 'destructured', prop.start, { source: rhs.value });
            }
          }
        }
      }
    }
  }

  // ------------------------------------------------------- wrapper components
  for (const tok of toks) {
    if (tok.type !== 'jsx' || !tok.nodes) continue;
    for (const node of tok.nodes) {
      if (config.wrapperComponents.includes(node.name)) {
        const attr = node.attrs.find((a) => a.name && propNames.includes(a.name));
        if (!attr) continue;
        if (attr.valueType === 'string') add(attr.literal, 'wrapper-component', node.start, { component: node.name });
        else {
          const pos = at(node.start);
          dynamic.push({
            kind: 'wrapper-name',
            value: attr.valueType === 'expression' ? src.slice(attr.valueStart, attr.valueEnd).trim() : attr.valueType,
            line: pos.line,
            column: pos.column,
            offset: node.start,
          });
        }
      }
      if (config.wrapperComponents.includes(node.name)) continue;
    }
  }

  // ------------------------------------------------------------------ HOCs
  for (let i = 0; i < toks.length; i += 1) {
    const t = toks[i];
    if (t.type !== 'ident' || !config.hocFunctions.includes(t.value)) continue;
    const open1 = i + 1;
    if (!(toks[open1] && toks[open1].value === '(')) continue;
    const close1 = index.open.get(open1);
    if (close1 === undefined) continue;
    const argToks = toks.slice(open1 + 1, close1);
    const literal = argToks.length ? literalNameAt(argToks[0]) : null;
    if (literal !== null) add(literal, 'hoc', t.start, { call: t.value });
  }

  // ------------------------------------- string literals in unknown calls
  for (let i = 0; i < toks.length; i += 1) {
    const t = toks[i];
    const literal = literalNameAt(t);
    if (literal === null) continue;
    const callee = callCalleeAt(toks, i);
    if (callee === null) continue;
    if (config.flagFunctions.includes(callee)) continue;
    // A flag name is identifier-shaped. Empty strings, whitespace and prose are
    // not flag names, and listing them would drown the real candidates.
    if (!FLAG_NAME_SHAPE.test(literal)) continue;
    const pos = at(t.start);
    advisories.push({
      kind: 'unknown-api',
      name: literal,
      call: callee,
      line: pos.line,
      column: pos.column,
      offset: t.start,
    });
  }

  return { references, dynamic, advisories };
}

/**
 * Aggregate an inventory over many files.
 * @param {Array<{ path: string, src: string }>} files
 * @param {{ config?: object, propNames?: string[], minRefs?: number }} [opts]
 */
export function buildInventory(files, opts = {}) {
  const minRefs = opts.minRefs === undefined ? 1 : opts.minRefs;
  const byName = new Map();
  const dynamicLookups = [];
  const unknownApis = [];
  let parseWarnings = 0;

  for (const file of files) {
    if (tokenize(file.src).errors.length) parseWarnings += 1;
    const result = inventoryFile(file.src, opts);
    for (const ref of result.references) {
      if (!byName.has(ref.name)) {
        byName.set(ref.name, { name: ref.name, references: 0, files: new Map(), forms: new Map() });
      }
      const entry = byName.get(ref.name);
      entry.references += 1;
      entry.forms.set(ref.form, (entry.forms.get(ref.form) || 0) + 1);
      if (!entry.files.has(file.path)) entry.files.set(file.path, { path: file.path, references: 0, lines: [] });
      const bucket = entry.files.get(file.path);
      bucket.references += 1;
      bucket.lines.push(ref.line);
    }
    for (const d of result.dynamic) dynamicLookups.push({ file: file.path, ...d });
    for (const a of result.advisories) unknownApis.push({ file: file.path, ...a });
  }

  const flags = [...byName.values()]
    .map((entry) => ({
      name: entry.name,
      references: entry.references,
      files: [...entry.files.values()]
        .map((f) => ({ ...f, lines: [...f.lines].sort((a, b) => a - b) }))
        .sort((a, b) => b.references - a.references || a.path.localeCompare(b.path)),
      forms: Object.fromEntries(entry.forms),
      dynamicNameRisk: dynamicLookups.length > 0,
    }))
    .filter((entry) => entry.references >= minRefs)
    .sort((a, b) => a.references - b.references || a.name.localeCompare(b.name));

  return {
    flags,
    dynamicLookups,
    unknownApis,
    summary: {
      flags: flags.length,
      references: flags.reduce((sum, f) => sum + f.references, 0),
      files: new Set(flags.flatMap((f) => f.files.map((x) => x.path))).size,
      dynamicLookups: dynamicLookups.length,
      unknownApis: unknownApis.length,
      parseWarnings,
      minRefs,
    },
  };
}

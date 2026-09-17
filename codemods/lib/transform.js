/**
 * transform.js -- apply the plan to one file, then prove the result parses.
 *
 * Part of Feature Flag Cleanup Codemods.
 *
 * The pipeline for one file:
 *
 *   1. analyse   -- find every reference to the flag, plan or refuse each one
 *   2. rewrite   -- apply the safe plans, in passes, because unwrapping a
 *                   wrapper can reveal another wrapper inside it
 *   3. prune     -- delete the declarations that our own edits made unused: the
 *                   flag alias, the destructured flag property, and the import
 *                   bindings for the wrapper or flag object we removed
 *   4. validate  -- parse the result with V8 (`node --check`). If it does not
 *                   parse, the file is returned UNCHANGED with a
 *                   VALIDATION_FAILED refusal.
 *
 * Step 4 is what makes this safe to run over a real repository: a bug in this
 * codemod cannot write a file that does not parse, because nothing is written
 * until the parse succeeds.
 *
 * Refusals are reported from the FINAL state of the file, not from an
 * intermediate pass, so every warning a buyer sees refers to a line that still
 * exists.
 */

import { meaningful, collectTokens, lineIndex, lineCol } from './tokenize.js';
import { buildIndex } from './scan.js';
import {
  analyzeFlagRemoval, analyzeWrapper, expandStatementDeletion, REFUSALS,
  DEFAULT_WRAPPER_PROPS,
} from './analyze.js';
import { defaultConfig } from './flags.js';
import { validateSyntax, bracketBalance } from './validate.js';

const MAX_PASSES = 64;
const MAX_PRUNE_ROUNDS = 32;

/**
 * @param {string} src
 * @param {object} opts
 * @param {'on'|'off'|'unwrap'} opts.mode
 * @param {string} opts.flag
 * @param {string} [opts.file]
 * @param {object} [opts.config]
 * @param {string[]} [opts.propNames]
 * @param {Set<string>} [opts.allowed]
 * @param {boolean} [opts.assumeBoolean]
 */
export async function transformFile(src, opts) {
  const mode = opts.mode;
  const file = opts.file;
  const allowed = opts.allowed || new Set();
  const config = opts.config || defaultConfig();
  const propNames = opts.propNames || DEFAULT_WRAPPER_PROPS;

  const applied = [];
  const pruned = [];
  // Advisories come from two places and both matter:
  //   - the analysis of each pass, which describes what a rewrite removed or
  //     left dead (those constructs no longer exist in the final text);
  //   - the final analysis, which describes what is still there.
  const passAdvisories = [];

  const analyse = (text) => {
    if (mode === 'unwrap') return analyzeWrapper(text, { flag: opts.flag, config, propNames, file });
    return analyzeFlagRemoval(text, {
      flag: opts.flag,
      mode,
      config,
      allowed,
      assumeBoolean: opts.assumeBoolean,
      file,
    });
  };

  let text = src;
  const initial = analyse(text);

  // A file-level refusal means: do not touch this file at all.
  const blocked = initial.refusals.some(
    (r) => !r.relaxed && (r.code === 'UNPARSEABLE' || r.code === 'DYNAMIC_FLAG_NAME'),
  );
  if (blocked) {
    // Advisories that describe an edit must not survive here: nothing was
    // edited, so "the code after the guard is now dead" would be a lie.
    const editAdvice = new Set(['DEAD_CODE_AFTER_GUARD', 'COMMENT_REMOVED', 'SHARED_MUTATION', 'LOOP_CARRIED_MUTATION']);
    return finish(src, src, {
      changed: false,
      refusals: initial.refusals,
      advisories: initial.advisories.filter((a) => !editAdvice.has(a.code)),
      applied, pruned, validation: null, passes: 0, blocked: true,
    });
  }

  const removedNames = new Set(initial.removedNames || []);
  const candidateNames = new Set(removedNames);
  const noteCandidates = (analysis, sourceText) => {
    for (const ref of (analysis.refs && analysis.refs.static) || []) {
      if ((ref.form === 'member' || ref.form === 'member-index') && ref.object) {
        candidateNames.add(ref.object);
      } else if ((ref.form === 'member' || ref.form === 'member-index')) {
        const root = rootNameAt(sourceText, ref.start);
        if (root) candidateNames.add(root);
      } else if (ref.form === 'call' && ref.callName) {
        candidateNames.add(ref.callName);
      } else if (ref.form === 'destructured' && ref.source) {
        candidateNames.add(ref.source);
        if (ref.local) candidateNames.add(ref.local);
      }
    }
  };
  // Candidates must be collected from the text as it was BEFORE the rewrite:
  // afterwards there are no references left to learn the names from.
  noteCandidates(initial, text);

  // ---------------------------------------------------------------- rewrite
  let passes = 0;
  for (; passes < MAX_PASSES; passes += 1) {
    const analysis = passes === 0 ? initial : analyse(text);
    if (passes !== 0) {
      for (const n of analysis.removedNames || []) removedNames.add(n);
      noteCandidates(analysis, text);
    }

    const sites = dedupeSites(analysis.sites);
    if (!sites.length) break;
    passAdvisories.push(...(analysis.advisories || []));

    const lines = lineIndex(text);
    const ordered = [...sites].sort((a, b) => b.start - a.start);
    let boundary = Infinity;
    let appliedThisPass = 0;
    for (const site of ordered) {
      if (site.end > boundary) continue; // overlaps an edit already applied
      const at = lineCol(lines, site.start);
      applied.push({ kind: site.kind, note: site.note, line: at.line, dropped: site.dropped });
      text = text.slice(0, site.start) + site.replacement + text.slice(site.end);
      boundary = site.start;
      appliedThisPass += 1;
    }
    if (!appliedThisPass) break;
  }
  if (passes >= MAX_PASSES) {
    // Practically unreachable (nested wrappers need one pass per level), but a
    // silently unfinished rewrite is the "half-removed flag" failure mode, so
    // it is reported rather than passed over.
    const leftover = analyse(text).sites.length;
    if (leftover) {
      passAdvisories.push({
        code: 'PASS_LIMIT_REACHED',
        line: 1,
        column: 1,
        offset: 0,
        file,
        message: `${MAX_PASSES} rewrite passes were not enough to finish this file; ${leftover} rewrite(s) still remain. The rewrites that were made are safe, but check this file by hand.`,
      });
    }
  }

  // ---------------------------------------------------------------- pruning
  for (let round = 0; round < MAX_PRUNE_ROUNDS; round += 1) {
    const fresh = analyse(text);
    const target = (fresh.aliasDecls || []).find((r) => countRemainingAliasUses(text, r) === 0);
    if (!target) break;
    const edit = planDeclarationRemoval(text, target);
    if (!edit) break;
    const line = lineCol(lineIndex(text), edit.start).line;
    const next = text.slice(0, edit.start) + edit.replacement + text.slice(edit.end);
    if (next === text) break;
    text = next;
    pruned.push({ what: `unused flag binding "${target.name}"`, line, kind: edit.kind });
  }

  const candidates = new Set([...removedNames, ...candidateNames]);
  const after = analyse(text);
  for (const ref of after.refs && after.refs.static ? after.refs.static : []) {
    if ((ref.form === 'member' || ref.form === 'member-index') && ref.object) {
      candidates.add(ref.object);
    } else if (ref.form === 'call' && ref.callName) {
      candidates.add(ref.callName);
    }
  }
  for (const record of after.aliasDecls || []) candidates.add(record.name);
  const importResult = pruneImports(text, candidates);
  if (importResult.removed.length) {
    text = importResult.text;
    for (const name of importResult.removed) {
      pruned.push({ what: `unused import binding "${name}"`, line: null, kind: 'import' });
    }
  }

  if (text === src) {
    return finish(src, src, {
      changed: false, refusals: initial.refusals, advisories: initial.advisories,
      applied, pruned, validation: null, passes,
    });
  }

  // -------------------------------------------------------------- validating
  const balance = bracketBalance(text);
  if (!balance.ok) {
    return finish(src, src, {
      changed: false,
      refusals: [...analyse(text).refusals, syntheticRefusal(file, 'VALIDATION_FAILED', `bracket check failed after the rewrite (${balance.message}); the file was left untouched. This is a bug in the codemod -- please report it with the file that triggered it.`)],
      advisories: [...analyse(text).advisories, ...passAdvisories],
      applied: [], pruned: [],
      validation: { ok: false, method: 'bracket-balance', message: balance.message },
      passes,
    });
  }

  const validation = await validateSyntax(text, { file });
  const finalAnalysis = analyse(text);
  if (!validation.ok) {
    return finish(src, src, {
      changed: false,
      refusals: [...finalAnalysis.refusals, syntheticRefusal(file, 'VALIDATION_FAILED', `the rewritten file did not parse (${validation.method}): ${validation.message} The file was left untouched. This is a bug in the codemod -- please report it with the file that triggered it.`)],
      advisories: [...finalAnalysis.advisories, ...passAdvisories],
      applied: [], pruned: [],
      validation,
      passes,
    });
  }

  return finish(src, text, {
    changed: true,
    refusals: finalAnalysis.refusals,
    advisories: [...finalAnalysis.advisories, ...passAdvisories],
    applied, pruned, validation, passes,
  });
}

function finish(original, output, extra) {
  return {
    original,
    output,
    changed: extra.changed,
    refusals: dedupeRefusals(extra.refusals),
    advisories: dedupeAdvisories(extra.advisories),
    applied: extra.applied,
    pruned: extra.pruned,
    validation: extra.validation,
    passes: extra.passes,
    blocked: Boolean(extra.blocked),
  };
}

function syntheticRefusal(file, code, message) {
  return {
    code,
    message,
    line: 1,
    column: 1,
    offset: 0,
    file,
    downgradable: REFUSALS[code] ? REFUSALS[code].downgradable : false,
    relaxed: false,
  };
}

function dedupeSites(sites) {
  const seen = new Set();
  const out = [];
  for (const site of sites) {
    const key = `${site.start}:${site.end}:${site.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(site);
  }
  return out;
}

function dedupeRefusals(refusals) {
  const seen = new Set();
  const out = [];
  for (const r of refusals) {
    const key = `${r.code}:${r.line}:${r.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out.sort((a, b) => a.line - b.line || a.column - b.column);
}

function dedupeAdvisories(advisories) {
  const seen = new Set();
  const out = [];
  for (const a of advisories) {
    const key = `${a.code}:${a.line}:${a.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out.sort((a, b) => a.line - b.line);
}

/* -------------------------------------------------------------------------
 * Reference counting and pruning
 * ---------------------------------------------------------------------- */

/**
 * How many readers an alias or destructured binding has left, ignoring the
 * binding's own declaration. Zero means the declaration can be deleted.
 */
export function countRemainingAliasUses(text, record) {
  const toks = meaningful(collectTokens(text));
  let count = 0;
  for (const t of toks) {
    if (t.type !== 'ident' || t.value !== record.name) continue;
    if (record.kind === 'variable' && t.start >= record.declStart && t.start < record.declEnd) continue;
    if (record.kind === 'destructured' && t.start >= record.propStart && t.start < record.propEnd) continue;
    count += 1;
  }
  return count;
}

/**
 * How many references to `name` remain in the text. JSX tag names count: they
 * live inside opaque JSX tokens, and forgetting them would delete an import
 * that is still in use.
 */
export function countNameOccurrences(text, name) {
  const toks = meaningful(collectTokens(text));
  let count = 0;
  for (const t of toks) {
    if (t.type === 'ident' && t.value === name) count += 1;
    else if (t.type === 'jsx' && t.nodes) {
      for (const node of t.nodes) if (node.name === name) count += 1;
    }
  }
  return count;
}

function rootNameAt(text, offset) {
  const toks = meaningful(collectTokens(text));
  const tok = toks.find((t) => t.start === offset);
  return tok && tok.type === 'ident' ? tok.value : null;
}

/** Build the edit that deletes an unused alias or destructured binding. */
function planDeclarationRemoval(text, record) {
  if (record.kind === 'variable') {
    const del = expandStatementDeletion(text, record.declStart, record.declEnd);
    return { start: del.start, end: del.end, replacement: '', kind: 'declaration' };
  }
  if (record.kind === 'destructured') {
    // Never delete a whole declaration while another name it binds is still
    // read: that would leave those reads holding undefined. This is the
    // difference between deleting `const { a } = x` and deleting `const { a, b } = x`.
    const otherStillUsed = (record.otherNames || []).some(
      (name) => countNameOccurrences(text, name) > 0,
    );
    if (countDestructuredProps(text, record) <= 1 && !otherStillUsed) {
      const del = expandStatementDeletion(text, record.statementStart, record.statementEnd);
      return { start: del.start, end: del.end, replacement: '', kind: 'declaration' };
    }
    let start = record.propStart;
    let end = record.propEnd;
    while (start > 0 && (text[start - 1] === ' ' || text[start - 1] === '\t')) start -= 1;
    let k = end;
    while (k < text.length && (text[k] === ' ' || text[k] === '\t')) k += 1;
    if (text[k] === ',') {
      end = k + 1;
    } else {
      let p = start;
      while (p > 0 && /\s/.test(text[p - 1])) p -= 1;
      if (text[p - 1] === ',') start = p - 1;
    }
    return { start, end, replacement: '', kind: 'property' };
  }
  return null;
}

function countDestructuredProps(text, record) {
  if (record.declarationStartIdx === undefined) return 1;
  const toks = meaningful(collectTokens(text));
  const index = buildIndex(toks);
  const openIdx = record.declarationStartIdx + 1;
  const closeIdx = index.open.get(openIdx);
  if (closeIdx === undefined) return 1;
  let depth = 0;
  let count = 0;
  for (let i = openIdx + 1; i < closeIdx; i += 1) {
    const t = toks[i];
    if (t.type !== 'punct') continue;
    if (t.value === '{' || t.value === '[' || t.value === '(') depth += 1;
    else if (t.value === '}' || t.value === ']' || t.value === ')') depth -= 1;
    else if (t.value === ',' && depth === 0) count += 1;
  }
  return count + 1;
}

/**
 * Remove import bindings that are no longer referenced anywhere in the file.
 * Only names in `candidates` are considered: this codemod cleans up after
 * itself, it is not an unused-import linter.
 * @returns {{ text: string, removed: string[] }}
 */
export function pruneImports(text, candidates) {
  if (!candidates || !candidates.size) return { text, removed: [] };
  let current = text;
  const removed = [];

  for (let iteration = 0; iteration < 32; iteration += 1) {
    const found = findUnusedImportBinding(current, candidates, removed);
    if (!found) break;
    const before = current;
    if (found.wholeStatement) {
      const del = expandStatementDeletion(current, found.statementStart, found.statementEnd);
      let end = del.end;
      const previousLineIsBlank = del.start >= 2 && current[del.start - 1] === '\n' && current[del.start - 2] === '\n';
      const nextLineIsBlank = current[end] === '\n';
      if (previousLineIsBlank && nextLineIsBlank) {
        // Do not leave two blank lines where the import used to be.
        end += 1;
      } else if (del.start === 0 && nextLineIsBlank) {
        // An import on the first line would leave a blank first line.
        end += 1;
      }
      current = current.slice(0, del.start) + current.slice(end);
    } else {
      current = current.slice(0, found.start) + current.slice(found.end);
    }
    if (current === before) break;
    removed.push(found.name);
  }
  return { text: current, removed };
}

function findUnusedImportBinding(text, candidates, alreadyRemoved) {
  const toks = meaningful(collectTokens(text));

  for (let i = 0; i < toks.length; i += 1) {
    const t = toks[i];
    if (!(t.type === 'ident' && t.value === 'import')) continue;
    const next = toks[i + 1];
    if (next && next.type === 'punct' && next.value === '(') continue; // dynamic import()

    let specIdx = -1;
    for (let j = i + 1; j < toks.length; j += 1) {
      if (toks[j].type === 'string') {
        specIdx = j;
        break;
      }
      if (toks[j].type === 'punct' && toks[j].value === ';') break;
    }
    if (specIdx === -1) continue;
    const statementStart = t.start;
    let statementEnd = toks[specIdx].end;
    const semi = toks[specIdx + 1];
    if (semi && semi.type === 'punct' && semi.value === ';') statementEnd = semi.end;
    const inImport = (offset) => offset >= statementStart && offset < statementEnd;

    // Bindings introduced by this import clause.
    const bindings = [];
    for (let j = i + 1; j < specIdx; j += 1) {
      const tok = toks[j];
      if (tok.type !== 'ident') continue;
      if (tok.value === 'from' || tok.value === 'type') continue;
      const prev = toks[j - 1];
      if (prev && prev.type === 'punct' && (prev.value === '.' || prev.value === '*')) continue;
      bindings.push(j);
    }

    for (const idx of bindings) {
      const tok = toks[idx];
      if (!candidates.has(tok.value)) continue;
      if (alreadyRemoved.includes(tok.value)) continue;
      const occurrences = countNameIdentifierOffsets(toks, tok.value);
      const outside = occurrences.filter((offset) => !inImport(offset));
      if (outside.length) continue;

      const others = bindings.filter((j) => j !== idx);
      if (others.length === 0) {
        return { name: tok.value, wholeStatement: true, statementStart, statementEnd };
      }

      // Extend over `source as local` and over an adjacent comma.
      let startIdx = idx;
      let endIdx = idx;
      const prevTok = toks[idx - 1];
      const nextTok = toks[idx + 1];
      if (prevTok && prevTok.type === 'ident' && prevTok.value === 'as' && toks[idx - 2]) startIdx = idx - 2;
      if (nextTok && nextTok.type === 'ident' && nextTok.value === 'as' && toks[idx + 2]) endIdx = idx + 2;

      let start = toks[startIdx].start;
      let end = toks[endIdx].end;
      const after = toks[endIdx + 1];
      if (after && after.type === 'punct' && after.value === ',') {
        end = after.end;
        // Keep the clause tidy: `{ a, b }` minus `a` should read `{ b }`.
        while (text[end] === ' ' || text[end] === '\t') end += 1;
      } else if (toks[startIdx - 1] && toks[startIdx - 1].type === 'punct' && toks[startIdx - 1].value === ',') {
        start = toks[startIdx - 1].start;
      } else {
        while (text[end] === ' ' || text[end] === '\t') end += 1;
      }
      return { name: tok.value, wholeStatement: false, start, end };
    }
  }
  return null;
}

function countNameIdentifierOffsets(toks, name) {
  const out = [];
  for (const t of toks) {
    if (t.type === 'ident' && t.value === name) out.push(t.start);
    else if (t.type === 'jsx' && t.nodes) {
      for (const node of t.nodes) if (node.name === name) out.push(node.start);
    }
  }
  return out;
}

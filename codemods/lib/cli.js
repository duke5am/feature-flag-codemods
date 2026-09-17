/**
 * cli.js -- shared command line behaviour for the four codemods.
 *
 * Part of Feature Flag Cleanup Codemods.
 *
 * Contract shared by every tool in this pack:
 *
 *   DRY RUN BY DEFAULT. Nothing is written unless --write is passed. The
 *   default output is a unified diff of what would change.
 *
 *   --check writes nothing and exits 3 when a change is needed, so CI can
 *   fail on "this flag still has references".
 *
 * Exit codes
 *   0  ran cleanly, nothing refused
 *   1  usage error, missing --flag, or an internal failure
 *   2  at least one reference was refused (a human must look at it)
 *   3  --check and at least one file would change
 */

import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { collectFiles, displayPath, DEFAULT_EXTENSIONS } from './walk.js';
import { transformFile } from './transform.js';
import { buildInventory } from './inventory.js';
import { unifiedDiff, diffStat } from './diff.js';
import { defaultConfig } from './flags.js';
import { DEFAULT_WRAPPER_PROPS } from './analyze.js';

export const VERSION = '1.0.0';

/* -------------------------------------------------------------------------
 * Argument parsing
 * ---------------------------------------------------------------------- */

/**
 * @param {string[]} argv
 * @param {object} spec { booleans: [], strings: [], lists: [], aliases: {} }
 */
export function parseArgs(argv, spec) {
  const options = { _: [] };
  const aliases = spec.aliases || {};
  const takesValue = new Set([...(spec.strings || []), ...(spec.lists || [])]);
  const isBoolean = new Set(spec.booleans || []);
  const isList = new Set(spec.lists || []);

  for (let i = 0; i < argv.length; i += 1) {
    let arg = argv[i];
    if (arg === '--') {
      options._.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      let key = arg.slice(2);
      let inlineValue = null;
      const eq = key.indexOf('=');
      if (eq !== -1) {
        inlineValue = key.slice(eq + 1);
        key = key.slice(0, eq);
      }
      key = aliases[key] || key;
      if (isBoolean.has(key)) {
        options[key] = inlineValue === null ? true : inlineValue !== 'false';
        continue;
      }
      if (takesValue.has(key)) {
        const value = inlineValue === null ? argv[++i] : inlineValue;
        if (value === undefined) {
          options.__error = `option --${key} needs a value`;
          return options;
        }
        if (isList.has(key)) {
          options[key] = [...(options[key] || []), ...String(value).split(',').map((v) => v.trim()).filter(Boolean)];
        } else {
          options[key] = value;
        }
        continue;
      }
      options.__error = `unknown option --${key}`;
      return options;
    }
    options._.push(arg);
  }
  return options;
}

const SHARED_BOOLEANS = ['write', 'dry-run', 'check', 'json', 'quiet', 'help', 'version', 'assume-boolean', 'verbose'];
const SHARED_STRINGS = ['flag', 'root', 'ext', 'context', 'allow', 'object', 'function', 'prop', 'component', 'hoc'];
const SHARED_LISTS = ['ignore'];

function sharedSpec() {
  return {
    booleans: SHARED_BOOLEANS,
    strings: SHARED_STRINGS.filter((k) => k !== 'ext' && k !== 'allow' && k !== 'object' && k !== 'function' && k !== 'prop' && k !== 'component' && k !== 'hoc'),
    lists: [...SHARED_LISTS, 'ext', 'allow', 'object', 'function', 'prop', 'component', 'hoc'],
  };
}

/* -------------------------------------------------------------------------
 * Configuration
 * ---------------------------------------------------------------------- */

function buildConfig(options) {
  const config = defaultConfig();
  if (options.object) config.objectNames.push(...options.object);
  if (options.function) config.flagFunctions.push(...options.function);
  if (options.component) config.wrapperComponents.push(...options.component);
  if (options.hoc) config.hocFunctions.push(...options.hoc);
  return config;
}

function resolveRoots(options) {
  const cwd = process.cwd();
  const roots = options._.length ? options._.map((p) => (isAbsolute(p) ? p : resolve(cwd, p))) : [cwd];
  return roots;
}

function extensions(options) {
  if (!options.ext || !options.ext.length) return DEFAULT_EXTENSIONS;
  return options.ext.map((e) => (e.startsWith('.') ? e : `.${e}`));
}

/* -------------------------------------------------------------------------
 * Shared runner for the three transforming codemods
 * ---------------------------------------------------------------------- */

/**
 * @param {'on'|'off'|'unwrap'} mode
 * @param {string} argv
 * @param {string} toolName
 */
export async function runTransform(mode, argv, toolName) {
  const options = parseArgs(argv, sharedSpec());
  if (options.__error) return usageError(options.__error, toolName);
  if (options.help) {
    printTransformHelp(toolName, mode);
    return 0;
  }
  if (options.version) {
    process.stdout.write(`${toolName} ${VERSION}\n`);
    return 0;
  }
  if (!options.flag) return usageError('--flag <name> is required', toolName);

  const roots = resolveRoots(options);
  const files = collectFiles({
    roots,
    extensions: extensions(options),
    ignore: options.ignore || [],
  });
  const allowed = new Set(options.allow || []);
  const config = buildConfig(options);
  const propNames = options.prop ? [...DEFAULT_WRAPPER_PROPS, ...options.prop] : DEFAULT_WRAPPER_PROPS;

  const fileReports = [];
  let rewrites = 0;
  let prunes = 0;
  const allRefusals = [];
  const allAdvisories = [];

  for (const file of files) {
    let src;
    try {
      src = readFileSync(file, 'utf8');
    } catch (err) {
      fileReports.push({ path: file, error: String(err.message) });
      continue;
    }
    const result = await transformFile(src, {
      mode,
      flag: options.flag,
      file,
      config,
      propNames,
      allowed,
      assumeBoolean: Boolean(options['assume-boolean']),
    });
    const path = displayPath(roots[0], file);
    const report = {
      path,
      absolutePath: file,
      changed: result.changed,
      rewrites: result.applied.length,
      pruned: result.pruned.length,
      applied: result.applied,
      prunedDetail: result.pruned,
      refusals: result.refusals,
      advisories: result.advisories,
      validated: result.validation ? result.validation.method : null,
      passes: result.passes,
      blocked: result.blocked,
      diff: result.changed ? unifiedDiff(result.original, result.output, { path, context: contextLines(options) }) : '',
      stat: result.changed ? diffStat(result.original, result.output) : { added: 0, removed: 0 },
    };
    rewrites += result.applied.length;
    prunes += result.pruned.length;
    allRefusals.push(...result.refusals.map((r) => ({ ...r, file: path })));
    allAdvisories.push(...result.advisories.map((a) => ({ ...a, file: path })));

    if (result.changed && options.write && !options.check) {
      try {
        writeFileSync(file, result.output, 'utf8');
      } catch (err) {
        report.writeError = String(err.message);
      }
    }
    if (result.changed || result.refusals.length || result.advisories.length || result.blocked) {
      fileReports.push(report);
    }
  }

  const changedFiles = fileReports.filter((r) => r.changed);
  const dryRun = !(options.write && !options.check);

  if (options.json) {
    const payload = {
      tool: toolName,
      version: VERSION,
      flag: options.flag,
      mode,
      dryRun,
      check: Boolean(options.check),
      roots,
      allow: [...allowed],
      assumeBoolean: Boolean(options['assume-boolean']),
      filesScanned: files.length,
      filesChanged: changedFiles.length,
      files: fileReports.map((r) => ({
        path: r.path,
        changed: r.changed,
        rewrites: r.rewrites,
        pruned: r.prunedDetail.map((p) => p.what),
        applied: r.applied,
        refusals: r.refusals.map((x) => ({ code: x.code, line: x.line, column: x.column, message: x.message, downgradable: x.downgradable, relaxed: x.relaxed })),
        advisories: r.advisories.map((x) => ({ code: x.code, line: x.line, message: x.message })),
        validated: r.validated,
        blocked: r.blocked,
        passes: r.passes,
        stat: r.stat,
      })),
      refusals: allRefusals.map((x) => ({ file: x.file, code: x.code, line: x.line, column: x.column, message: x.message, downgradable: x.downgradable, relaxed: x.relaxed })),
      advisories: allAdvisories.map((x) => ({ file: x.file, code: x.code, line: x.line, message: x.message })),
      summary: {
        filesScanned: files.length,
        filesChanged: changedFiles.length,
        rewrites,
        pruned: prunes,
        refusals: allRefusals.length,
        blockedRefusals: allRefusals.filter((r) => !r.relaxed && !['SHARED_MUTATION', 'LOOP_CARRIED_MUTATION'].includes(r.code)).length,
        advisories: allAdvisories.length,
        addedLines: changedFiles.reduce((s, r) => s + r.stat.added, 0),
        removedLines: changedFiles.reduce((s, r) => s + r.stat.removed, 0),
      },
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else if (!options.quiet) {
    printTransformReport({ toolName, mode, options, files, fileReports, rewrites, prunes, allRefusals, allAdvisories, dryRun, roots });
  }

  const blocking = allRefusals.filter((r) => !r.relaxed);
  if (options.check && changedFiles.length) return 3;
  if (blocking.length) return 2;
  return 0;
}

function contextLines(options) {
  const n = Number.parseInt(options.context === undefined ? '3' : options.context, 10);
  return Number.isFinite(n) && n >= 0 ? n : 3;
}

function usageError(message, toolName) {
  process.stderr.write(`${toolName}: ${message}\nTry \`node codemods/${toolName}.js --help\`.\n`);
  return 1;
}

function printTransformReport(ctx) {
  const { toolName, mode, options, files, fileReports, rewrites, prunes, allRefusals, allAdvisories, dryRun, roots } = ctx;
  const out = [];
  const modeLabel = mode === 'on' ? 'flag is now permanently ON' : mode === 'off' ? 'flag is now permanently OFF' : 'wrapper is now unconditional';
  out.push(`${toolName} ${VERSION} -- ${modeLabel}`);
  out.push(`flag: ${options.flag}    root: ${roots.join(', ')}    files scanned: ${files.length}`);
  out.push(options.check
    ? 'CHECK MODE: no files were written; exit code 3 means a change is pending.'
    : dryRun
      ? 'DRY RUN: no files were written. Pass --write to apply these changes.'
      : 'WRITE MODE: files below were rewritten on disk.');
  out.push('');

  const withDiff = fileReports.filter((r) => r.changed && r.diff);
  if (withDiff.length) {
    for (const report of withDiff) {
      out.push(`--- ${report.path}  (${report.rewrites} rewrite(s), ${report.pruned} cleanup(s), validated: ${report.validated})`);
      out.push(report.diff.replace(/\n$/, ''));
      out.push('');
    }
  } else {
    out.push('No rewrites were needed.');
    out.push('');
  }

  const applied = fileReports.filter((r) => r.changed).flatMap((r) => r.applied.map((a) => ({ path: r.path, ...a })));
  if (applied.length && options.verbose) {
    out.push('REWRITES');
    for (const a of applied) out.push(`  ${a.path}:${a.line}  ${a.kind} -- ${a.note}`);
    out.push('');
  }

  if (allRefusals.length) {
    out.push(`REFUSED (${allRefusals.length}) -- left untouched on purpose, a human has to look at these`);
    for (const r of allRefusals) {
      out.push(`  ${r.file}:${r.line}:${r.column}  ${r.code}  [${r.relaxed ? 'relaxed by --allow' : r.downgradable ? 'refused (--allow ' + r.code + ' relaxes this)' : 'refused'}]`);
      out.push(`      ${r.message}`);
    }
    out.push('');
  }

  if (allAdvisories.length) {
    out.push(`ADVISORIES (${allAdvisories.length}) -- rewrites were made; these are worth knowing about`);
    for (const a of allAdvisories) {
      out.push(`  ${a.file}:${a.line}:${a.column}  ${a.code}  ${a.message}`);
    }
    out.push('');
  }

  const changedCount = fileReports.filter((r) => r.changed).length;
  out.push('SUMMARY');
  out.push(`  files scanned        ${files.length}`);
  out.push(`  files changed        ${changedCount}`);
  out.push(`  rewrites applied     ${rewrites}`);
  out.push(`  declarations removed ${prunes}`);
  out.push(`  refusals             ${allRefusals.length}`);
  out.push(`  advisories           ${allAdvisories.length}`);
  const validated = fileReports.filter((r) => r.changed && r.validated).length;
  out.push(`  syntax validated     ${validated}/${changedCount} changed file(s) parsed before writing`);
  out.push('');
  if (changedCount === 0 && allRefusals.length === 0) {
    out.push(`No references to "${options.flag}" were found in the scanned files.`);
    out.push('Double-check the flag name and the path you passed: a typo looks exactly like a clean codebase.');
  }
  process.stdout.write(`${out.join('\n')}\n`);
}

function printTransformHelp(toolName, mode) {
  const blurb = mode === 'on'
    ? 'Removes a feature flag that is now permanently ENABLED, then proves the result still parses.'
    : mode === 'off'
      ? 'Removes a feature flag that is now permanently DISABLED, then proves the result still parses.'
      : 'Removes flag wrapper components and HOCs whose flag is now unconditional, then proves the result still parses.';
  process.stdout.write(`${toolName} ${VERSION}

${blurb}
Nothing is written without --write.

USAGE
  node codemods/${toolName}.js --flag <name> [paths...] [options]

  With no paths, the current directory is scanned.

OPTIONS
  --flag <name>          the flag to remove (required)
  --write                apply the changes (default is a dry run that writes nothing)
  --dry-run              print the diff and write nothing (default)
  --check                write nothing; exit 3 if any file would change (for CI)
  --root <dir>           scan this directory instead of the current one
  --ext .js,.tsx         only these extensions (default: js jsx mjs cjs ts tsx mts cts)
  --ignore <glob>        extra paths to skip (repeatable)
  --allow <CODES>        relax the listed review gates, e.g. SHARED_MUTATION
  --assume-boolean       allow value-position rewrites (assumes flags are booleans)
  --object <names>       extra flag object roots, e.g. ldFlags
  --function <names>     extra flag reader functions, e.g. variation
  --component <names>    extra wrapper components (unwrap-provider only)
  --hoc <names>          extra HOC names (unwrap-provider only)
  --prop <names>         extra wrapper prop names (unwrap-provider only)
  --json                 machine-readable report on stdout
  --quiet                no report (exit code only)
  --verbose              list every rewrite
  --context <n>          diff context lines (default 3)
  --help, --version

EXIT CODES
  0 clean   1 usage error   2 references refused   3 --check found changes
`);
}

/* -------------------------------------------------------------------------
 * find-stale-flags
 * ---------------------------------------------------------------------- */

export function runInventory(argv, toolName) {
  const spec = {
    booleans: ['json', 'quiet', 'help', 'version', 'verbose'],
    strings: ['min-refs', 'root', 'sort', 'ext', 'prop', 'max-files'],
    lists: ['ignore', 'ext', 'prop'],
  };
  const options = parseArgs(argv, spec);
  if (options.__error) return usageError(options.__error, toolName);
  if (options.help) {
    printInventoryHelp(toolName);
    return 0;
  }
  if (options.version) {
    process.stdout.write(`${toolName} ${VERSION}\n`);
    return 0;
  }
  const minRefs = options['min-refs'] === undefined ? 1 : Number.parseInt(options['min-refs'], 10);
  if (!Number.isFinite(minRefs) || minRefs < 1) {
    return usageError('--min-refs must be a positive integer', toolName);
  }
  const sortMode = options.sort || 'refs';
  if (!['refs', 'name', 'files'].includes(sortMode)) {
    return usageError('--sort must be one of: refs, name, files', toolName);
  }

  const roots = resolveRoots(options);
  const fileList = collectFiles({
    roots,
    extensions: extensions(options),
    ignore: options.ignore || [],
  });
  const files = [];
  for (const file of fileList) {
    try {
      files.push({ path: displayPath(roots[0], file), src: readFileSync(file, 'utf8'), absolutePath: file });
    } catch {
      // unreadable file: skipped, reported by count mismatch only
    }
  }

  const inventory = buildInventory(files, {
    propNames: options.prop ? [...DEFAULT_WRAPPER_PROPS, ...options.prop] : DEFAULT_WRAPPER_PROPS,
    minRefs,
  });

  if (sortMode === 'name') inventory.flags.sort((a, b) => a.name.localeCompare(b.name));
  else if (sortMode === 'files') inventory.flags.sort((a, b) => a.files.length - b.files.length || a.name.localeCompare(b.name));
  else inventory.flags.sort((a, b) => a.references - b.references || a.name.localeCompare(b.name));

  if (options.json) {
    process.stdout.write(`${JSON.stringify({
      tool: toolName,
      version: VERSION,
      roots,
      filesScanned: files.length,
      sort: sortMode,
      ...inventory,
    }, null, 2)}\n`);
    return 0;
  }

  if (options.quiet) return 0;

  const out = [];
  const maxFiles = options['max-files'] === undefined ? 3 : Number.parseInt(options['max-files'], 10);
  out.push(`${toolName} ${VERSION}`);
  out.push(`root: ${roots.join(', ')}    files scanned: ${files.length}    flags found: ${inventory.summary.flags}    references: ${inventory.summary.references}`);
  if (minRefs > 1) out.push(`(only flags with at least ${minRefs} references are listed)`);
  out.push('');
  if (!inventory.flags.length) {
    out.push('No feature flag references were found in the scanned files.');
    out.push('Check the path and --ext list before concluding the codebase is clean.');
    out.push('');
  } else {
    const width = Math.max(4, ...inventory.flags.map((f) => String(f.references).length));
    const nameWidth = Math.max(4, ...inventory.flags.map((f) => f.name.length));
    out.push(`${'refs'.padStart(width)}  ${'files'.padStart(5)}  ${'flag'.padEnd(nameWidth)}  where`);
    out.push(`${'-'.repeat(width)}  ${'-'.repeat(5)}  ${'-'.repeat(nameWidth)}  ${'-'.repeat(40)}`);
    for (const flag of inventory.flags) {
      const shown = options.verbose ? flag.files : flag.files.slice(0, maxFiles);
      const where = shown.map((f) => (f.references > 1 ? `${f.path} (${f.references})` : f.path)).join(', ');
      const more = !options.verbose && flag.files.length > shown.length ? ` +${flag.files.length - shown.length} more` : '';
      out.push(`${String(flag.references).padStart(width)}  ${String(flag.files.length).padStart(5)}  ${flag.name.padEnd(nameWidth)}  ${where}${more}`);
    }
    out.push('');
    const single = inventory.flags.filter((f) => f.references === 1);
    if (single.length) {
      out.push(`Flags with a single reference (${single.length}): typically the least risky to remove first --`);
      out.push(`  ${single.map((f) => f.name).join(', ')}`);
      out.push('');
    }
  }

  if (inventory.dynamicLookups.length) {
    out.push(`DYNAMIC LOOKUPS (${inventory.dynamicLookups.length}) -- flag names computed at runtime; this inventory cannot see them`);
    for (const d of inventory.dynamicLookups) {
      out.push(`  ${d.file}:${d.line}:${d.column}  ${d.kind}  ${d.value ? `(${d.value})` : ''}`);
    }
    out.push('');
  }
  if (inventory.unknownApis.length) {
    out.push(`STRING LITERALS IN UNRECOGNISED CALLS (${inventory.unknownApis.length}) -- may be flag names this tool does not know how to read`);
    for (const a of inventory.unknownApis) {
      out.push(`  ${a.file}:${a.line}:${a.column}  ${a.call}(${JSON.stringify(a.name)})`);
    }
    out.push('');
  }
  out.push('NEXT STEPS');
  out.push('  1. Confirm each flag state in the flag provider, not from this inventory.');
  out.push('  2. Remove one flag per commit:  node codemods/remove-enabled-flag.js --flag NAME');
  out.push('  3. Run your test suite, then delete the flag in the provider. See docs/WORKFLOW.md.');
  process.stdout.write(`${out.join('\n')}\n`);
  return 0;
}

function printInventoryHelp(toolName) {
  process.stdout.write(`${toolName} ${VERSION}

Inventory every feature flag reference in a codebase: how many references each
flag has and which files they are in. Read-only: this tool never writes.

USAGE
  node codemods/${toolName}.js [paths...] [options]

OPTIONS
  --json                 machine-readable inventory on stdout
  --min-refs <n>         only list flags with at least n references (default 1)
  --sort refs|name|files ordering of the table (default refs, fewest first)
  --root <dir>           scan this directory instead of the current one
  --ext .js,.tsx         only these extensions
  --ignore <glob>        extra paths to skip (repeatable)
  --prop <names>         extra wrapper prop names, e.g. flagKey
  --max-files <n>        files shown per flag in the table (default 3)
  --verbose              show every file for every flag
  --quiet                no output (exit code only)
  --help, --version
`);
}

/** Resolve the real path of a script for messages. */
export function selfPath(importMetaUrl) {
  try {
    return realpathSync(new URL(importMetaUrl).pathname);
  } catch {
    return importMetaUrl;
  }
}

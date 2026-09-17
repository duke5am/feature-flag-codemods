#!/usr/bin/env node
/**
 * find-stale-flags.js -- inventory every feature flag reference in a codebase.
 *
 * Part of Feature Flag Cleanup Codemods. Read-only: this script never writes.
 *
 * It does not need to be told any flag names. It recognises the shapes a flag
 * reference takes -- flags.x, flags['x'], useFlag('x'), destructured bindings,
 * wrapper components and HOCs -- and reports each flag with its reference count
 * and the files it appears in, so a team can see what is small, isolated and
 * therefore safe to remove first.
 *
 * It also reports what it cannot see:
 *   - dynamic lookups such as flags[userKey] or useFlag(flagName)
 *   - string literals passed to functions that are not known flag readers,
 *     which may be a flag SDK this tool does not recognise
 *
 *   node codemods/find-stale-flags.js src/
 *   node codemods/find-stale-flags.js src/ --json > flags.json
 *   node codemods/find-stale-flags.js src/ --min-refs 3 --sort name
 */

import { runInventory } from './lib/cli.js';

const code = runInventory(process.argv.slice(2), 'find-stale-flags');
process.exit(code);

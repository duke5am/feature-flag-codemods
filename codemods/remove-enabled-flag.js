#!/usr/bin/env node
/**
 * remove-enabled-flag.js -- remove a flag that is now permanently ON.
 *
 * Part of Feature Flag Cleanup Codemods.
 *
 * For each reference to the flag this replaces the conditional with the branch
 * that the flag now always takes, deletes the dead branch, and removes the flag
 * bindings that its own edits made unused. Anything it cannot prove safe is
 * left untouched and reported as a refusal with a file and line.
 *
 * Dry run by default: nothing is written unless --write is passed.
 *
 *   node codemods/remove-enabled-flag.js --flag new_dashboard src/
 *   node codemods/remove-enabled-flag.js --flag new_dashboard src/ --write
 *   node codemods/remove-enabled-flag.js --flag new_dashboard src/ --check
 *
 * Exit codes: 0 clean, 1 usage error, 2 a reference was refused, 3 --check
 * found work to do.
 */

import { runTransform } from './lib/cli.js';

const code = await runTransform('on', process.argv.slice(2), 'remove-enabled-flag');
process.exit(code);

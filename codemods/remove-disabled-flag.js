#!/usr/bin/env node
/**
 * remove-disabled-flag.js -- remove a flag that is now permanently OFF.
 *
 * Part of Feature Flag Cleanup Codemods.
 *
 * The mirror image of remove-enabled-flag.js: the else-branch (or the
 * short-circuit's skipped side, or the ternary's alternate) is what survives,
 * and the branch that only ran while the flag was on is deleted.
 *
 * Dry run by default: nothing is written unless --write is passed.
 *
 *   node codemods/remove-disabled-flag.js --flag legacy_checkout src/
 *   node codemods/remove-disabled-flag.js --flag legacy_checkout src/ --write
 *
 * Exit codes: 0 clean, 1 usage error, 2 a reference was refused, 3 --check
 * found work to do.
 */

import { runTransform } from './lib/cli.js';

const code = await runTransform('off', process.argv.slice(2), 'remove-disabled-flag');
process.exit(code);

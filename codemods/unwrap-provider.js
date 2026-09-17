#!/usr/bin/env node
/**
 * unwrap-provider.js -- remove a flag wrapper component or HOC.
 *
 * Part of Feature Flag Cleanup Codemods.
 *
 * Handles the three shapes a "wrapper" takes in real code:
 *
 *   <FeatureFlag name="new_dashboard"> ... </FeatureFlag>
 *       -> the children are hoisted into the parent, and the now-unused import
 *          of FeatureFlag is removed
 *
 *   export default withFeatureFlag('new_dashboard')(Dashboard)
 *       -> export default Dashboard
 *
 *   const showDashboard = useFlag('new_dashboard'); if (!showDashboard) return null;
 *       -> handled by remove-enabled-flag.js, which tracks the local variable
 *          as an alias of the flag and deletes both the guard and the now
 *          unused `const`
 *
 * A wrapper with several children, extra props, a non-literal flag name or a
 * render-prop child is refused rather than guessed at: hoisting the wrong thing
 * reorders rendering and changes layout.
 *
 * Dry run by default: nothing is written unless --write is passed.
 *
 *   node codemods/unwrap-provider.js --flag new_dashboard src/
 *   node codemods/unwrap-provider.js --flag new_dashboard src/ --write
 *
 * Exit codes: 0 clean, 1 usage error, 2 a reference was refused, 3 --check
 * found work to do.
 */

import { runTransform } from './lib/cli.js';

const code = await runTransform('unwrap', process.argv.slice(2), 'unwrap-provider');
process.exit(code);

/**
 * Search entry point. Two kinds of reference live here: one that any scanner
 * can see, and one that it cannot. The inventory (find-stale-flags) is expected
 * to report both, and to mark the second as unresolvable.
 */

import { flags } from './flags.js';

const searchFlagName = 'smart_search';

export function searchEnabled() {
  return flags.smart_search ? 'Search' : null;
}

export function searchEnabledDynamically() {
  return Boolean(flags[searchFlagName]);
}

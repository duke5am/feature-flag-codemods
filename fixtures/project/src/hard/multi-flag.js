/**
 * HARD CASE -- the flag is combined with a second flag in one condition.
 *
 * Removing one flag from `flags.new_dashboard && flags.smart_search` is
 * mechanically possible, but it silently couples two rollouts: if `smart_search`
 * is later reverted, the revert no longer restores the old behaviour. The rule
 * this pack enforces is one flag per change, so the condition is refused.
 */

import { flags } from '../flags.js';

export function searchBanner() {
  if (flags.new_dashboard && flags.smart_search) {
    return 'Search everything';
  }
  return 'Search';
}

/**
 * A flag with exactly one reference in exactly one file: the kind a team should
 * remove first, because the diff is three lines and review takes a minute.
 */

import { flags } from './flags.js';

export function announcement() {
  return flags.old_banner ? 'Welcome!' : '';
}

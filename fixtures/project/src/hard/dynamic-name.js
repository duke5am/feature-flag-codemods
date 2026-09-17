/**
 * HARD CASE -- the flag name is computed at runtime.
 *
 * `flags[dynamicName]` can read any flag, including `new_dashboard`. Because
 * the reference cannot be resolved, the codemod cannot prove that removing
 * `new_dashboard` leaves no references behind -- so it must refuse this ENTIRE
 * file, including the `if` below, which it could otherwise have rewritten
 * safely. A partially rewritten file would be worse than an untouched one: the
 * diff would look clean and the dynamic lookup would still be there.
 */

import { flags } from '../flags.js';

const dynamicName = 'new_dashboard';

export function isEnabled(flagName) {
  return Boolean(flags[flagName]);
}

export function isRolledOut() {
  return Boolean(flags[dynamicName]);
}

export function legacyBanner() {
  if (flags.new_dashboard) {
    return 'New dashboard';
  }
  return 'Dashboard';
}

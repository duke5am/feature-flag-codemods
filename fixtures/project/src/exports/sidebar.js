/**
 * HARD CASE -- only the sole destructured property.
 *
 * Removing `beta_exports` leaves an empty destructuring pattern, so the whole
 * declaration has to go, not just the property. This file exists to prove the
 * codemod notices that difference.
 */

import { useFlags } from '../flags.js';

export function sidebar() {
  const { beta_exports } = useFlags();

  if (!beta_exports) {
    return 'sidebar';
  }

  return 'sidebar with exports';
}

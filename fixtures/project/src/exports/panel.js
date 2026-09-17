/**
 * A destructured flag binding, which becomes unused once the guard it feeds is
 * removed. The codemod is expected to delete the property from the destructuring
 * pattern and leave the other binding (still used) in place.
 */

import { useFlags } from '../flags.js';

export function exportPanel(rows, format) {
  const { beta_exports, new_dashboard } = useFlags();

  if (!beta_exports) {
    return null;
  }

  return `exporting ${rows.length} rows as ${format} (dashboard: ${new_dashboard})`;
}

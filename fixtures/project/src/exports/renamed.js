/**
 * The renamed destructuring form: `{ beta_exports: betaOn }`. The property key
 * is what names the flag; the local name is what the rest of the file reads.
 * Both have to be handled, and the single-property pattern has to be removed
 * whole once its guard is gone.
 */

import { useFlags } from '../flags.js';

export function renamedExportLink(rows) {
  const { beta_exports: betaOn } = useFlags();

  if (!betaOn) {
    return null;
  }

  return `export ${rows.length} rows`;
}

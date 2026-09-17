/**
 * The hook form held in a local variable. Once the guard is gone the alias has
 * no readers left, so the whole declaration should be deleted -- and the import
 * of `useFlag` with it.
 */

import { useFlag } from '../flags.js';

export function report(rows) {
  const showBeta = useFlag('beta_exports');

  if (!showBeta) {
    return null;
  }

  return rows.map((row) => row.id);
}

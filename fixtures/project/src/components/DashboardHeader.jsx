/**
 * HARD CASE -- several children.
 *
 * Hoisting `<h1>` and `<span>` out of the wrapper needs a fragment, and where
 * that fragment goes (and what whitespace it keeps) changes layout. The codemod
 * must refuse this and leave the file byte-identical.
 */

import { FeatureFlag } from '../flags-ui.js';

export function DashboardHeader({ count }) {
  return (
    <header>
      <FeatureFlag name="new_dashboard">
        <h1>Overview</h1>
        <span>{count} items</span>
      </FeatureFlag>
    </header>
  );
}

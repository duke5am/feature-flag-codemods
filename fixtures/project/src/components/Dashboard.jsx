/**
 * Nested wrappers for the same flag. Unwrapping the outer one exposes the
 * inner one, so the codemod has to run more than one pass over this file.
 */

import { FeatureFlag } from '../flags-ui.js';

export function Dashboard({ widgets }) {
  return (
    <main>
      <FeatureFlag name="new_dashboard">
        <FeatureFlag name="new_dashboard">
          <WidgetList widgets={widgets} />
        </FeatureFlag>
      </FeatureFlag>
    </main>
  );
}

export function WidgetList({ widgets }) {
  return <ul>{widgets.length}</ul>;
}

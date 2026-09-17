/** Fixture JSX components. Kept dependency-free: these are never rendered. */

import { FeatureFlag } from '../flags-ui.js';

/** A rolled-out wrapper around a single child, the easy unwrap case. */
export function ExportPanel({ rows }) {
  return (
    <section className="panel">
      <h2>Export</h2>
      <FeatureFlag name="new_dashboard">
        <ExportButtons rows={rows} />
      </FeatureFlag>
    </section>
  );
}

export function ExportButtons({ rows }) {
  return <button type="button">{rows.length} rows</button>;
}

/**
 * HARD CASES -- a render prop, and a wrapper with extra props.
 *
 * In the first component the child is a function that receives the flag value,
 * so hoisting the children alone would feed `undefined` into code that expects
 * a boolean. In the second, `fallback` changes what is rendered when the flag
 * is off; unwrapping would drop it. Both must be refused, untouched.
 */

import { FeatureFlag } from '../flags-ui.js';

export function SearchBox({ onSearch }) {
  return (
    <FeatureFlag name="new_dashboard">
      {(enabled) => (enabled ? <input onChange={onSearch} /> : <span>Search is off</span>)}
    </FeatureFlag>
  );
}

export function Spinner({ loading }) {
  return (
    <FeatureFlag name="new_dashboard" fallback={<span>Loading</span>}>
      <div className="content">{loading ? null : 'ready'}</div>
    </FeatureFlag>
  );
}

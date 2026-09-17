/**
 * Fixture flag wrapper components -- the `unwrap-provider` targets.
 * Written the way teams actually write them: the wrapper reads the flag by
 * name at runtime, which is why the codemods cannot see through it and why a
 * computed lookup inside a file makes that file off-limits (see
 * src/hard/dynamic-name.js).
 */

import { flags } from './flags.js';

export function FeatureFlag({ name, children }) {
  return flags[name] ? children : null;
}

export function FeatureGate({ name, children, fallback = null }) {
  return flags[name] ? children : fallback;
}

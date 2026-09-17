/**
 * Fixture stand-in for a feature flag SDK (LaunchDarkly, Unleash, Split,
 * OpenFeature, or a hand-rolled equivalent). It is intentionally boring: the
 * codemods must not care which provider a team uses, only that a flag is read
 * by name somewhere.
 */

const values = {
  new_dashboard: true,
  legacy_checkout: false,
  beta_exports: true,
  smart_search: true,
  old_banner: true,
};

/** The flags object form: `flags.new_dashboard`, `flags['smart_search']`. */
export const flags = new Proxy(values, {
  get(target, key) {
    return target[key];
  },
});

/** The hook form: `useFlag('new_dashboard')`. */
export function useFlag(name) {
  return Boolean(values[name]);
}

/** The destructuring form: `const { new_dashboard } = useFlags();`. */
export function useFlags() {
  return flags;
}

/** A second reader, to prove the tool follows more than one API shape. */
export function isFeatureEnabled(name) {
  return Boolean(values[name]);
}

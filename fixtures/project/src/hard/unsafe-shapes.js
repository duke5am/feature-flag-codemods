/**
 * HARD CASES -- the short-circuit trap, the value position, the loop gate and
 * the `||` operator. Four different reasons why a mechanical rewrite would be
 * wrong, all of them common in real codebases.
 */

import { flags } from '../flags.js';
import { analytics } from '../analytics.js';

/**
 * The second operand of `&&` only ran while the flag was on. Dropping the flag
 * would delete `analytics.send(...)`, which is a real call with real effects.
 */
export function hasProbed() {
  if (flags.new_dashboard && analytics.send('probe')) {
    return true;
  }
  return false;
}

/** The flag value is passed out of the expression, not merely tested. */
export function widgetConfig() {
  return {
    layout: flags.new_dashboard,
    density: 'comfortable',
  };
}

/** The flag is returned directly: the caller sees the provider's raw value. */
export function rawFlag() {
  return flags.new_dashboard;
}

/**
 * The flag gates a loop. If the provider state is wrong, or the flag is read
 * again by something else, removing the gate turns a bounded loop into a hang.
 */
export function pump(reader) {
  while (flags.new_dashboard) {
    reader.drain();
  }
  return reader;
}

/**
 * `||` mixes the flag's value with another value. Providers return strings,
 * variants and defaults, so what `flags.x || fallback()` evaluates to is not
 * something a text transform can know.
 */
export function layoutName() {
  return flags.new_dashboard || 'classic';
}

/**
 * Removing this branch would move `const heading` out of its block, where the
 * name is also declared in the enclosing function.
 */
export function summary() {
  const heading = 'Summary';
  if (flags.new_dashboard) {
    const heading = 'Overview';
    return heading;
  }
  return heading;
}

/**
 * The mirror image of src/dashboard.js: `legacy_checkout` is permanently OFF,
 * so the else-branches and the negated guards are what survive.
 */

import { flags } from '../flags.js';
import { analytics } from '../analytics.js';

function modernTotal(cart) {
  return cart.total;
}

function legacyTotal(cart) {
  return cart.total + cart.legacyFee;
}

export function checkoutTotal(cart) {
  if (flags.legacy_checkout) {
    return legacyTotal(cart);
  } else {
    return modernTotal(cart);
  }
}

export function submit(cart) {
  if (!flags.legacy_checkout) {
    return modernTotal(cart);
  }
  analytics.send('legacy_checkout_used');
  return legacyTotal(cart);
}

export function variantName() {
  return flags.legacy_checkout ? 'legacy' : 'modern';
}

/** Identifier dereference through a negated flag, used as a value. */
export function isModern() {
  return !flags.legacy_checkout;
}

/**
 * The value of the `&&` is kept, so it depends on what the provider returns for
 * an off flag (false, "off", 0, undefined). That value is not statically known,
 * so this is refused rather than guessed.
 */
export function verboseFlag(logger) {
  const verbose = flags.legacy_checkout && logger.verbose();
  return verbose;
}

/** `||` again, this time with a disabled flag. */
export function label() {
  return flags.legacy_checkout || 'Modern checkout';
}

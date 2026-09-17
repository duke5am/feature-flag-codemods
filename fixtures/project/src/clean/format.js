/**
 * A file with no feature flags at all. The codemods must not touch it, and the
 * inventory must not list it. This is the control for "the tool found something
 * because there was something to find".
 */

export function formatCurrency(amount, currency = 'USD') {
  return `${currency} ${amount.toFixed(2)}`;
}

export function initials(name) {
  return name
    .split(' ')
    .map((part) => part[0])
    .join('')
    .toUpperCase();
}

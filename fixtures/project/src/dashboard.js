/**
 * The straightforward case: a rolled-out flag used in the ordinary ways.
 * Removing `new_dashboard` (permanently ON) should rewrite every construct in
 * this file, delete the `useFlag` alias and the now-unused imports.
 */

import { flags, useFlag } from './flags.js';
import { analytics } from './analytics.js';

export function greeting(user) {
  if (flags.new_dashboard) {
    return `Welcome back, ${user.name}`;
  } else {
    return `Hello, ${user.name}`;
  }
}

export function panelTitle() {
  return flags.new_dashboard ? 'Overview' : 'Home';
}

export function trackView() {
  flags.new_dashboard && analytics.send('dashboard_viewed');
}

// The hook form through a local alias: the guard goes away, and so does the
// declaration that only existed to hold the flag.
export function requireDashboard(user) {
  const dashboardEnabled = useFlag('new_dashboard');
  if (!dashboardEnabled) {
    return null;
  }
  return greeting(user);
}

// A compound condition in a boolean position: only truthiness is observed, so
// the flag can be dropped and `isVisible` alone decides.
export function maybeRender(isVisible) {
  if (flags.new_dashboard && isVisible) {
    return 'shown';
  }
  return 'hidden';
}

// A guard whose body has effects that never run once the flag is on. Deleting
// the whole if is safe, and the codemod is expected to do it.
export function legacyNotice() {
  if (!flags.new_dashboard) {
    analytics.send('legacy_dashboard_shown');
    return 'legacy';
  }
  analytics.send('new_dashboard_shown');
  return 'new';
}

export function badge() {
  return `mode: ${flags.new_dashboard ? 'new' : 'legacy'}`;
}

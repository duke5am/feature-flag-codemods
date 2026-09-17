/**
 * HARD CASE -- both branches write the same binding.
 *
 * The flag is genuinely off-then-on here, but the two branches were maintained
 * in parallel and the surviving one is a judgement call about what the product
 * should say. The codemod refuses this and asks for a human, rather than
 * picking one string and calling it a cleanup.
 */

import { flags } from '../flags.js';

export function countLabel(count) {
  let label = '';
  if (flags.new_dashboard) {
    label = `${count} items`;
  } else {
    label = `${count} item(s)`;
  }
  return label;
}

/**
 * HARD CASE -- a flag inside a loop, with effects in both branches.
 *
 * Both branches count into `stats`, which the caller reads after the loop, and
 * both call out to the world. Which branch "won" is loop-carried state, and
 * whether the loop still means the same thing after the dead branch is gone
 * needs whole-function reasoning. The codemod must refuse this occurrence and
 * leave the file byte-identical.
 */

import { flags } from '../flags.js';

function send(job) {
  return job;
}

function queue(job) {
  return job;
}

export function dispatchAll(jobs, stats) {
  for (const job of jobs) {
    if (flags.new_dashboard) {
      stats.processed += 1;
      send(job);
    } else {
      stats.queued += 1;
      queue(job);
    }
  }
  return stats;
}

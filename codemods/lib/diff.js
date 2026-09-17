/**
 * diff.js -- unified diff output for --dry-run.
 *
 * Part of Feature Flag Cleanup Codemods.
 *
 * Implemented here rather than shelling out to `diff`/`git` so that dry-run
 * output is identical on every machine and inside CI containers that have no
 * diff binary. Myers' O(ND) algorithm, so the cost is proportional to the size
 * of the change rather than the size of the file.
 */

/**
 * Line-level diff between two arrays of lines.
 * @returns {Array<{type: 'eq'|'del'|'ins', aIndex?: number, bIndex?: number}>}
 */
export function diffLines(a, b) {
  const n = a.length;
  const m = b.length;

  if (n === 0 && m === 0) return [];
  if (n === 0) return b.map((_, i) => ({ type: 'ins', bIndex: i }));
  if (m === 0) return a.map((_, i) => ({ type: 'del', aIndex: i }));

  const max = n + m;
  const v = new Map([[1, 0]]);
  const trace = [];
  let found = -1;

  outer: for (let d = 0; d <= max; d += 1) {
    trace.push(new Map(v));
    for (let k = -d; k <= d; k += 2) {
      const downX = v.get(k + 1);
      const rightX = v.get(k - 1);
      const down = downX === undefined ? -Infinity : downX;
      const right = rightX === undefined ? -Infinity : rightX;
      let x;
      if (k === -d || (k !== d && right < down)) x = downX === undefined ? 0 : downX;
      else x = (rightX === undefined ? 0 : rightX) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v.set(k, x);
      if (x >= n && y >= m) {
        found = d;
        break outer;
      }
    }
  }

  const ops = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d -= 1) {
    const state = trace[d];
    const k = x - y;
    const downX = state.get(k + 1);
    const rightX = state.get(k - 1);
    const down = downX === undefined ? -Infinity : downX;
    const right = rightX === undefined ? -Infinity : rightX;
    const prevK = k === -d || (k !== d && right < down) ? k + 1 : k - 1;
    const prevX = state.get(prevK) === undefined ? 0 : state.get(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ type: 'eq', aIndex: x - 1, bIndex: y - 1 });
      x -= 1;
      y -= 1;
    }
    if (x === prevX) {
      ops.push({ type: 'ins', bIndex: y - 1 });
      y -= 1;
    } else {
      ops.push({ type: 'del', aIndex: x - 1 });
      x -= 1;
    }
  }
  while (x > 0 && y > 0) {
    x -= 1;
    y -= 1;
    ops.push({ type: 'eq', aIndex: x, bIndex: y });
  }
  while (x > 0) {
    x -= 1;
    ops.push({ type: 'del', aIndex: x });
  }
  while (y > 0) {
    y -= 1;
    ops.push({ type: 'ins', bIndex: y });
  }
  ops.reverse();
  return ops;
}

function splitLines(text) {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Unified diff of two texts.
 * @param {string} oldText
 * @param {string} newText
 * @param {{ path?: string, context?: number }} [opts]
 * @returns {string} empty string when the texts are identical
 */
export function unifiedDiff(oldText, newText, opts = {}) {
  const context = opts.context === undefined ? 3 : opts.context;
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const ops = diffLines(a, b);
  if (!ops.some((o) => o.type !== 'eq')) return '';

  // Prefix counts, so any hunk can report its starting line numbers.
  const aBefore = new Array(ops.length + 1).fill(0);
  const bBefore = new Array(ops.length + 1).fill(0);
  for (let i = 0; i < ops.length; i += 1) {
    aBefore[i + 1] = aBefore[i] + (ops[i].type === 'ins' ? 0 : 1);
    bBefore[i + 1] = bBefore[i] + (ops[i].type === 'del' ? 0 : 1);
  }

  // Group changes into hunks: a gap of more than 2*context equal lines splits.
  const groups = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i].type === 'eq') {
      i += 1;
      continue;
    }
    const start = Math.max(0, i - context);
    let lastChange = i;
    let j = i;
    while (j < ops.length) {
      if (ops[j].type !== 'eq') {
        lastChange = j;
        j += 1;
        continue;
      }
      let k = j;
      while (k < ops.length && ops[k].type === 'eq') k += 1;
      if (k >= ops.length || k - j > context * 2) break;
      j = k;
    }
    const end = Math.min(ops.length, lastChange + context + 1);
    groups.push([start, end]);
    i = end;
  }

  const label = opts.path || 'file';
  const parts = [`--- a/${label}`, `+++ b/${label}`];
  for (const [start, end] of groups) {
    const lines = [];
    let aCount = 0;
    let bCount = 0;
    for (let k = start; k < end; k += 1) {
      const op = ops[k];
      if (op.type === 'eq') {
        lines.push(` ${a[op.aIndex]}`);
        aCount += 1;
        bCount += 1;
      } else if (op.type === 'del') {
        lines.push(`-${a[op.aIndex]}`);
        aCount += 1;
      } else {
        lines.push(`+${b[op.bIndex]}`);
        bCount += 1;
      }
    }
    const aStart = aCount === 0 ? aBefore[start] : aBefore[start] + 1;
    const bStart = bCount === 0 ? bBefore[start] : bBefore[start] + 1;
    parts.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
    parts.push(...lines);
  }
  return `${parts.join('\n')}\n`;
}

/** Added/removed line counts, for summaries. */
export function diffStat(oldText, newText) {
  const ops = diffLines(splitLines(oldText), splitLines(newText));
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.type === 'ins') added += 1;
    else if (op.type === 'del') removed += 1;
  }
  return { added, removed };
}

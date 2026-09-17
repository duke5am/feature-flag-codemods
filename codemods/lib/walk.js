/**
 * walk.js -- find source files without shelling out.
 *
 * Part of Feature Flag Cleanup Codemods.
 *
 * Uses fs.readdirSync recursively. It does not call `find`, `git ls-files` or
 * any external binary: the codemod has to behave the same in a container, on
 * macOS, on Windows and inside a CI image that ships nothing but Node.
 *
 * Entries are classified with statSync (which follows symlinks) rather than
 * with the dirent type. Two reasons, both learned the hard way:
 *
 *   1. Some filesystems -- and some overlay/FUSE mounts, including the one this
 *      pack was developed on -- report regular files as symlinks through
 *      readdir. Trusting the dirent drops those files, and a codemod that
 *      silently misses files is worse than one that fails loudly: the report
 *      says "no references left" when there are.
 *   2. pnpm, Yarn and Bazel all hand out symlinked directories, which are
 *      perfectly normal source roots in a monorepo.
 *
 * Directory cycles from symlinks are prevented with a realpath set.
 */

import { readdirSync, statSync, realpathSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const DEFAULT_EXTENSIONS = ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts'];

export const DEFAULT_IGNORES = [
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'coverage',
  '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache', 'vendor', '__snapshots__',
  '.venv', 'venv', 'target',
];

/** Convert a simple glob (`*`, `**`, `?`) into a RegExp. */
export function globToRegExp(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*';
        i += 1;
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return new RegExp(`^${out}$`);
}

/**
 * @param {object} opts
 * @param {string[]} opts.roots      directories or files to scan
 * @param {string[]} [opts.extensions]
 * @param {string[]} [opts.ignore]   directory names or glob patterns to skip
 * @param {number} [opts.maxDepth]
 * @returns {string[]} absolute file paths, sorted
 */
export function collectFiles(opts) {
  const extensions = opts.extensions && opts.extensions.length ? opts.extensions : DEFAULT_EXTENSIONS;
  const ignoreNames = new Set();
  const ignorePatterns = [];
  for (const entry of [...DEFAULT_IGNORES, ...(opts.ignore || [])]) {
    if (entry.includes('*') || entry.includes('?')) ignorePatterns.push(globToRegExp(entry));
    else ignoreNames.add(entry);
  }
  const maxDepth = opts.maxDepth === undefined ? 40 : opts.maxDepth;
  const out = [];
  const visitedRealPaths = new Set();

  const shouldSkipDir = (name) => {
    if (ignoreNames.has(name)) return true;
    return ignorePatterns.some((re) => re.test(name));
  };

  const visit = (dir, depth) => {
    if (depth > maxDepth) return;
    let real = dir;
    try {
      real = realpathSync(dir);
    } catch {
      return;
    }
    if (visitedRealPaths.has(real)) return; // symlink cycle
    visitedRealPaths.add(real);

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue; // broken symlink or a race with a build
      }
      if (stat.isDirectory()) {
        if (shouldSkipDir(entry.name)) continue;
        visit(full, depth + 1);
        continue;
      }
      if (!stat.isFile()) continue;
      if (!extensions.some((ext) => entry.name.endsWith(ext))) continue;
      if (ignorePatterns.some((re) => re.test(entry.name))) continue;
      out.push(full);
    }
  };

  for (const root of opts.roots) {
    let stat;
    try {
      stat = statSync(root);
    } catch {
      continue;
    }
    if (stat.isDirectory()) visit(root, 0);
    else if (stat.isFile()) out.push(root);
  }

  return [...new Set(out)].sort();
}

/** Path shown to the user: relative to the scan root, with forward slashes. */
export function displayPath(root, file) {
  const rel = relative(root, file) || file;
  return rel.split(sep).join('/');
}

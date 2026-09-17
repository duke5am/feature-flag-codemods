/**
 * flags.js -- recognising references to a named feature flag.
 *
 * Part of Feature Flag Cleanup Codemods.
 *
 * Everything here is *static* recognition. A reference is only reported as a
 * static reference when the flag name appears in the source as a literal (or
 * as a property name). Anything computed is reported separately as a dynamic
 * reference, which the transform layer treats as a reason to refuse.
 *
 * Recognised static forms (for flag `new_ui`):
 *
 *   flags.new_ui                        featureFlags.new_ui
 *   flags?.new_ui                       ff.new_ui
 *   flags['new_ui']                     flags["new_ui"]
 *   useFlag('new_ui')                   isFeatureEnabled('new_ui', false)
 *   useFeatureFlag('new_ui')            getFlag('new_ui')
 *   const { new_ui } = useFlags()       const { new_ui: isOn } = flagsContext()
 *
 * Recognised dynamic forms (which cause a refusal):
 *
 *   flags[flagName]                     flags[`prefix_${id}`]
 *   flags[key]                          useFlag(variableName)
 *   const { [name]: v } = useFlags()
 *
 * Also reported, as an advisory rather than a reference:
 *
 *   anyAppFunction('new_ui')            // an unrecognised flag SDK, e.g. a
 *                                       // LaunchDarkly/Unleash style client
 */

/** Object-like roots that are treated as "the flags object". */
export const DEFAULT_OBJECT_NAMES = [
  'flags', 'featureFlags', 'features', 'ff', 'gates', 'toggles',
  'featureToggles', 'featureGates', 'flagValues',
];

/** Functions that read a flag by name. */
export const DEFAULT_FLAG_FUNCTIONS = [
  'useFlag', 'useFeatureFlag', 'useFlagValue', 'isFeatureEnabled',
  'isFlagEnabled', 'flagEnabled', 'featureFlagEnabled', 'getFlag',
  'getFeatureFlag', 'getFlagValue', 'featureEnabled', 'useFeature',
];

/** Components that gate their children on a flag. */
export const DEFAULT_WRAPPER_COMPONENTS = [
  'FeatureFlag', 'Flag', 'FeatureGate', 'FlagGate', 'FeatureToggle',
  'ToggleFeature', 'FlaggedFeature', 'FeatureFlags',
];

/** HOCs that gate a component on a flag. */
export const DEFAULT_HOC_FUNCTIONS = [
  'withFeatureFlag', 'withFlag', 'withFeatureToggle', 'withFeatureGate',
];

export function defaultConfig() {
  return {
    objectNames: [...DEFAULT_OBJECT_NAMES],
    flagFunctions: [...DEFAULT_FLAG_FUNCTIONS],
    wrapperComponents: [...DEFAULT_WRAPPER_COMPONENTS],
    hocFunctions: [...DEFAULT_HOC_FUNCTIONS],
    // Extra roots ending in these words are also treated as flag objects, so
    // `workspaceFlags.new_ui` and `teamFeatures.x` are recognised.
    objectSuffixes: ['Flags', 'Features', 'Toggles', 'Gates'],
  };
}

/** Does an identifier name look like "the flags object"? */
export function isObjectRoot(name, config) {
  if (config.objectNames.includes(name)) return true;
  if (name === 'this') return false;
  return config.objectSuffixes.some((s) => name.length > s.length && name.endsWith(s));
}

/** Value of a string literal token, or null. */
export function stringLiteralValue(tok) {
  if (!tok || tok.type !== 'string') return null;
  const raw = tok.value;
  const quote = raw[0];
  if (quote !== "'" && quote !== '"') return null;
  const body = raw.slice(1, -1);
  if (body.includes('\\')) {
    // Unescape the common cases; anything else means "not a simple literal".
    const simple = body.replace(/\\(['"\\])/g, '$1');
    if (simple.includes('\\')) return null;
    return simple;
  }
  return body;
}

/** Is the token a template literal with no interpolation? */
export function plainTemplateValue(tok) {
  if (!tok || tok.type !== 'template') return null;
  if (tok.value.includes('${')) return null;
  return tok.value.slice(1, -1);
}

/**
 * The literal flag name at a token position, if it is a plain string.
 * @returns {string|null}
 */
export function literalNameAt(tok) {
  return stringLiteralValue(tok) ?? plainTemplateValue(tok);
}

/**
 * Describe the function a first-argument string literal is passed to, e.g.
 * `analytics.send` for `analytics.send("x")`. Returns null when the literal is
 * not the first argument of a plain or member call.
 */
export function callCalleeAt(toks, i) {
  const paren = toks[i - 1];
  if (!paren || paren.type !== 'punct' || paren.value !== '(') return null;
  const target = toks[i - 2];
  if (!target || target.type !== 'ident') return null;
  const dot = toks[i - 3];
  if (dot && dot.type === 'punct' && (dot.value === '.' || dot.value === '?.')) {
    const obj = toks[i - 4];
    return obj && obj.type === 'ident' ? `${obj.value}.${target.value}` : target.value;
  }
  return target.value;
}

/**
 * Find references to `flagName`.
 *
 * @param {object} index result of buildIndex()
 * @param {string} flagName
 * @param {object} config result of defaultConfig()
 * @param {string} [src] used to check that an alias initialiser ends there
 * @returns {{
 *   static: Array<object>, dynamic: Array<object>, advisories: Array<object>,
 *   aliases: Array<object>, destructured: Array<object>
 * }}
 */
export function findFlagReferences(index, flagName, config, src) {
  const toks = index.toks;
  const stat = [];
  const dynamic = [];
  const advisories = [];
  const aliases = [];
  const destructured = [];
  const claim = new Set();

  for (let i = 0; i < toks.length; i += 1) {
    const t = toks[i];

    // ---------------------------------------------------------- flags.x
    if (t.type === 'ident' && i + 2 < toks.length) {
      const dot = toks[i + 1];
      const prop = toks[i + 2];
      const isChainRoot = !(toks[i - 1] && toks[i - 1].type === 'punct' && (toks[i - 1].value === '.' || toks[i - 1].value === '?.'));
      if (
        isChainRoot &&
        isObjectRoot(t.value, config) &&
        dot.type === 'punct' &&
        (dot.value === '.' || dot.value === '?.') &&
        prop.type === 'ident' &&
        prop.value === flagName
      ) {
        const ref = {
          form: 'member',
          start: t.start,
          end: prop.end,
          startIdx: i,
          endIdx: i + 2,
        };
        stat.push(ref);
        for (let k = i; k <= i + 2; k += 1) claim.add(k);
        continue;
      }
    }

    // ------------------------------------------------- flags['x'] / flags[k]
    if (t.type === 'ident' && isObjectRoot(t.value, config)) {
      const bracket = toks[i + 1];
      if (bracket && bracket.type === 'punct' && bracket.value === '[') {
        const closeIdx = index.open.get(i + 1);
        if (closeIdx !== undefined) {
          const keyToks = toks.slice(i + 2, closeIdx);
          const literal = keyToks.length === 1 ? literalNameAt(keyToks[0]) : null;
          if (literal === flagName) {
            stat.push({
              form: 'member-index',
              start: t.start,
              end: toks[closeIdx].end,
              startIdx: i,
              endIdx: closeIdx,
            });
            for (let k = i; k <= closeIdx; k += 1) claim.add(k);
          } else if (literal === null) {
            dynamic.push({
              form: 'computed-member',
              reason: `computed flag lookup ${t.value}[...] -- the key is not a string literal`,
              start: toks[i].start,
              end: toks[closeIdx].end,
              startIdx: i,
              endIdx: closeIdx,
              value: keyToks.map((k) => k.value).join(' '),
            });
          } else {
            // A literal key naming a *different* flag: a reference to another
            // flag, not to ours. Recorded so callers can see it exists.
          }
        }
      }
    }

    // --------------------------------------------------- useFlag('x') etc.
    if (t.type === 'ident' && config.flagFunctions.includes(t.value)) {
      const paren = toks[i + 1];
      if (paren && paren.type === 'punct' && paren.value === '(') {
        const closeIdx = index.open.get(i + 1);
        if (closeIdx !== undefined) {
          const argToks = toks.slice(i + 2, closeIdx);
          const literal = argToks.length >= 1 ? literalNameAt(argToks[0]) : null;
          const firstArgIsSingle = argToks.length >= 1;
          if (literal === flagName && firstArgIsSingle) {
            stat.push({
              form: 'call',
              start: t.start,
              end: toks[closeIdx].end,
              startIdx: i,
              endIdx: closeIdx,
              callName: t.value,
              argCount: countArgs(argToks),
            });
            for (let k = i; k <= closeIdx; k += 1) claim.add(k);
          } else if (literal === null && firstArgIsSingle) {
            dynamic.push({
              form: 'computed-call',
              reason: `flag name computed and passed to ${t.value}() -- cannot be resolved statically`,
              start: t.start,
              end: toks[closeIdx].end,
              startIdx: i,
              endIdx: closeIdx,
              value: argToks.map((x) => x.value).join(' '),
            });
          }
        }
      }
    }

    // ---------------------------------- const { flag } = useFlags() / flags
    if (
      t.type === 'ident' &&
      (t.value === 'const' || t.value === 'let' || t.value === 'var') &&
      toks[i + 1] &&
      toks[i + 1].type === 'punct' &&
      toks[i + 1].value === '{'
    ) {
      const braceOpen = i + 1;
      const braceClose = index.open.get(braceOpen);
      if (braceClose !== undefined) {
        const eq = toks[braceClose + 1];
        const rhsTok = toks[braceClose + 2];
        if (eq && eq.type === 'punct' && eq.value === '=' && rhsTok) {
          const rhsIsFlags =
            (rhsTok.type === 'ident' && isObjectRoot(rhsTok.value, config)) ||
            (rhsTok.type === 'ident' && config.flagFunctions.includes(rhsTok.value));
          if (rhsIsFlags) {
            for (let k = braceOpen + 1; k < braceClose; k += 1) {
              const prop = toks[k];
              if (prop.type === 'punct' && prop.value === '[') {
                const inner = index.open.get(k);
                if (inner !== undefined) {
                  dynamic.push({
                    form: 'computed-destructure',
                    reason: 'computed property in flag destructuring -- cannot be resolved statically',
                    start: prop.start,
                    end: toks[inner].end,
                    startIdx: k,
                    endIdx: inner,
                    value: toks.slice(k + 1, inner).map((x) => x.value).join(' '),
                  });
                  k = inner;
                }
                continue;
              }
              if (prop.type !== 'ident') continue;
              const prev = toks[k - 1];
              const next = toks[k + 1];

              // `{ flag: local }` -- the key is the token before the colon, and
              // the binding is the name after it. Both matter: the property is
              // what makes this a reference to our flag, and the local name is
              // what the rest of the file reads.
              if (prev && prev.type === 'punct' && prev.value === ':') {
                const key = toks[k - 2];
                if (key && key.type === 'ident' && key.value === flagName) {
                  stat.push({
                    form: 'destructured',
                    start: key.start,
                    end: prop.end,
                    startIdx: k - 2,
                    endIdx: k,
                    property: key.value,
                    local: prop.value,
                    source: rhsTok.value,
                  });
                }
                continue;
              }
              if (prev && prev.type === 'punct' && prev.value === ',') continue; // non-shorthand key

              // Property shorthand: `{ flag }`.
              if (
                prop.value === flagName &&
                next && next.type === 'punct' && (next.value === ',' || next.value === '}' || next.value === '=')
              ) {
                stat.push({
                  form: 'destructured',
                  start: prop.start,
                  end: prop.end,
                  startIdx: k,
                  endIdx: k,
                  property: prop.value,
                  local: prop.value,
                  source: rhsTok.value,
                });
              }
            }
            destructured.push({
              kind: 'destructuring',
              start: toks[i].start,
              end: toks[braceClose].end,
              startIdx: i,
              endIdx: braceClose,
              braceOpenIdx: braceOpen,
              braceCloseIdx: braceClose,
              source: rhsTok.value,
              declares: toks.slice(braceOpen + 1, braceClose).filter((x) => x.type === 'ident').map((x) => x.value),
            });
          }
        }
      }
    }
  }

  // ------------------------------------------------ aliases and advisories
  for (const ref of stat) {
    const eqIdx = ref.startIdx - 1;
    const nameIdx = ref.startIdx - 2;
    const kwIdx = ref.startIdx - 3;
    const eq = toks[eqIdx];
    const name = toks[nameIdx];
    const kw = toks[kwIdx];
    if (!eq || !name || eq.value !== '=') continue;
    if (name.type !== 'ident' || name.keyword) continue;
    if (!kw || kw.type !== 'ident' || !['const', 'let', 'var'].includes(kw.value)) continue;
    const after = toks[ref.endIdx + 1];
    // The initialiser must be EXACTLY the flag expression. `const on = flags.x &&
    // other()` is not an alias: it is a compound expression, and treating it as
    // an alias would hide the real reference.
    const gap = src && after ? src.slice(toks[ref.endIdx].end, after.start) : '';
    const endsHere = !after
      || after.value === ';'
      || after.value === ')'
      || /\n/.test(gap);
    if (!endsHere) continue;
    const singleDeclarator = !(after && after.type === 'punct' && after.value === ',');
    // `const { x } = ...` never reaches here: the destructuring path owns it.
    if (toks[nameIdx - 1] && toks[nameIdx - 1].type === 'punct' && toks[nameIdx - 1].value === '{') continue;
    aliases.push({
      kind: 'alias',
      start: toks[kwIdx].start,
      end: ref.end,
      startIdx: kwIdx,
      endIdx: ref.endIdx,
      name: name.value,
      nameIdx,
      nameStart: name.start,
      nameEnd: name.end,
      refStartIdx: ref.startIdx,
      refEndIdx: ref.endIdx,
      singleDeclarator,
    });
  }

  // Advisory: the flag name appearing as a string argument to an unknown call.
  const claimedStrings = new Set(stat.filter((r) => r.form === 'call').map((r) => r.startIdx + 2));
  for (let i = 0; i < toks.length; i += 1) {
    const t = toks[i];
    if (literalNameAt(t) !== flagName) continue;
    if (claimedStrings.has(i)) continue;
    const callee = callCalleeAt(toks, i);
    if (callee === null) continue;
    if (config.flagFunctions.includes(callee)) continue;
    advisories.push({
      kind: 'unknown-api',
      message: `the flag name is passed as a string literal to ${callee}(), which is not one of the flag readers this tool knows. If that function reads flags, this reference will remain after the rewrite.`,
      start: t.start,
      end: t.end,
      startIdx: i,
    });
  }

  return { static: stat, dynamic, advisories, aliases, destructured };
}

function countArgs(argToks) {
  if (!argToks.length) return 0;
  let depth = 0;
  let n = 1;
  for (const t of argToks) {
    if (t.type !== 'punct') continue;
    if (t.value === '(' || t.value === '[' || t.value === '{') depth += 1;
    else if (t.value === ')' || t.value === ']' || t.value === '}') depth -= 1;
    else if (t.value === ',' && depth === 0) n += 1;
  }
  return n;
}

/**
 * Tokenizer shared by the build pipeline and (by copy) the plugin runtime.
 *
 * The plugin ships as a single plain-JS file with no imports from `src/`, so
 * `dsh-plugin/index.js` carries an identical copy of `tokenize()`. If you change
 * the token rules here, change them there too and run `node bench/parity.mjs`
 * (it asserts that both implementations produce the same tokens).
 *
 * Rules: lowercase ASCII word runs, plus for every run of CJK characters both
 * the unigrams and the adjacent bigrams (`学院` -> 学, 院, 学院).
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const lower = text.toLowerCase();
  for (const m of lower.matchAll(/[a-z0-9_]+/g)) tokens.push(m[0]);
  for (const m of lower.matchAll(/[\u4e00-\u9fff]+/g)) {
    const run = m[0];
    for (let i = 0; i < run.length; i++) {
      tokens.push(run[i]);
      if (i + 1 < run.length) tokens.push(run[i] + run[i + 1]);
    }
  }
  return tokens;
}

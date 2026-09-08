// The closed language vocabulary a fence's info string is read against.
//
// APART FROM THE TOKENIZER, AND THAT SEPARATION IS THE POINT. `code-tokenizer.ts`
// exists to be reached through `highlight-scheduler.ts`' dynamic import, so that the
// shiki core, the JavaScript regex engine, and the grammar table stay out of the
// renderer's initial bundle. A single VALUE import of that module from a component
// defeats the whole boundary — the bundler reports it as an ineffective dynamic
// import and merges the module back into the initial chunk — and resolving a fence's
// language is exactly the thing a component has to do before it can decide whether to
// ask for a highlight at all.
//
// So the vocabulary lives here and the loaders live there. This module names languages
// and aliases and imports nothing; the tokenizer keys its loader table by the type
// declared here, so a language added below without a loader still fails to compile.

/**
 * The languages a fenced block can be highlighted as. Closed, and every entry has a
 * loader in `code-tokenizer.ts`' grammar table, which is keyed by this tuple's type.
 *
 * Fifteen, chosen as what a session about this repository actually contains. A fence in
 * any other language renders as plain mono text, which is the honest degrade: it is
 * still the code, set in the figure face, and nothing about it is wrong except that it
 * is not coloured.
 */
export const HIGHLIGHTABLE_LANGUAGES = [
  "bash",
  "css",
  "diff",
  "go",
  "html",
  "javascript",
  "json",
  "jsx",
  "markdown",
  "python",
  "rust",
  "sql",
  "tsx",
  "typescript",
  "yaml",
] as const;

/** One highlightable language. Derived from the enumeration, never restated. */
export type HighlightableLanguage = (typeof HIGHLIGHTABLE_LANGUAGES)[number];

/**
 * Membership as a set, built once. The resolver used to ask the grammar table whether
 * it held a key, which is what tied a component's language lookup to the module that
 * imports shiki.
 */
const HIGHLIGHTABLE_LANGUAGE_SET: ReadonlySet<string> = new Set(HIGHLIGHTABLE_LANGUAGES);

/**
 * The aliases a fence's info string may use for a language this build has.
 *
 * Separate from the loader table on purpose: an alias is a naming fact and a loader is a
 * module, and folding them together would make the closed set of loadable modules
 * ambiguous. Every value here is a member of the tuple above, which the co-located test
 * asserts against the loader table too.
 */
const LANGUAGE_ALIASES: Readonly<Record<string, HighlightableLanguage>> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  mts: "typescript",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  yml: "yaml",
  py: "python",
  rs: "rust",
  md: "markdown",
  patch: "diff",
};

/**
 * The language a fence's info string names, or `undefined` for one this build cannot
 * highlight.
 *
 * Lower-cased and cut at the first space, commonmark's own reading of an info string.
 */
export function resolveHighlightableLanguage(
  infoString: string | null | undefined,
): HighlightableLanguage | undefined {
  if (infoString === null || infoString === undefined) {
    return undefined;
  }
  const [word] = infoString.trim().toLowerCase().split(/\s+/u);
  if (word === undefined || word === "") {
    return undefined;
  }
  if (HIGHLIGHTABLE_LANGUAGE_SET.has(word)) {
    return word as HighlightableLanguage;
  }
  return Object.prototype.hasOwnProperty.call(LANGUAGE_ALIASES, word)
    ? LANGUAGE_ALIASES[word]
    : undefined;
}

/** Every language this build can highlight, for the co-located test and the mapper. */
export function highlightableLanguages(): readonly HighlightableLanguage[] {
  return HIGHLIGHTABLE_LANGUAGES;
}

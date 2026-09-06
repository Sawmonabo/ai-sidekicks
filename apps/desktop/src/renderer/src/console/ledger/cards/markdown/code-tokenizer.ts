// The tokenizer — one `shiki/core` highlighter, the JavaScript engine, lazy grammars.
//
// `Spec-023 §Console Libraries`, syntax-highlighting row: "ADOPT-with-constraints
// `shiki/core` with the JavaScript engine and lazy grammars … One instance per renderer
// process, in a Worker above about 4 kB of source, byte-bounded token cache, own theme
// JSON from Meridian tokens, own span renderer; never the preset bundles, never the
// WebAssembly engine in the renderer (its linear memory grows to about 29 MB and is
// never reclaimed)."
//
// THIS MODULE RUNS IN TWO THREADS, and that is why it exists apart from the scheduler
// that calls it. The worker imports it and so does the main-thread path for small
// blocks; a second copy of the engine selection, the theme, and the grammar table would
// be two things to keep in step, and the one that drifted would be the one nobody looks
// at. "One instance per renderer process" is per JavaScript realm, and a worker is its
// own realm — so each thread holds at most one highlighter, which is what the constraint
// means and what this module enforces by construction.
//
// EVERY IMPORT OF SHIKI HERE IS DYNAMIC. Statically importing `shiki/core` would put the
// core, the JavaScript regex engine, and this module's whole graph into the renderer's
// initial bundle, against `Spec-023 §Console Design (Meridian)`'s 450 kB gzip budget —
// for a capability a session with no fenced code never uses. The first highlight pays
// for the load; nothing else does.
//
// THE GRAMMAR TABLE IS A CLOSED MAP OF LOADERS, not a template-literal import. A dynamic
// specifier built from a string would make the bundler emit a chunk for every one of
// shiki's several hundred grammars, and would let a fence's info string — text from a
// model — decide which module gets loaded. Both are answered by the same table.

import type { HighlighterCore, LanguageRegistration, ThemedToken } from "shiki/types";

import { meridianCodeTheme } from "./meridian-code-theme.js";

/**
 * The languages a fenced block can be highlighted as. Closed, and each entry names its
 * own loader so no specifier is ever composed from message text.
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
 * What a grammar module hands back: shiki's own registration list, under `default`.
 *
 * The array is NOT `readonly`, and that is the library's shape rather than a lapse:
 * `loadLanguage` takes a mutable `LanguageRegistration[]`, so declaring the loader's
 * result readonly here would only move the mismatch to the call site and cost a cast to
 * undo it.
 */
type GrammarLoader = () => Promise<{ readonly default: LanguageRegistration[] }>;

/**
 * The module each language is loaded from. Total over the enumeration by construction,
 * so a language added above without a loader fails to compile here.
 */
const GRAMMAR_LOADERS: Readonly<Record<HighlightableLanguage, GrammarLoader>> = {
  bash: () => import("shiki/langs/bash.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  diff: () => import("shiki/langs/diff.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  typescript: () => import("shiki/langs/typescript.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
};

/**
 * The aliases a fence's info string may use for a language this table has.
 *
 * Separate from the loader table on purpose: an alias is a naming fact and a loader is a
 * module, and folding them together would make the closed set of loadable modules
 * ambiguous. Every value here is a key there, which the co-located test asserts.
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
  if (Object.prototype.hasOwnProperty.call(GRAMMAR_LOADERS, word)) {
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

/** One token, reduced to what the console's own span renderer needs. */
export interface CodeToken {
  readonly content: string;
  /**
   * The family's custom-property reference, or `undefined` for a token the theme left
   * plain. Never a colour — see `meridian-code-theme.ts`.
   */
  readonly colorReference: string | undefined;
}

/** One line of tokens. Lines are the unit because a code block renders line by line. */
export type CodeTokenLine = readonly CodeToken[];

/**
 * The realm's highlighter, and the grammars it has been taught.
 *
 * A class rather than two module-level `let`s: the instance and the set of loaded
 * grammars are one piece of state with one lifetime, and `apps/desktop/AGENTS.md`
 * rejects the module-scope form outright. One is constructed per realm below.
 */
class RealmHighlighter {
  #highlighter: Promise<HighlighterCore> | undefined;
  readonly #loadedLanguages = new Set<HighlightableLanguage>();

  /**
   * Tokenise one block.
   *
   * Returns `undefined` — rather than throwing — when the grammar or the core cannot be
   * loaded. A highlight that could not run is a block rendered plain, which is a
   * degrade a reader can live with; an exception here would take the whole message's
   * card down through its row-group boundary for a colour.
   */
  public async tokenize(
    source: string,
    language: HighlightableLanguage,
  ): Promise<readonly CodeTokenLine[] | undefined> {
    try {
      const highlighter = await this.#resolveHighlighter();
      await this.#ensureLanguage(highlighter, language);
      const lines = highlighter.codeToTokensBase(source, { lang: language, theme: "meridian" });
      return lines.map((line) => line.map(reduceToken));
    } catch {
      return undefined;
    }
  }

  async #resolveHighlighter(): Promise<HighlighterCore> {
    // Assigned before the await completes, so two concurrent first calls share one
    // creation rather than racing to build two cores — which is what "one instance per
    // renderer process" means in a world where nothing serialises the callers.
    this.#highlighter ??= createCore();
    return this.#highlighter;
  }

  async #ensureLanguage(
    highlighter: HighlighterCore,
    language: HighlightableLanguage,
  ): Promise<void> {
    if (this.#loadedLanguages.has(language)) {
      return;
    }
    const loaded = await GRAMMAR_LOADERS[language]();
    await highlighter.loadLanguage(loaded.default);
    this.#loadedLanguages.add(language);
  }
}

async function createCore(): Promise<HighlighterCore> {
  const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
    import("shiki/core"),
    import("shiki/engine/javascript"),
  ]);
  return createHighlighterCore({
    themes: [meridianCodeTheme()],
    langs: [],
    engine: createJavaScriptRegexEngine(),
  });
}

/** Drop everything about a shiki token the console does not render. */
function reduceToken(token: ThemedToken): CodeToken {
  return { content: token.content, colorReference: token.color };
}

/** This realm's highlighter. One per realm, and a worker is its own realm. */
const realmHighlighter: RealmHighlighter = new RealmHighlighter();

/** Tokenise one block in the calling thread. */
export function tokenizeCode(
  source: string,
  language: HighlightableLanguage,
): Promise<readonly CodeTokenLine[] | undefined> {
  return realmHighlighter.tokenize(source, language);
}

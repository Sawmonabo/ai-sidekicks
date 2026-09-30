// Which language a fence's info string names, read against the languages the daemon
// colors.
//
// A block whose info string names none of them stays plain and asks the daemon for
// nothing, so this reading decides whether a block asks at all. The languages are the
// contract's; what is the renderer's own is the fence's spelling of them: the aliases
// a model writes (`ts`, `sh`, `yml`) and commonmark's reading of an info string.

import { HIGHLIGHT_LANGUAGES, type HighlightLanguage } from "@ai-sidekicks/contracts";

/**
 * The language the fence's info string names, or `undefined` for one the daemon cannot
 * color.
 *
 * Lower-cased and cut at the first space, commonmark's own reading of an info string.
 */
export function resolveHighlightableLanguage(
  infoString: string | null | undefined,
): HighlightLanguage | undefined {
  if (infoString === null || infoString === undefined) {
    return undefined;
  }
  const [word] = infoString.trim().toLowerCase().split(/\s+/u);
  if (word === undefined || word === "") {
    return undefined;
  }
  if (isHighlightLanguage(word)) {
    return word;
  }
  return Object.hasOwn(LANGUAGE_ALIASES, word) ? LANGUAGE_ALIASES[word] : undefined;
}

/**
 * The other names a fence's info string may use for a language the daemon colors.
 *
 * An own-property lookup rather than a plain index, so an info string reading
 * `constructor` or `__proto__` names nothing.
 */
const LANGUAGE_ALIASES: Readonly<Record<string, HighlightLanguage>> = {
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

function isHighlightLanguage(word: string): word is HighlightLanguage {
  return (HIGHLIGHT_LANGUAGES as readonly string[]).includes(word);
}

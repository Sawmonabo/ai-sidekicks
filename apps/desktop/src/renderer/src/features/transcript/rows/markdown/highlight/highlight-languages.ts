// Resolves a fence's info string to a language the daemon colors. The languages are the
// contract's; the fence's spelling of them (aliases such as `ts`, `sh`, `yml`, and commonmark's
// reading of an info string) is the renderer's own. A fence naming none stays plain.

import { HIGHLIGHT_LANGUAGES, type HighlightLanguage } from "@ai-sidekicks/contracts";

/**
 * The language the fence's info string names, or `undefined` for one the daemon cannot color.
 * The string is lower-cased and cut at the first space, commonmark's own reading.
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

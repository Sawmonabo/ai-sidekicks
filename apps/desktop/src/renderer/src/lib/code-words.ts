// The one code-to-words mapper: an error, refusal or event code read as words in sentence case, so
// no wire spelling reaches the screen. A feature hands in the labels its own codes register; every
// other code reads as its own words, the root's screen word standing for its wire root.

/** A code root whose screen word differs from its wire spelling. */
const ROOT_WORDS: Readonly<Record<string, string>> = { agent: "Sidekick" };

/**
 * `code` as words in sentence case: the label `registered` gives it where it has one, otherwise
 * its own words with the root's screen word, so `workflow.start_denied` reads
 * `Workflow start denied` and `agent.resolution_refused` reads `Sidekick resolution refused`.
 */
export function codeWords(code: string, registered: Readonly<Record<string, string>>): string {
  const label = registered[code];
  if (label !== undefined) {
    return label;
  }
  const [root = "", ...rest] = code.split(".");
  const words = [ROOT_WORDS[root] ?? root, ...rest]
    .join(" ")
    .replaceAll("_", " ")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

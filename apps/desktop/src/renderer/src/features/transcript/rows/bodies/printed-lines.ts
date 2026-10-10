// How many lines a program printed, read over an output's text in the pieces it is held in.

/** The lines in `texts` joined: one per line break, and the last unless the text ends on one. */
export function countPrintedLines(texts: readonly string[]): number {
  let lineBreakCount = 0;
  let lastCharacter = "";
  for (const text of texts) {
    for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
      lineBreakCount += 1;
    }
    lastCharacter = text.at(-1) ?? lastCharacter;
  }
  return lastCharacter === "\n" || lastCharacter === "" ? lineBreakCount : lineBreakCount + 1;
}

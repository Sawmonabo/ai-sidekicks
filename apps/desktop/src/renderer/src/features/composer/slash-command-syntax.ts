// The reserved slash prefix, read in one place for both the command list (filtering by
// name) and the send router (running a name), so the two never disagree.
//
// A command opens its line: the trigger must be the first character of the untouched text.
// Indented text that begins with a slash is prose, so pasted code is never claimed. A slash
// word on no list goes out as typed; there is no escape for a message that begins with one.

/** The prefix that opens the command list and claims a line for a command. */
export const SLASH_COMMAND_TRIGGER = "/";

/** Splits a draft on its first run of whitespace, to read the command word. */
const FIRST_WHITESPACE = /\s/u;

/**
 * The command name a line names, or `undefined` for ordinary prose, including an indented
 * line. The empty string is a real answer: the trigger alone opens the list unfiltered.
 */
export function readSlashCommandName(lineText: string): string | undefined {
  if (!opensCommandLine(lineText)) {
    return undefined;
  }
  return splitFirstWord(lineText.slice(SLASH_COMMAND_TRIGGER.length)).word;
}

/**
 * The text up to its first whitespace, and what follows from that whitespace on (empty when
 * there is none), so every command word on a line is read the same way.
 */
export function splitFirstWord(text: string): { readonly word: string; readonly rest: string } {
  const firstSpace = text.search(FIRST_WHITESPACE);
  return firstSpace === -1
    ? { word: text, rest: "" }
    : { word: text.slice(0, firstSpace), rest: text.slice(firstSpace) };
}

/** Whether this line is claimed by the reserved prefix at all. */
function opensCommandLine(lineText: string): boolean {
  return lineText.startsWith(SLASH_COMMAND_TRIGGER);
}

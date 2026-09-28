// The reserved slash prefix, read in exactly one place.
//
// The command zone reads the name a person is filtering the discovery list by, and the
// send router reads the name a person is asking it to run. Both readings live in this
// module: two copies of one normalization drift, and the surface that lists a name
// stops agreeing with the path that acts on it while every test stays green.
//
// The slash prefix is reserved for client commands. A slash word on no list is not
// a command: it goes out as typed, and there is no escape for a message that really
// begins with a slash.
//
// A DIRECTIVE OPENS ITS LINE, AND THE TRIGGER IS THE FIRST CHARACTER. The send router
// hands this module the user's text UNTOUCHED — trimming is a test there and never a
// transform — and a grammar that skipped leading whitespace would claim pasted code
// whose first non-blank character happens to be a slash. Indented text beginning
// with a slash is prose; a command occupies the whole line from its first byte. Both
// readers get that same answer, which is the property this module exists to hold.

/** The prefix that opens the discovery surface and claims a line for a command. */
export const DISCOVERY_TRIGGER = "/";

/** Splits a directive line on its first run of whitespace, to read the name. */
const FIRST_WHITESPACE = /\s/u;

/** Whether this line is claimed by the reserved prefix at all. */
function opensDirectiveLine(lineText: string): boolean {
  return lineText.startsWith(DISCOVERY_TRIGGER);
}

/**
 * The command name a line names, or `undefined` when the line names none.
 *
 * `undefined` for ordinary prose, including an indented line.
 *
 * The empty string is a real answer and not an absence — the trigger alone has been
 * typed, which opens the list with nothing filtered and names no command to run.
 */
export function readDirectiveName(lineText: string): string | undefined {
  if (!opensDirectiveLine(lineText)) {
    return undefined;
  }
  const afterTrigger = lineText.slice(DISCOVERY_TRIGGER.length);
  const firstSpace = afterTrigger.search(FIRST_WHITESPACE);
  return firstSpace === -1 ? afterTrigger : afterTrigger.slice(0, firstSpace);
}

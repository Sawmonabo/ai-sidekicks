// The reserved slash prefix, read in exactly one place.
//
// Two zones parse it and they were parsing it twice: the command zone read the name
// a person is filtering the discovery list by, and the send router read the name a
// person is asking it to run. Same trigger, same escape, same "first word after the
// slash" — written out separately, with two copies of the escape string and two
// copies of the whitespace split. This package's structure rules put both sides of
// one seam in one module for exactly this reason: two copies of one normalization
// drift, and the surface that lists a name stops agreeing with the path that acts on
// it while every test stays green.
//
// The vocabulary is Spec-017's C-18: the slash prefix is reserved for client
// commands, and `//` is the escape for a message that really begins with a slash.
//
// A DIRECTIVE OPENS ITS LINE, AND THE TRIGGER IS THE FIRST CHARACTER. The reading
// used to `trimStart()` first, so an indented line still named a command. It cannot
// any more, because the send router now hands this module the participant's text
// UNTOUCHED — trimming is a test there and never a transform — and a grammar that
// skipped leading whitespace would claim pasted code whose first non-blank character
// happens to be a slash. Indented text beginning with a slash is prose; a command
// occupies the whole line from its first byte. Both readers get that same answer,
// which is the property this module exists to hold.

/** The prefix that opens the discovery surface and claims a line for a command. */
export const DISCOVERY_TRIGGER = "/";

/** The escape that sends a message really beginning with a slash — never a trigger. */
export const LITERAL_SLASH_ESCAPE = "//";

/** Splits a directive line on its first run of whitespace, to read the name. */
const FIRST_WHITESPACE = /\s/u;

/**
 * Whether this line is claimed by the reserved prefix at all.
 *
 * True for the literal-slash escape too, which is deliberate: the escape is a
 * directive-grammar construct rather than ordinary prose, and the router has to
 * reach it through this grammar to strip it. What separates the two is
 * {@link readDirectiveName}, which names a command for one and nothing for the other.
 */
export function opensDirectiveLine(lineText: string): boolean {
  return lineText.startsWith(DISCOVERY_TRIGGER);
}

/**
 * The command name a line names, or `undefined` when the line names none.
 *
 * `undefined` for ordinary prose and for the literal-slash escape, which is
 * deliberately not a command: a discovery popover over it would offer commands for
 * text that begins with a slash on purpose, and a router that read a name out of it
 * would run one.
 *
 * The empty string is a real answer and not an absence — the trigger alone has been
 * typed, which opens the list with nothing filtered and names no command to run.
 */
export function readDirectiveName(lineText: string): string | undefined {
  if (!opensDirectiveLine(lineText) || lineText.startsWith(LITERAL_SLASH_ESCAPE)) {
    return undefined;
  }
  const afterTrigger = lineText.slice(DISCOVERY_TRIGGER.length);
  const firstSpace = afterTrigger.search(FIRST_WHITESPACE);
  return firstSpace === -1 ? afterTrigger : afterTrigger.slice(0, firstSpace);
}

/**
 * Take the escape off a line that carries one, and change nothing else.
 *
 * The decoding half of the escape the reading above recognises, so both halves sit
 * in one module and one of them cannot start accepting a form the other rejects.
 * Exactly one character comes off and the remainder is returned byte-identical — a
 * line that is not escaped is returned as it arrived.
 */
export function stripLiteralSlashEscape(lineText: string): string {
  return lineText.startsWith(LITERAL_SLASH_ESCAPE)
    ? lineText.slice(DISCOVERY_TRIGGER.length)
    : lineText;
}

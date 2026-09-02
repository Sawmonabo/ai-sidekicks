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

/** The prefix that opens the discovery surface and claims a line for a command. */
export const DISCOVERY_TRIGGER = "/";

/** The escape that sends a message really beginning with a slash — never a trigger. */
export const LITERAL_SLASH_ESCAPE = "//";

/** Splits a directive line on its first run of whitespace, to read the name. */
const FIRST_WHITESPACE = /\s/u;

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
  const line = lineText.trimStart();
  if (!line.startsWith(DISCOVERY_TRIGGER) || line.startsWith(LITERAL_SLASH_ESCAPE)) {
    return undefined;
  }
  const afterTrigger = line.slice(DISCOVERY_TRIGGER.length);
  const firstSpace = afterTrigger.search(FIRST_WHITESPACE);
  return firstSpace === -1 ? afterTrigger : afterTrigger.slice(0, firstSpace);
}

// What an ANSI escape sequence IS, apart from how a styled run is drawn.
//
// Its own module beside `ansi-spans.ts` because it answers a different question and
// has a different reader. That file maps the runs `anser` produced onto the console's
// palette; this one decides whether a body is command output at all, and removes the
// sequences the library's parse leaves behind. `MachineBody` reads the first and the
// span mapper reads the second, so neither has to import the other's whole job.
//
// A SCANNER RATHER THAN A REGULAR EXPRESSION, and not for speed: a pattern carrying
// these bytes is what `no-control-regex` exists to stop, and the escape it would need
// to get past that rule is the escape a later reader cannot check. Written out, each
// sequence family is one branch a person can read against the standard.

/** The one byte every ANSI sequence opens with. */
const ESCAPE = "\u001b";

/** The BEL that terminates an OSC sequence, and the one this build's shells send. */
const BELL = "\u0007";

/**
 * Whether a body carries ANSI escape sequences at all.
 *
 * THE WIRE'S OWN SHAPE READING, AND THE ONLY ONE AVAILABLE. No registered payload says
 * what shape a machine-authored body is: `ToolActivityPayload` carries a tool name, a
 * call id, a duration and the content descriptors and no content type, and
 * `HydratedSessionEventContent` carries the bytes and no type either. So the bytes are
 * what the console has to read, and they are enough — a body carrying an escape IS
 * command output, and one carrying none is prose. Answering "ANSI" for every tool
 * result read terminal output into an MCP reply; answering "prose" for every one of
 * them put a build log's escape sequences on the page as text.
 *
 * The introducer and nothing else: every sequence this module knows opens with it, and
 * a tab or a newline is ordinary text a prose renderer already handles.
 */
export function carriesAnsiEscapes(source: string): boolean {
  return source.includes(ESCAPE);
}

/**
 * Text with every escape sequence removed, whatever family it belongs to.
 *
 * MEASURED AGAINST THE PINNED LIBRARY RATHER THAN ASSUMED. `anser`'s `ansiToJson`
 * consumes CSI sequences — the SGR ones it styles and the cursor, erase and scroll
 * ones it does not — and leaves OSC and the two-byte escapes inside a chunk's own
 * `content`, where they would reach the page as text. So the residue is removed here,
 * after the parse rather than before it: the sequences the library DOES consume are
 * the ones carrying the styling, and a pre-pass over the source would take those with
 * them and render a build log in one colour.
 *
 * A body carrying no escape is returned BY IDENTITY, which is nearly every body.
 *
 * AND A TRUNCATED BODY CAN END MID-SEQUENCE, so every branch treats running off the
 * end as the sequence ending there. Half a sequence on screen is the same defect as
 * all of it.
 */
export function withoutResidualEscapes(text: string): string {
  if (!carriesAnsiEscapes(text)) {
    return text;
  }
  let kept = "";
  let cursor = 0;
  while (cursor < text.length) {
    const escapeAt = text.indexOf(ESCAPE, cursor);
    if (escapeAt < 0) {
      kept += text.slice(cursor);
      break;
    }
    kept += text.slice(cursor, escapeAt);
    cursor = endOfSequenceAt(text, escapeAt);
  }
  return kept;
}

/** Where the sequence opening at `escapeAt` ends — one past its last byte. */
function endOfSequenceAt(text: string, escapeAt: number): number {
  const introducer = text[escapeAt + 1];
  if (introducer === undefined) {
    // A lone introducer at the end of a truncated body. It is still a byte no reader
    // should see, so it goes with the rest.
    return escapeAt + 1;
  }
  if (introducer === "]") {
    return endOfOperatingSystemCommand(text, escapeAt + 2);
  }
  if (introducer === "[") {
    // CSI: parameter bytes, then intermediates, then one final byte.
    return endOfParameterisedSequence(text, escapeAt + 2, "0", "?");
  }
  if (isWithin(introducer, " ", "/")) {
    // An escape carrying intermediate bytes — `ESC ( B` and its family.
    return endOfParameterisedSequence(text, escapeAt + 1, " ", "/");
  }
  // A parameterless escape, and anything else: the introducer and one byte.
  return escapeAt + 2;
}

/**
 * Where an OSC ends: at BEL, at the two-byte string terminator, or at the body's end.
 *
 * Both terminators, because a stream may use either and a half-matched sequence would
 * leave its tail on screen.
 */
function endOfOperatingSystemCommand(text: string, from: number): number {
  for (let cursor = from; cursor < text.length; cursor += 1) {
    if (text[cursor] === BELL) {
      return cursor + 1;
    }
    if (text[cursor] === ESCAPE) {
      return text[cursor + 1] === "\\" ? cursor + 2 : cursor;
    }
  }
  return text.length;
}

/** Where a sequence ends after its parameter and intermediate bytes and one final. */
function endOfParameterisedSequence(
  text: string,
  from: number,
  parameterLow: string,
  parameterHigh: string,
): number {
  let cursor = from;
  while (cursor < text.length && isWithin(text[cursor], parameterLow, parameterHigh)) {
    cursor += 1;
  }
  while (cursor < text.length && isWithin(text[cursor], " ", "/")) {
    cursor += 1;
  }
  return cursor < text.length ? cursor + 1 : text.length;
}

/** Whether a byte falls in an inclusive range of the standard's own tables. */
function isWithin(byte: string | undefined, low: string, high: string): boolean {
  return byte !== undefined && byte >= low && byte <= high;
}

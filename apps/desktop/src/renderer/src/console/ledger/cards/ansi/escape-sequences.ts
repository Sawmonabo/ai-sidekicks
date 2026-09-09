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
 * The C1 string terminator — the single-byte spelling of `ESC \`.
 *
 * ACCEPTED AS A TERMINATOR THOUGH NOT AS AN INTRODUCER, and the asymmetry is a decision
 * rather than an omission. This scanner opens on ESC and on nothing else, because the
 * reading below tests for that byte alone and widening it to the C1 range would classify
 * any body carrying one of those codepoints as command output. A stream that OPENED with
 * `ESC P` may still close with this single byte, though, and refusing it here would leave
 * the payload of a correctly formed sequence on the page.
 */
const STRING_TERMINATOR = "\u009c";

/**
 * The four string controls whose payload runs until a terminator ends it: DCS
 * (`ESC P`), SOS (`ESC X`), PM (`ESC ^`) and APC (`ESC _`).
 *
 * THEY ARE NOT TWO-BYTE ESCAPES, which is what this scan read them as — so a terminal
 * that sent a DCS put its whole payload on the page as text, up to the trailing ST the
 * scan never looked for. OSC is the fifth member of the family and keeps a branch of its
 * own, because it is the one that also ends at BEL.
 */
const STRING_CONTROL_INTRODUCERS: readonly string[] = ["P", "X", "^", "_"];

/**
 * Whether a body carries ANSI escape sequences at all.
 *
 * THE WIRE'S OWN SHAPE READING FOR A BODY WHOSE PRODUCER DECLARED NONE. The tool trio
 * carries a tool name, a call id, a duration and the content descriptors and no content
 * type, and `HydratedSessionEventContent` carries the bytes and no type either — so for
 * those rows the bytes are what the console has to read, and they are enough: a body
 * carrying an escape IS command output, and one carrying none is prose. Answering "ANSI"
 * for every tool result read terminal output into an MCP reply; answering "prose" for
 * every one of them put a build log's escape sequences on the page as text.
 *
 * IT IS NOT THE ONLY READING, AND THIS ONE IS THE FALLBACK. `AssistantOutputPayload`
 * carries `contentType`, the producer's own declaration of the body's media type, and
 * `MachineBody` prefers it where it is present: a `text/markdown` reply is markdown
 * whether or not a stray control byte rode along with it, and a `text/plain` one is
 * never reformatted. This reading answers for the rows that declare nothing.
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
    // OSC: a string control that ALSO ends at BEL, which is what this build's shells send.
    return endOfStringControl(text, escapeAt + 2, true);
  }
  if (STRING_CONTROL_INTRODUCERS.includes(introducer)) {
    // DCS, SOS, PM, APC: the same shape as OSC minus the BEL, so the payload is consumed
    // through its terminator rather than left standing as text after two bytes.
    return endOfStringControl(text, escapeAt + 2, false);
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
 * Where a string control ends: at its terminator, or at the body's end.
 *
 * ONE FUNCTION FOR ALL FIVE OF THEM, and the BEL is the only thing that separates OSC
 * from the other four: every one of them opens a payload of arbitrary length and closes
 * it with ST. Two copies of this walk would drift, and the copy that drifted would be
 * the one leaving a payload on the page.
 *
 * BOTH SPELLINGS OF ST, because a stream may use either and a half-matched sequence
 * leaves its tail on screen: the two-byte `ESC \` and the single-byte C1 form.
 *
 * AND AN ESCAPE THAT IS NOT ST ENDS THE CONTROL WHERE IT STANDS, which is
 * resynchronisation rather than consumption — a payload containing one belongs to a
 * sequence nobody terminated, so the scan hands that escape back to the caller's loop
 * to be read as the start of whatever it introduces. The cursor has advanced past the
 * introducer by then, so the walk always moves forward and a body of unterminated
 * controls cannot spin.
 */
function endOfStringControl(text: string, from: number, endsAtBell: boolean): number {
  for (let cursor = from; cursor < text.length; cursor += 1) {
    const byte = text[cursor];
    if (endsAtBell && byte === BELL) {
      return cursor + 1;
    }
    if (byte === STRING_TERMINATOR) {
      return cursor + 1;
    }
    if (byte === ESCAPE) {
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

// Detects and strips ANSI escape sequences. A hand-written scanner rather than a regular
// expression: a pattern holding these control bytes trips `no-control-regex`, and each kind of
// sequence is one branch that can be read against the standard.

import { type PublishedText } from "../../reveal/published-text.js";

/** The one byte every ANSI sequence opens with. */
const ESCAPE = "\u001b";

/** The BEL that terminates an OSC sequence. */
const BELL = "\u0007";

/**
 * The C1 string terminator, the single-byte spelling of `ESC \`. Accepted as a terminator but
 * not as an introducer: the scan opens on ESC alone, so a stream opened with `ESC P` may still
 * close with this byte.
 */
const STRING_TERMINATOR = "\u009c";

/**
 * The string controls whose payload runs until a terminator: DCS (`ESC P`), SOS (`ESC X`),
 * PM (`ESC ^`) and APC (`ESC _`). Read as two-byte escapes, a DCS payload would reach the page as
 * text. OSC has its own branch because it also ends at BEL.
 */
const STRING_CONTROL_INTRODUCERS: readonly string[] = ["P", "X", "^", "_"];

/**
 * Whether a body carries ANSI escape sequences, judged by the ESC byte alone. A streaming body
 * answers from where it last looked, so asking each frame reads only the frame's growth.
 *
 * This is the reading for a body with no declared media type, such as a tool result; a
 * declared type wins (see `outputKindOf`).
 */
export function carriesAnsiEscapes(source: PublishedText): boolean {
  return source.firstIndexOf(ESCAPE) !== -1;
}

/**
 * Text with every escape sequence removed. A body with no escape is returned as is.
 *
 * `anser` consumes CSI sequences but leaves OSC and the two-byte escapes inside a chunk's
 * content, so the residue is stripped after the parse; a pre-pass would take the styling with
 * it. A truncated body can end mid-sequence: every branch treats the end of the text as the
 * end of the sequence.
 */
export function withoutResidualEscapes(text: string): string {
  if (!text.includes(ESCAPE)) {
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
    // A lone introducer at the end of a truncated body.
    return escapeAt + 1;
  }
  if (introducer === "]") {
    // OSC also ends at BEL.
    return endOfStringControl(text, escapeAt + 2, true);
  }
  if (STRING_CONTROL_INTRODUCERS.includes(introducer)) {
    // DCS, SOS, PM, APC: the same shape as OSC without the BEL.
    return endOfStringControl(text, escapeAt + 2, false);
  }
  if (introducer === "[") {
    // CSI: parameter bytes, then intermediates, then one final byte.
    return endOfParameterizedSequence(text, escapeAt + 2, "0", "?");
  }
  if (isWithin(introducer, " ", "/")) {
    // An escape carrying intermediate bytes — `ESC ( B` and its kind.
    return endOfParameterizedSequence(text, escapeAt + 1, " ", "/");
  }
  // A parameterless escape, and anything else: the introducer and one byte.
  return escapeAt + 2;
}

/**
 * Where a string control ends: at its terminator (ST in either spelling, or BEL when
 * `endsAtBell`) or at the body's end.
 *
 * An escape that is not ST ends the control where it stands and is handed back to the caller's
 * loop to be read as the start of whatever it introduces. The walk always moves forward, so
 * unterminated controls cannot spin.
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
function endOfParameterizedSequence(
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

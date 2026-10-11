// Detects and strips ANSI escape sequences. A hand-written scanner rather than a regular
// expression: a pattern holding these control bytes trips `no-control-regex`, and each kind of
// sequence is one branch that can be read against the standard.

import {
  joinIntoPiecesInSlices,
  joinPieces,
  piecesOf,
  type PiecedText,
} from "#renderer/lib/text-pieces.js";
import {
  piecedTextOfPublished,
  publishedTextOf,
  type PublishedText,
} from "../../reveal/published-text.js";

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
 * Removes escape sequences from a text read a chunk at a time: where a chunk ends inside a
 * sequence is carried to the next, so a sequence cut between two chunks is removed whole.
 */
export class EscapeSequenceStripper {
  #state: ScanState = "text";

  /** The runs of `chunk` that lie outside every escape sequence, in order, none of them empty. */
  public strip(chunk: string): string[] {
    const kept: string[] = [];
    let cursor = 0;
    while (cursor < chunk.length) {
      if (this.#state !== "text") {
        this.#state = stateAfter(this.#state, chunk.charAt(cursor));
        cursor += 1;
        continue;
      }
      const escapeAt = chunk.indexOf(ESCAPE, cursor);
      const runEnd = escapeAt < 0 ? chunk.length : escapeAt;
      if (runEnd > cursor) {
        kept.push(chunk.slice(cursor, runEnd));
      }
      if (escapeAt >= 0) {
        this.#state = "escape";
      }
      cursor = runEnd + 1;
    }
    return kept;
  }
}

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
 * `text` with every escape sequence removed; a text with no escape is returned as is.
 *
 * `anser` consumes CSI sequences but leaves OSC and the two-byte escapes inside a chunk's
 * content, so the residue is stripped after the parse; a pre-pass would take the styling with
 * it. A truncated body can end mid-sequence: the end of the text ends the sequence.
 */
export function withoutResidualEscapes(text: string): string {
  return text.includes(ESCAPE) ? joinPieces(new EscapeSequenceStripper().strip(text)) : text;
}

/**
 * A body's text without escape sequences: the same handle for a text that carries none, the usual
 * case. One that carries some is stripped whole, into a string of its own.
 */
export function withoutResidualEscapesOf(text: PublishedText): PublishedText {
  return carriesAnsiEscapes(text) ? publishedTextOf(withoutResidualEscapes(text.slice(0))) : text;
}

/**
 * A body's text without escape sequences, in pieces: a text that carries none as it is, one that
 * carries some at once when it is stripped inside the calling task's slice, else a piece at a time
 * in slices in `view`, so no task grows with it.
 */
export function withoutResidualEscapesInPieces(
  text: PublishedText,
  view: Window,
): PiecedText | Promise<PiecedText> {
  return carriesAnsiEscapes(text)
    ? joinIntoPiecesInSlices(keptRunsOf(text.chunks()), view)
    : piecedTextOfPublished(text);
}

/**
 * Where a scan stands: in text, just past an ESC, in an OSC payload (which BEL also ends), in a
 * DCS, SOS, PM or APC payload, among a CSI's parameter bytes, or among intermediate bytes, which
 * one final byte of any kind ends.
 */
type ScanState =
  | "text"
  | "escape"
  | "osc-payload"
  | "string-control-payload"
  | "csi-parameters"
  | "intermediates";

/**
 * Where a scan in `state` stands once it reads `byte`. An escape inside a string control ends the
 * control where it stands and is read as the start of whatever it introduces; `ESC \` reads as an
 * escape of one byte, so that reading also ends the control at its two-byte terminator.
 */
function stateAfter(state: Exclude<ScanState, "text">, byte: string): ScanState {
  switch (state) {
    case "escape":
      return stateAfterIntroducer(byte);
    case "osc-payload":
    case "string-control-payload":
      if (byte === ESCAPE) {
        return "escape";
      }
      return byte === STRING_TERMINATOR || (state === "osc-payload" && byte === BELL)
        ? "text"
        : state;
    case "csi-parameters":
      if (isWithin(byte, "0", "?")) {
        return state;
      }
      return isIntermediate(byte) ? "intermediates" : "text";
    case "intermediates":
      return isIntermediate(byte) ? state : "text";
  }
}

/** Where a scan stands once it reads the byte after an ESC. */
function stateAfterIntroducer(introducer: string): ScanState {
  if (introducer === "]") {
    return "osc-payload";
  }
  if (STRING_CONTROL_INTRODUCERS.includes(introducer)) {
    // DCS, SOS, PM, APC: the same shape as OSC without the BEL.
    return "string-control-payload";
  }
  if (introducer === "[") {
    // CSI: parameter bytes, then intermediates, then one final byte.
    return "csi-parameters";
  }
  // An escape carrying intermediate bytes, `ESC ( B` and its kind, ends at its final byte; a
  // parameterless escape, and anything else, at the introducer itself.
  return isIntermediate(introducer) ? "intermediates" : "text";
}

/** The runs outside every escape sequence of the text `chunks` join, read a piece at a time. */
function* keptRunsOf(chunks: readonly string[]): Generator<string> {
  const stripper = new EscapeSequenceStripper();
  for (const chunk of chunks) {
    for (const piece of piecesOf(chunk)) {
      yield* stripper.strip(piece);
    }
  }
}

/** Whether a byte is an intermediate byte, which may follow an escape or a CSI's parameters. */
function isIntermediate(byte: string): boolean {
  return isWithin(byte, " ", "/");
}

/** Whether a byte falls in an inclusive range of the standard's own tables. */
function isWithin(byte: string, low: string, high: string): boolean {
  return byte >= low && byte <= high;
}

// A long text held as pieces of bounded length, so work on the page's thread reads it a piece at a
// time and no task grows with the text. Pieces are joined only by concatenation, which the engine
// keeps as links to the pieces rather than copying them, and move to and from a worker as UTF-8
// bytes, each piece encoded or decoded in a step of its own, the buffers moved rather than copied.

import { workInSlices } from "./work-slices.js";

/** A text, and the same text in pieces of at most `TEXT_PIECE_LENGTH` code units. */
export interface PiecedText {
  /** The pieces joined: never read whole on the page's thread, whose task would grow with it. */
  readonly text: string;
  readonly pieces: readonly string[];
}

/**
 * The most UTF-16 code units one piece holds. Measured on a loaded machine, a 10 MB text took
 * 19 ms to encode as UTF-8 and 9 ms to decode, so a piece of 64 Ki units takes about 0.1 ms.
 */
export const TEXT_PIECE_LENGTH = 65_536;

/**
 * `text` in pieces of at most `TEXT_PIECE_LENGTH` code units, cut never between the two halves of
 * a surrogate pair, so each piece encodes alone. `text` is read in cuts, which copy nothing of a
 * text held whole.
 */
export function piecesOf(text: string): string[] {
  const pieces: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + TEXT_PIECE_LENGTH, text.length);
    if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1))) {
      end -= 1;
    }
    pieces.push(text.slice(start, end));
    start = end;
  }
  return pieces;
}

/** `pieces` joined, linked rather than copied. */
export function joinPieces(pieces: readonly string[]): string {
  let text = "";
  for (const piece of pieces) {
    text += piece;
  }
  return text;
}

/**
 * The text `texts` join to, as the UTF-8 bytes of each piece of each of them, all at once, for a
 * worker's own thread.
 */
export function encodeTextPieces(texts: readonly string[]): ArrayBuffer[] {
  return texts.flatMap((text) => piecesOf(text).map(utf8BytesOf));
}

/** The text the UTF-8 pieces in `buffers` hold, all at once, for a worker's own thread. */
export function decodeTextPieces(buffers: readonly ArrayBuffer[]): string {
  const decoder = new TextDecoder();
  return joinPieces(buffers.map((buffer) => decoder.decode(buffer)));
}

/** The UTF-8 bytes of each of `pieces`, encoded a few pieces a slice in `view`. */
export async function encodePiecesInSlices(
  pieces: readonly string[],
  view: Window,
): Promise<ArrayBuffer[]> {
  const buffers: ArrayBuffer[] = [];
  await workInSlices(
    view,
    (hasTime) => {
      for (const piece of pieces.slice(buffers.length)) {
        buffers.push(utf8BytesOf(piece));
        if (!hasTime()) {
          break;
        }
      }
      return buffers.length === pieces.length;
    },
    () => false,
  );
  return buffers;
}

/** The text the UTF-8 pieces in `buffers` hold, each decoded in a slice in `view`. */
export async function decodePiecesInSlices(
  buffers: readonly ArrayBuffer[],
  view: Window,
): Promise<PiecedText> {
  const decoder = new TextDecoder();
  const pieces: string[] = [];
  await workInSlices(
    view,
    (hasTime) => {
      for (const buffer of buffers.slice(pieces.length)) {
        pieces.push(decoder.decode(buffer));
        if (!hasTime()) {
          break;
        }
      }
      return pieces.length === buffers.length;
    },
    () => false,
  );
  return { text: joinPieces(pieces), pieces };
}

/** Stateless, so one encoder serves every caller. */
const UTF8_ENCODER = new TextEncoder();

/** The UTF-8 bytes of `piece`, in a buffer of their own that can be moved. */
function utf8BytesOf(piece: string): ArrayBuffer {
  return UTF8_ENCODER.encode(piece).buffer as ArrayBuffer;
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

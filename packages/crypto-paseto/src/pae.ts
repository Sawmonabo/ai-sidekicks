/**
 * PASETO Pre-Authentication Encoding: joins byte strings into one length-prefixed stream, so two
 * different piece lists can never produce the same bytes.
 *
 *   PAE(pieces) = LE64(len(pieces))
 *               || LE64(len(pieces[0])) || pieces[0]
 *               || LE64(len(pieces[1])) || pieces[1]
 *               || ...
 *
 * LE64(n) is a 64-bit little-endian unsigned integer with bit 63 cleared (the top bit of byte[7]
 * is forced to 0); the encoding depends on that.
 */
export function pae(pieces: readonly Uint8Array[]): Uint8Array {
  const totalLength =
    8 + // length prefix for the piece count
    pieces.reduce((acc, piece) => acc + 8 + piece.length, 0);
  const out = new Uint8Array(totalLength);
  let offset = 0;

  writeLE64HighBitCleared(out, offset, pieces.length);
  offset += 8;

  for (const piece of pieces) {
    writeLE64HighBitCleared(out, offset, piece.length);
    offset += 8;
    out.set(piece, offset);
    offset += piece.length;
  }

  return out;
}

function writeLE64HighBitCleared(out: Uint8Array, offset: number, value: number): void {
  // A JS safe integer is below 2^53, so the value splits into low 32 bits and up to 21 high bits.
  let lo = value >>> 0;
  let hi = Math.floor(value / 0x1_0000_0000) >>> 0;
  for (let i = 0; i < 4; i++) {
    out[offset + i] = lo & 0xff;
    lo >>>= 8;
  }
  for (let i = 0; i < 4; i++) {
    out[offset + 4 + i] = hi & 0xff;
    hi >>>= 8;
  }
  // Clear bit 63.
  out[offset + 7] = out[offset + 7]! & 0x7f;
}

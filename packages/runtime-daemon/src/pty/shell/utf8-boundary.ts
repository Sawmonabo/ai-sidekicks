// Where UTF-8 characters start and end in a run of bytes, so a shell's output is cut and decoded
// only between whole characters.

/** Whether `byte` continues a UTF-8 character rather than starting one. */
export function isContinuationByte(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

// How many bytes the character a lead byte starts takes; a byte that starts none takes itself.
function sequenceLength(leadByte: number): number {
  if (leadByte >= 0xc2 && leadByte <= 0xdf) {
    return 2;
  }
  if (leadByte >= 0xe0 && leadByte <= 0xef) {
    return 3;
  }
  if (leadByte >= 0xf0 && leadByte <= 0xf4) {
    return 4;
  }
  return 1;
}

/**
 * How many bytes at the end of `bytes` begin a character the next bytes would complete: none, or
 * up to three. A decoder holds exactly these back until more output comes.
 */
export function incompleteTailLength(bytes: Uint8Array): number {
  const end = bytes.byteLength;
  for (let start = end - 1; start >= 0 && end - start <= 3; start -= 1) {
    const byte = bytes[start] ?? 0;
    if (!isContinuationByte(byte)) {
      return end - start < sequenceLength(byte) ? end - start : 0;
    }
  }
  return 0;
}

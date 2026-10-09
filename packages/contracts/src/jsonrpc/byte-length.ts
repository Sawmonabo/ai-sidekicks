// How many bytes a value takes on the wire, which the message limit and the page budget both
// measure. It builds no schema, so code that only sizes a reply loads no schema library.

/**
 * The UTF-8 byte length of `value` serialized as JSON, the quantity the message limit and the page
 * budget bound, or `Number.POSITIVE_INFINITY` when it cannot be serialized. It never throws,
 * because zod refinements call it; it counts by hand because this package has no `Buffer`.
 */
export function jsonUtf8ByteLength(value: unknown): number {
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? "";
  } catch {
    return Number.POSITIVE_INFINITY;
  }
  let byteLength = 0;
  for (let index = 0; index < serialized.length; index += 1) {
    const codeUnit = serialized.charCodeAt(index);
    if (codeUnit < 0x80) {
      byteLength += 1;
    } else if (codeUnit < 0x800) {
      byteLength += 2;
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff && index + 1 < serialized.length) {
      byteLength += 4;
      index += 1;
    } else {
      byteLength += 3;
    }
  }
  return byteLength;
}

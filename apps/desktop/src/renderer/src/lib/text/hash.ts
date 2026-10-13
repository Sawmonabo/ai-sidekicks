// A text's hashes over its UTF-16 code units: a 32-bit one where a stored number tells whether a
// text changed, and a 64-bit one where a hash stands in for texts as a key, with no copy of them.

/** A text's FNV-1a hash over its UTF-16 code units, as an unsigned 32-bit number. */
export function hashOf(text: string): number {
  let hash = FNV_OFFSET_BASIS;
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), FNV_PRIME);
  }
  return hash >>> 0;
}

/**
 * The texts' 64-bit hash with each one's length, as a short string: equal for equal texts, and so
 * rarely shared by two different ones that it stands in for them as a key. It is cyrb53 with its
 * two 32-bit lanes kept whole rather than cut to 53 bits. The lengths tell `["ab", "c"]` from
 * `["a", "bc"]`.
 */
export function wideHashOf(texts: readonly string[]): string {
  let first = WIDE_FIRST_SEED;
  let second = WIDE_SECOND_SEED;
  for (const text of texts) {
    for (let index = 0; index < text.length; index += 1) {
      const unit = text.charCodeAt(index);
      first = Math.imul(first ^ unit, 2_654_435_761);
      second = Math.imul(second ^ unit, 1_597_334_677);
    }
  }
  first = Math.imul(first ^ (first >>> 16), 2_246_822_507);
  first ^= Math.imul(second ^ (second >>> 13), 3_266_489_909);
  second = Math.imul(second ^ (second >>> 16), 2_246_822_507);
  second ^= Math.imul(first ^ (first >>> 13), 3_266_489_909);
  const lengths = texts.map((text) => text.length.toString(36)).join(".");
  return `${lengths}:${(second >>> 0).toString(36)}.${(first >>> 0).toString(36)}`;
}

/** FNV-1a's 32-bit offset basis and prime. */
const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** cyrb53's seeds of its two lanes. */
const WIDE_FIRST_SEED = 0xdeadbeef;
const WIDE_SECOND_SEED = 0x41c6ce57;

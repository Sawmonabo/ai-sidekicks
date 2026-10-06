// The minter's ids are RFC 9562 version 7 UUIDs that strictly increase, within one millisecond,
// across a counter overflow and across a clock that steps backwards.

import { describe, expect, it } from "vitest";

import { mintUuidV7, UuidV7Minter } from "../uuid-v7.js";

/** Canonical lowercase 8-4-4-4-12 hex text form. Uppercase hex fails on purpose. */
const CANONICAL_TEXT_FORM = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** Decodes the canonical text form to its 16 bytes, refusing anything malformed. */
function parseUuidBytes(text: string): Uint8Array {
  if (!CANONICAL_TEXT_FORM.test(text)) {
    throw new Error(`not the canonical lowercase UUID text form: ${text}`);
  }
  const hexDigits: string = text.replaceAll("-", "");
  const bytes = new Uint8Array(16);
  for (let byteOffset = 0; byteOffset < 16; byteOffset += 1) {
    bytes[byteOffset] = Number.parseInt(hexDigits.slice(byteOffset * 2, byteOffset * 2 + 2), 16);
  }
  return bytes;
}

/** The 48-bit big-endian `unix_ts_ms` field. */
function readTimestampMilliseconds(text: string): number {
  const bytes: Uint8Array = parseUuidBytes(text);
  const highHalf: number = (bytes[0]! << 8) | bytes[1]!;
  const lowHalf: number =
    bytes[2]! * 0x1000000 + ((bytes[3]! << 16) | (bytes[4]! << 8) | bytes[5]!);
  return highHalf * 2 ** 32 + lowHalf;
}

/** The 12-bit counter occupying `rand_a`. */
function readSubMillisecondCounter(text: string): number {
  const bytes: Uint8Array = parseUuidBytes(text);
  return ((bytes[6]! & 0x0f) << 8) | bytes[7]!;
}

/** The single structural assertion: throws naming the first violated RFC 9562 rule. */
function assertRfc9562UuidV7(text: string): void {
  if (!CANONICAL_TEXT_FORM.test(text)) {
    throw new Error(`not the canonical lowercase UUID text form: ${text}`);
  }
  const bytes: Uint8Array = parseUuidBytes(text);

  // Version: the most significant 4 bits of octet 6.
  const version: number = bytes[6]! >>> 4;
  if (version !== 7) {
    throw new Error(`expected UUID version 7 (RFC 9562 section 4.2), read version ${version}`);
  }

  // Variant `0b10`: the two most significant bits of octet 8.
  const variantBits: number = bytes[8]! >>> 6;
  if (variantBits !== 0b10) {
    throw new Error(
      `expected variant bits 0b10 (RFC 9562 section 4.1), read 0b${variantBits.toString(2)}`,
    );
  }
}

/** A clock frozen at one millisecond, so the counter is the only thing that moves. */
function frozenClockAt(timestampMilliseconds: number): () => number {
  return (): number => timestampMilliseconds;
}

/** Fills every byte with `0xff`, making both the counter seed and `rand_b` deterministic. */
function fillWithSaturatedBytes(target: Uint8Array): void {
  target.fill(0xff);
}

const FIXED_TIMESTAMP_MILLISECONDS = 1_767_225_600_000;

describe("UuidV7Minter — RFC 9562 section 5.7 layout", () => {
  it("sets the version nibble to 7 and the variant bits to 0b10", () => {
    const minter = new UuidV7Minter();
    for (let mintIndex = 0; mintIndex < 256; mintIndex += 1) {
      assertRfc9562UuidV7(minter.mint());
    }
  });

  it("refuses a clock reading outside the 48-bit unix_ts_ms range", () => {
    expect(() =>
      new UuidV7Minter({ readCurrentTimestampMilliseconds: frozenClockAt(-1) }).mint(),
    ).toThrow(RangeError);
    expect(() =>
      new UuidV7Minter({ readCurrentTimestampMilliseconds: frozenClockAt(2 ** 48) }).mint(),
    ).toThrow(RangeError);
    expect(() =>
      new UuidV7Minter({ readCurrentTimestampMilliseconds: frozenClockAt(Number.NaN) }).mint(),
    ).toThrow(RangeError);
  });
});

describe("UuidV7Minter — RFC 9562 section 6.2 monotonicity", () => {
  it("orders ids minted inside one frozen millisecond", () => {
    const minter = new UuidV7Minter({
      readCurrentTimestampMilliseconds: frozenClockAt(FIXED_TIMESTAMP_MILLISECONDS),
    });
    const ids: string[] = Array.from({ length: 512 }, () => minter.mint());

    for (const id of ids) {
      assertRfc9562UuidV7(id);
      expect(readTimestampMilliseconds(id)).toBe(FIXED_TIMESTAMP_MILLISECONDS);
    }
    for (let index = 1; index < ids.length; index += 1) {
      expect(ids[index]! > ids[index - 1]!).toBe(true);
      expect(readSubMillisecondCounter(ids[index]!)).toBe(
        readSubMillisecondCounter(ids[index - 1]!) + 1,
      );
    }
  });

  it("advances the timestamp and reseeds when the counter overflows inside one tick", () => {
    const minter = new UuidV7Minter({
      readCurrentTimestampMilliseconds: frozenClockAt(FIXED_TIMESTAMP_MILLISECONDS),
      fillWithRandomBytes: fillWithSaturatedBytes,
    });
    // Seed 0x7ff plus 2048 increments exhausts the 12-bit counter exactly.
    const withinFirstTick: string[] = Array.from({ length: 2049 }, () => minter.mint());
    const afterOverflow: string = minter.mint();

    // An all-ones draw masks to the largest seed: guard bit clear, low 11 bits set.
    expect(readSubMillisecondCounter(withinFirstTick[0]!)).toBe(0x7ff);

    expect(readSubMillisecondCounter(withinFirstTick.at(-1)!)).toBe(0xfff);
    for (const id of withinFirstTick) {
      expect(readTimestampMilliseconds(id)).toBe(FIXED_TIMESTAMP_MILLISECONDS);
    }
    expect(readTimestampMilliseconds(afterOverflow)).toBe(FIXED_TIMESTAMP_MILLISECONDS + 1);
    expect(readSubMillisecondCounter(afterOverflow)).toBe(0x7ff);
    expect(afterOverflow > withinFirstTick.at(-1)!).toBe(true);
    assertRfc9562UuidV7(afterOverflow);
  });

  it("never regresses when the clock steps backwards", () => {
    let clockReading: number = FIXED_TIMESTAMP_MILLISECONDS;
    const minter = new UuidV7Minter({
      readCurrentTimestampMilliseconds: (): number => clockReading,
    });
    const beforeStep: string = minter.mint();
    clockReading = FIXED_TIMESTAMP_MILLISECONDS - 5_000;
    const afterStep: string = minter.mint();

    expect(afterStep > beforeStep).toBe(true);
    expect(readTimestampMilliseconds(afterStep)).toBe(FIXED_TIMESTAMP_MILLISECONDS);
  });

  it("mints 10,000 ids on the real clock that strictly increase and never collide", () => {
    const ids: string[] = Array.from({ length: 10_000 }, () => mintUuidV7());

    expect(new Set(ids).size).toBe(ids.length);
    for (let index = 1; index < ids.length; index += 1) {
      expect(ids[index]! > ids[index - 1]!).toBe(true);
    }
    for (const id of ids) {
      assertRfc9562UuidV7(id);
    }
    expect([...ids].sort()).toStrictEqual(ids);
  });
});

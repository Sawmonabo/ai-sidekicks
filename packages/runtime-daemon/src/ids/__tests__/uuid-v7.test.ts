// Tests for the daemon's single UUIDv7 generator (`../uuid-v7.js`).
//
// Every structural assertion in this file runs through one helper,
// `assertRfc9562UuidV7`, so the negative control at the bottom is meaningful:
// the same assertion that passes for `mintUuidV7()` is shown to REJECT
// `crypto.randomUUID()`, which is the v4 the daemon used to mint everywhere
// while the contracts claimed v7. A shape assertion that never fails proves
// nothing about the shape it claims to check.

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

/** RFC 9562 §5.7 — the 48-bit big-endian `unix_ts_ms` field. */
function readTimestampMilliseconds(text: string): number {
  const bytes: Uint8Array = parseUuidBytes(text);
  const highHalf: number = (bytes[0]! << 8) | bytes[1]!;
  const lowHalf: number =
    bytes[2]! * 0x1000000 + ((bytes[3]! << 16) | (bytes[4]! << 8) | bytes[5]!);
  return highHalf * 2 ** 32 + lowHalf;
}

/** RFC 9562 §6.2 Method 1 — the 12-bit counter occupying `rand_a`. */
function readSubMillisecondCounter(text: string): number {
  const bytes: Uint8Array = parseUuidBytes(text);
  return ((bytes[6]! & 0x0f) << 8) | bytes[7]!;
}

/**
 * The single structural assertion. Throws with a named cause on the first
 * violated RFC 9562 rule; the negative control depends on this throwing for a
 * v4 input.
 */
function assertRfc9562UuidV7(text: string): void {
  if (!CANONICAL_TEXT_FORM.test(text)) {
    throw new Error(`not the canonical lowercase UUID text form: ${text}`);
  }
  const bytes: Uint8Array = parseUuidBytes(text);

  // RFC 9562 §4.2 — version in the most significant 4 bits of octet 6.
  const version: number = bytes[6]! >>> 4;
  if (version !== 7) {
    throw new Error(`expected UUID version 7 (RFC 9562 section 4.2), read version ${version}`);
  }

  // RFC 9562 §4.1 — variant `0b10` in the two most significant bits of octet 8.
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
      const id: string = minter.mint();
      expect(() => {
        assertRfc9562UuidV7(id);
      }).not.toThrow();
      expect(parseUuidBytes(id)[6]! >>> 4).toBe(7);
      expect(parseUuidBytes(id)[8]! >>> 6).toBe(0b10);
    }
  });

  it("emits the canonical lowercase text form", () => {
    const id: string = new UuidV7Minter().mint();
    expect(id).toMatch(CANONICAL_TEXT_FORM);
    expect(id).toBe(id.toLowerCase());
    expect(id).toHaveLength(36);
  });

  it("decodes unix_ts_ms back to the injected clock's millisecond", () => {
    const minter = new UuidV7Minter({
      readCurrentTimestampMilliseconds: frozenClockAt(FIXED_TIMESTAMP_MILLISECONDS),
    });
    expect(readTimestampMilliseconds(minter.mint())).toBe(FIXED_TIMESTAMP_MILLISECONDS);
  });

  it("carries a 48-bit timestamp, so a millisecond above 2^32 survives the split", () => {
    const aboveThirtyTwoBits: number = 2 ** 40 + 12_345;
    const minter = new UuidV7Minter({
      readCurrentTimestampMilliseconds: frozenClockAt(aboveThirtyTwoBits),
    });
    expect(readTimestampMilliseconds(minter.mint())).toBe(aboveThirtyTwoBits);
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

  it("seeds the counter into the low 11 bits, reserving the rollover-guard bit", () => {
    const minter = new UuidV7Minter({
      readCurrentTimestampMilliseconds: frozenClockAt(FIXED_TIMESTAMP_MILLISECONDS),
      fillWithRandomBytes: fillWithSaturatedBytes,
    });
    // An all-ones random draw masks to the largest admissible seed, which is
    // the guard bit clear and the low 11 bits set.
    expect(readSubMillisecondCounter(minter.mint())).toBe(0x7ff);
  });

  it("advances the timestamp and reseeds when the counter overflows inside one tick", () => {
    const minter = new UuidV7Minter({
      readCurrentTimestampMilliseconds: frozenClockAt(FIXED_TIMESTAMP_MILLISECONDS),
      fillWithRandomBytes: fillWithSaturatedBytes,
    });
    // Seed 0x7ff plus 2048 increments exhausts the 12-bit counter exactly.
    const withinFirstTick: string[] = Array.from({ length: 2049 }, () => minter.mint());
    const afterOverflow: string = minter.mint();

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

  it("gives each instance its own counter, and the module binding one shared counter", () => {
    const boundMint: () => string = mintUuidV7;
    expect(boundMint() < boundMint()).toBe(true);

    const independent = new UuidV7Minter({
      readCurrentTimestampMilliseconds: frozenClockAt(FIXED_TIMESTAMP_MILLISECONDS),
    });
    expect(readTimestampMilliseconds(independent.mint())).toBe(FIXED_TIMESTAMP_MILLISECONDS);
  });
});

describe("negative control — the shape assertion can fail", () => {
  it("rejects crypto.randomUUID(), the v4 the daemon used to mint for these ids", () => {
    const v4: string = crypto.randomUUID();

    expect(v4).toMatch(CANONICAL_TEXT_FORM);
    expect(parseUuidBytes(v4)[6]! >>> 4).toBe(4);
    expect(() => {
      assertRfc9562UuidV7(v4);
    }).toThrow(/expected UUID version 7 \(RFC 9562 section 4\.2\), read version 4/u);
  });

  it("rejects an uppercase rendering of an otherwise valid v7", () => {
    expect(() => {
      assertRfc9562UuidV7(mintUuidV7().toUpperCase());
    }).toThrow(/not the canonical lowercase UUID text form/u);
  });

  it("rejects a v7 whose variant bits were cleared", () => {
    const bytes: Uint8Array = parseUuidBytes(mintUuidV7());
    bytes[8] = bytes[8]! & 0x3f;
    const hexDigits: string = Array.from(bytes, (byteValue: number) =>
      byteValue.toString(16).padStart(2, "0"),
    ).join("");
    const rendered = `${hexDigits.slice(0, 8)}-${hexDigits.slice(8, 12)}-${hexDigits.slice(12, 16)}-${hexDigits.slice(16, 20)}-${hexDigits.slice(20)}`;

    expect(() => {
      assertRfc9562UuidV7(rendered);
    }).toThrow(/expected variant bits 0b10/u);
  });
});

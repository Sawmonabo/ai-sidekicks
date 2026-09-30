// The daemon's single UUIDv7 generator: RFC 9562 section 5.7 layout with the section 6.2
// Method 1 fixed-bit-length counter.
//
// Every daemon-side persisted-row id and event id mints here. The contracts package promises
// these ids are v7 (a sortable millisecond timestamp in the leading 48 bits), while
// `crypto.randomUUID()` emits v4, which has no time ordering. The wire schemas accept any UUID
// version, so nothing downstream would reject a v4; ESLint denies `.randomUUID` and the
// `randomUUID` import from `node:crypto` across `packages/runtime-daemon/src/**` instead. Four
// files that mint ephemeral tokens (no row or event stores them) are exempt as whole files,
// so a second mint added inside one of them is caught in review, not by lint.
//
// No dependency: section 5.7 is a bit layout over a timestamp and a random buffer, and owning
// it keeps the id format auditable against the RFC text.
//
// Layout (RFC 9562 section 5.7, big-endian, bit indices from the most significant):
//
//   0                   1                   2                   3
//   0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
//  +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
//  |                          unix_ts_ms                           |
//  +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
//  |          unix_ts_ms           |  ver  |       rand_a          |
//  +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
//  |var|                        rand_b                             |
//  +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
//  |                            rand_b                             |
//  +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
//
//   * `unix_ts_ms`: 48-bit big-endian unsigned Unix Epoch milliseconds.
//   * `ver`: 0b0111, the most significant 4 bits of octet 6 (RFC 9562 section 4.2).
//   * `rand_a`: 12 bits, positioned right after the timestamp; here it holds the counter.
//   * `var`: 0b10, bits 0 and 1 of octet 8 (RFC 9562 section 4.1).
//   * `rand_b`: 62 bits of fresh randomness on every mint.
//
// Monotonicity (section 6.2, Method 1): `rand_a` is a 12-bit counter, seeded randomly on each
// new millisecond tick and incremented for every id minted inside that tick, so the 128-bit
// value strictly increases within a tick whatever `rand_b` draws. The seed fills only the low
// 11 bits, so every tick has at least 2048 increments of headroom before overflow.
//
//   * A clock that goes backwards (NTP step, suspend/resume) reuses the prior timestamp and
//     increments the counter, so the sequence never regresses.
//   * A counter that overflows 12 bits inside one tick advances the emitted timestamp by one
//     millisecond and reseeds the counter. The emitted timestamp then leads the wall clock
//     until the wall clock catches up.
//
// Monotonicity is per process (the counter is instance state); two daemon processes minting in
// the same millisecond order by their `rand_b` draw.

const UUID_BYTE_LENGTH = 16;

/** `unix_ts_ms` is 48 bits (RFC 9562 section 5.7); this is the first value it cannot hold. */
const TIMESTAMP_MILLISECONDS_EXCLUSIVE_MAXIMUM = 2 ** 48;

/** Divisor splitting the 48-bit timestamp into a 16-bit high half and a 32-bit low half. */
const TIMESTAMP_LOW_HALF_MODULUS = 2 ** 32;

/** RFC 9562 section 6.2 Method 1: `rand_a` is 12 bits wide, so the counter saturates here. */
const SUB_MILLISECOND_COUNTER_MAXIMUM = 0xfff;

/** Counter seed mask: low 11 bits only, so each tick keeps at least 2048 increments. */
const SUB_MILLISECOND_COUNTER_SEED_MASK = 0x7ff;

/** RFC 9562 section 4.2: version 7 in the most significant 4 bits of octet 6. */
const VERSION_7_HIGH_NIBBLE = 0x70;

/** RFC 9562 section 4.1: variant `0b10` in the two most significant bits of octet 8. */
const VARIANT_RFC_9562_HIGH_BITS = 0x80;

/** Bytes of random seed drawn for each new millisecond tick's counter. */
const COUNTER_SEED_BYTE_LENGTH = 2;

/** Lowercase hex text for each byte value, so `mint()` never allocates a per-byte pad. */
const HEX_BY_BYTE: readonly string[] = Array.from({ length: 256 }, (_unused, byteValue: number) =>
  byteValue.toString(16).padStart(2, "0"),
);

/** Byte offsets at which the canonical 8-4-4-4-12 text form takes a hyphen. */
const HYPHEN_BYTE_OFFSETS: ReadonlySet<number> = new Set([4, 6, 8, 10]);

/**
 * The clock and random source the minter reads. Both default to the platform's; tests inject
 * them to freeze a millisecond or drive the counter to overflow.
 */
export interface UuidV7MinterDependencies {
  /** Unix Epoch milliseconds. Defaults to `Date.now`. */
  readonly readCurrentTimestampMilliseconds?: () => number;
  /** Fills `target` with cryptographically strong bytes. Defaults to `crypto.getRandomValues`. */
  readonly fillWithRandomBytes?: (target: Uint8Array<ArrayBuffer>) => void;
}

/**
 * Mints RFC 9562 UUIDv7 values that strictly increase within one instance. The daemon uses the
 * shared `mintUuidV7`; a fresh instance carries its own counter and is for tests.
 */
export class UuidV7Minter {
  readonly #readCurrentTimestampMilliseconds: () => number;
  readonly #fillWithRandomBytes: (target: Uint8Array<ArrayBuffer>) => void;

  /** Scratch buffers, reused across mints so a hot append path allocates nothing per id. */
  readonly #uuidBytes: Uint8Array<ArrayBuffer> = new Uint8Array(UUID_BYTE_LENGTH);
  readonly #counterSeedBytes: Uint8Array<ArrayBuffer> = new Uint8Array(COUNTER_SEED_BYTE_LENGTH);

  /**
   * The millisecond the last id was stamped with: the wall clock's reading, or ahead of it
   * after a counter overflow. `-1` means no id minted yet.
   */
  #lastEmittedTimestampMilliseconds = -1;

  /** The Method 1 counter occupying `rand_a` for the current tick. */
  #subMillisecondCounter = 0;

  constructor(dependencies: UuidV7MinterDependencies = {}) {
    this.#readCurrentTimestampMilliseconds =
      dependencies.readCurrentTimestampMilliseconds ?? ((): number => Date.now());
    this.#fillWithRandomBytes =
      dependencies.fillWithRandomBytes ??
      ((target: Uint8Array<ArrayBuffer>): void => {
        crypto.getRandomValues(target);
      });
  }

  /**
   * Mints one UUIDv7 in the canonical lowercase 8-4-4-4-12 text form. Throws a `RangeError` when
   * the clock reads a timestamp `unix_ts_ms` cannot hold (negative, non-finite, or at or past
   * 2^48 ms), because a truncated timestamp would give a well-formed id that sorts wrongly.
   */
  mint(): string {
    const timestampMilliseconds: number = this.#resolveMonotonicTimestampMilliseconds();

    const bytes: Uint8Array<ArrayBuffer> = this.#uuidBytes;
    const timestampHighHalf: number = Math.floor(
      timestampMilliseconds / TIMESTAMP_LOW_HALF_MODULUS,
    );
    const timestampLowHalf: number = timestampMilliseconds % TIMESTAMP_LOW_HALF_MODULUS;

    // `unix_ts_ms`: 48 big-endian bits across octets 0-5.
    bytes[0] = (timestampHighHalf >>> 8) & 0xff;
    bytes[1] = timestampHighHalf & 0xff;
    bytes[2] = (timestampLowHalf / 0x1000000) & 0xff;
    bytes[3] = (timestampLowHalf >>> 16) & 0xff;
    bytes[4] = (timestampLowHalf >>> 8) & 0xff;
    bytes[5] = timestampLowHalf & 0xff;

    // Octets 6-7: the version nibble over the counter's high 4 bits, then its low 8.
    const counter: number = this.#subMillisecondCounter;
    bytes[6] = VERSION_7_HIGH_NIBBLE | ((counter >>> 8) & 0x0f);
    bytes[7] = counter & 0xff;

    // Octets 8-15: `rand_b`, drawn fresh every mint, with the variant overwriting the top two
    // bits of octet 8. Filling from octet 8 leaves the timestamp and counter bytes intact.
    this.#fillWithRandomBytes(bytes.subarray(8));
    bytes[8] = VARIANT_RFC_9562_HIGH_BITS | (bytes[8]! & 0x3f);

    return this.#formatCanonicalText(bytes);
  }

  /** Advances the tick and counter state and returns the millisecond this id is stamped with. */
  #resolveMonotonicTimestampMilliseconds(): number {
    const wallClockMilliseconds: number = this.#readCurrentTimestampMilliseconds();
    if (
      !Number.isFinite(wallClockMilliseconds) ||
      wallClockMilliseconds < 0 ||
      wallClockMilliseconds >= TIMESTAMP_MILLISECONDS_EXCLUSIVE_MAXIMUM
    ) {
      throw new RangeError(
        `UuidV7Minter: clock read ${String(wallClockMilliseconds)} is outside the 48-bit ` +
          "unix_ts_ms range RFC 9562 section 5.7 defines (0 to 2^48 - 1 milliseconds).",
      );
    }

    const wholeMilliseconds: number = Math.floor(wallClockMilliseconds);
    if (wholeMilliseconds > this.#lastEmittedTimestampMilliseconds) {
      // A new tick: reseed the counter.
      this.#lastEmittedTimestampMilliseconds = wholeMilliseconds;
      this.#subMillisecondCounter = this.#drawCounterSeed();
      return wholeMilliseconds;
    }

    // Same tick, or a clock that went backwards.
    const incrementedCounter: number = this.#subMillisecondCounter + 1;
    if (incrementedCounter <= SUB_MILLISECOND_COUNTER_MAXIMUM) {
      this.#subMillisecondCounter = incrementedCounter;
      return this.#lastEmittedTimestampMilliseconds;
    }

    // Counter overflow: the emitted timestamp now leads the wall clock.
    const advancedTimestampMilliseconds: number = this.#lastEmittedTimestampMilliseconds + 1;
    if (advancedTimestampMilliseconds >= TIMESTAMP_MILLISECONDS_EXCLUSIVE_MAXIMUM) {
      throw new RangeError(
        "UuidV7Minter: counter overflow would advance unix_ts_ms past the 48-bit range " +
          "RFC 9562 section 5.7 defines.",
      );
    }
    this.#lastEmittedTimestampMilliseconds = advancedTimestampMilliseconds;
    this.#subMillisecondCounter = this.#drawCounterSeed();
    return advancedTimestampMilliseconds;
  }

  /** Draws an 11-bit counter seed, leaving the 12th bit clear as overflow headroom. */
  #drawCounterSeed(): number {
    const seedBytes: Uint8Array<ArrayBuffer> = this.#counterSeedBytes;
    this.#fillWithRandomBytes(seedBytes);
    return ((seedBytes[0]! << 8) | seedBytes[1]!) & SUB_MILLISECOND_COUNTER_SEED_MASK;
  }

  /** Renders the 16 bytes as the canonical lowercase 8-4-4-4-12 hex text form. */
  #formatCanonicalText(bytes: Uint8Array): string {
    let text = "";
    for (let byteOffset = 0; byteOffset < UUID_BYTE_LENGTH; byteOffset += 1) {
      if (HYPHEN_BYTE_OFFSETS.has(byteOffset)) {
        text += "-";
      }
      text += HEX_BY_BYTE[bytes[byteOffset]!];
    }
    return text;
  }
}

/** The daemon-wide minter: one counter, so ids minted anywhere in the process sort together. */
const daemonUuidV7Minter: UuidV7Minter = new UuidV7Minter();

/** Mints one UUIDv7 through the daemon-wide minter, for persisted row and event ids. */
export const mintUuidV7: () => string = daemonUuidV7Minter.mint.bind(daemonUuidV7Minter);

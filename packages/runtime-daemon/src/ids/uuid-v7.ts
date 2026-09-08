// The daemon's single UUIDv7 generator — RFC 9562 §5.7 layout with the §6.2
// Method 1 fixed-bit-length dedicated counter.
//
// Why this module exists
// ----------------------
//
// `packages/contracts/src/session.ts` (header, "ID format") and
// `packages/contracts/src/event.ts` (`EventId` / branded-id notes) both state
// that daemon-assigned ids are RFC 9562 UUID **v7** — a sortable
// millisecond timestamp in the leading 48 bits — and Spec-006 says the same
// for event ids. Every daemon id source used to call `crypto.randomUUID()`,
// which emits **v4**: 122 bits of pure randomness with no time ordering at
// all. The wire schemas accept any UUID version on purpose (control-plane
// rows are Postgres `gen_random_uuid()` v4), so nothing rejected a v4 — the
// corpus claim was simply false at the source.
//
// This module makes it true, and makes it true ONCE. Spec-014 has since made
// v7 minting normative for artifact ids (Plan-014 T14.2's `mintArtifactId()`),
// so a second hand-rolled minter would have been the beginning of a family.
// Every daemon-side persisted-row id and event id mints here; the ephemeral
// correlation / subscription / scratch-path tokens that no row and no event
// stores stay on `crypto.randomUUID()` and say so at their call site.
//
// That split is enforced mechanically by
// `src/ids/__tests__/daemon-id-factory-tripwire.test.ts`, whose
// `finds no randomUUID mention outside ids beyond the allow-listed occurrences`
// sweeps the daemon's sources and pairs every `randomUUID` line against an
// allow-list of exact `(path, line text)` exemptions. It is a test and not a
// `no-restricted-syntax` entry because flat config replaces a rule's options
// at the last matching object and `packages/runtime-daemon/src/**` already
// carries one for a different guard — that test's own header explains the
// mechanics, and this module is not a second place to keep them.
//
// Why no dependency
// -----------------
//
// RFC 9562 §5.7 is a bit-setting function over a timestamp and a random
// buffer, not an algorithm: 48 big-endian timestamp bits, a 4-bit version
// nibble, 12 bits of `rand_a`, a 2-bit variant field, and 62 bits of
// `rand_b`. §6.2's Method 1 adds a counter in `rand_a`. The whole thing is
// the ~60 lines below over `crypto.getRandomValues`, and owning it keeps the
// daemon's id format auditable against the RFC text rather than against a
// transitive package's release notes.
//
// Layout (RFC 9562 §5.7, big-endian, bit indices from the most significant):
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
//   * `unix_ts_ms` — 48-bit big-endian unsigned Unix Epoch milliseconds.
//   * `ver` — 0b0111, the most significant 4 bits of octet 6 (RFC 9562 §4.2).
//   * `rand_a` — 12 bits; here the §6.2 Method 1 counter, which the RFC
//     requires be "positioned immediately after the embedded timestamp".
//   * `var` — 0b10, bits 0 and 1 of octet 8 (RFC 9562 §4.1).
//   * `rand_b` — 62 bits of fresh randomness on every mint.
//
// Monotonicity (RFC 9562 §6.2, Method 1)
// --------------------------------------
//
// Two ids minted in the same millisecond must still sort. `rand_a` carries a
// 12-bit counter that is randomly seeded on each new millisecond tick and
// incremented for every id minted inside that tick, so the 128-bit value
// strictly increases within a tick regardless of what `rand_b` draws. The RFC's
// rollover guard is applied by seeding into the low 11 bits only, reserving
// the most significant counter bit: every tick therefore has at least 2048
// increments of headroom before overflow, while the seed still carries 11
// bits of unguessability rather than starting every tick at zero.
//
// Both §6.2 corrective actions are implemented:
//
//   * A clock that goes backwards (NTP step, suspend/resume) reuses the prior
//     timestamp and increments the counter, so the sequence never regresses.
//   * A counter that overflows 12 bits inside one tick advances the emitted
//     timestamp by one millisecond and reinitializes the counter, so the
//     sequence never regresses there either. The emitted timestamp may then
//     lead the wall clock until the wall clock catches up, which is the
//     documented trade the RFC names.
//
// Monotonicity is per process (the counter is instance state). Two daemon
// processes minting in the same millisecond order by their `rand_b` draw,
// which is what the RFC's own unguessability guidance already accepts —
// nothing in the corpus asks for cross-process total order.

const UUID_BYTE_LENGTH = 16;

/** RFC 9562 §5.7 — `unix_ts_ms` is 48 bits, so this is the first unrepresentable millisecond. */
const TIMESTAMP_MILLISECONDS_EXCLUSIVE_MAXIMUM = 2 ** 48;

/** Divisor splitting the 48-bit timestamp into a 16-bit high half and a 32-bit low half. */
const TIMESTAMP_LOW_HALF_MODULUS = 2 ** 32;

/** RFC 9562 §6.2 Method 1 — `rand_a` is 12 bits wide, so the counter saturates here. */
const SUB_MILLISECOND_COUNTER_MAXIMUM = 0xfff;

/**
 * RFC 9562 §6.2 rollover guard — the counter seeds into the low 11 bits, reserving
 * the most significant bit so every tick keeps at least 2048 increments of headroom.
 */
const SUB_MILLISECOND_COUNTER_SEED_MASK = 0x7ff;

/** RFC 9562 §4.2 — version 7 in the most significant 4 bits of octet 6. */
const VERSION_7_HIGH_NIBBLE = 0x70;

/** RFC 9562 §4.1 — variant `0b10` in the two most significant bits of octet 8. */
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
 * Seams the minter reads the outside world through. Both default to the platform
 * source; tests inject them to freeze a millisecond or to drive the counter to
 * its documented overflow deterministically.
 */
export interface UuidV7MinterDependencies {
  /** Unix Epoch milliseconds. Defaults to `Date.now`. */
  readonly readCurrentTimestampMilliseconds?: () => number;
  /** Fills `target` with cryptographically strong bytes. Defaults to `crypto.getRandomValues`. */
  readonly fillWithRandomBytes?: (target: Uint8Array<ArrayBuffer>) => void;
}

/**
 * Mints RFC 9562 UUIDv7 values that are strictly increasing within this
 * instance's lifetime.
 *
 * Stateful by construction — the §6.2 Method 1 counter and the tick it belongs
 * to are the whole mechanism, and a free function would have to be handed both
 * on every call, which is precisely how two call sites end up sharing neither.
 * The daemon uses the module-level `mintUuidV7` binding; a fresh instance is
 * for tests and for any future caller that genuinely wants an independent
 * counter.
 */
export class UuidV7Minter {
  readonly #readCurrentTimestampMilliseconds: () => number;
  readonly #fillWithRandomBytes: (target: Uint8Array<ArrayBuffer>) => void;

  /** Scratch buffers, reused across mints so a hot append path allocates nothing per id. */
  readonly #uuidBytes: Uint8Array<ArrayBuffer> = new Uint8Array(UUID_BYTE_LENGTH);
  readonly #counterSeedBytes: Uint8Array<ArrayBuffer> = new Uint8Array(COUNTER_SEED_BYTE_LENGTH);

  /**
   * The millisecond the last id was stamped with — which is the wall clock's
   * reading in the ordinary case and ahead of it after a counter overflow.
   * `-1` marks "no id minted yet", which no real timestamp can collide with.
   */
  #lastEmittedTimestampMilliseconds = -1;

  /** RFC 9562 §6.2 Method 1 counter occupying `rand_a` for the current tick. */
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
   * Mints one UUIDv7 in the canonical lowercase 8-4-4-4-12 text form.
   *
   * Throws when the injected clock reads a timestamp `unix_ts_ms` cannot hold
   * (negative, non-finite, or at or past 2^48 ms — the year 10889). Failing
   * loudly is the only honest option: a silently truncated timestamp would
   * produce a well-formed id that sorts into the wrong century.
   */
  mint(): string {
    const timestampMilliseconds: number = this.#resolveMonotonicTimestampMilliseconds();

    const bytes: Uint8Array<ArrayBuffer> = this.#uuidBytes;
    const timestampHighHalf: number = Math.floor(
      timestampMilliseconds / TIMESTAMP_LOW_HALF_MODULUS,
    );
    const timestampLowHalf: number = timestampMilliseconds % TIMESTAMP_LOW_HALF_MODULUS;

    // `unix_ts_ms` — 48 big-endian bits across octets 0-5.
    bytes[0] = (timestampHighHalf >>> 8) & 0xff;
    bytes[1] = timestampHighHalf & 0xff;
    bytes[2] = (timestampLowHalf / 0x1000000) & 0xff;
    bytes[3] = (timestampLowHalf >>> 16) & 0xff;
    bytes[4] = (timestampLowHalf >>> 8) & 0xff;
    bytes[5] = timestampLowHalf & 0xff;

    // Octets 6-7 — the version nibble over the counter's high 4 bits, then its low 8.
    const counter: number = this.#subMillisecondCounter;
    bytes[6] = VERSION_7_HIGH_NIBBLE | ((counter >>> 8) & 0x0f);
    bytes[7] = counter & 0xff;

    // Octets 8-15 — `rand_b`, drawn fresh every mint, with the variant overwriting
    // the two most significant bits of octet 8. Filling from octet 8 keeps the
    // timestamp and counter bytes written above untouched.
    this.#fillWithRandomBytes(bytes.subarray(8));
    bytes[8] = VARIANT_RFC_9562_HIGH_BITS | (bytes[8]! & 0x3f);

    return this.#formatCanonicalText(bytes);
  }

  /**
   * Advances the tick / counter state per RFC 9562 §6.2 and returns the millisecond
   * this id is stamped with.
   */
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
      // A new tick: reseed the counter (§6.2 "randomly initialize the counter
      // with each new timestamp tick").
      this.#lastEmittedTimestampMilliseconds = wholeMilliseconds;
      this.#subMillisecondCounter = this.#drawCounterSeed();
      return wholeMilliseconds;
    }

    // Same tick, or a clock that went backwards. §6.2's first corrective action:
    // reuse the prior timestamp and increment the counter.
    const incrementedCounter: number = this.#subMillisecondCounter + 1;
    if (incrementedCounter <= SUB_MILLISECOND_COUNTER_MAXIMUM) {
      this.#subMillisecondCounter = incrementedCounter;
      return this.#lastEmittedTimestampMilliseconds;
    }

    // Counter overflow. §6.2's second corrective action: advance the timestamp
    // and reinitialize the counter. The emitted timestamp now leads the wall
    // clock until the wall clock catches up.
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

  /** Draws an 11-bit counter seed, leaving the 12th bit clear as the §6.2 rollover guard. */
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

/**
 * The daemon-wide minter. One instance means one monotonic counter, so ids
 * minted anywhere in the process sort against each other.
 */
const daemonUuidV7Minter: UuidV7Minter = new UuidV7Minter();

/**
 * Mints one RFC 9562 UUIDv7 through the daemon-wide minter — the default id
 * factory for every persisted row id and every event id in this package.
 */
export const mintUuidV7: () => string = daemonUuidV7Minter.mint.bind(daemonUuidV7Minter);

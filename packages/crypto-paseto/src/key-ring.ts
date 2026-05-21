import { InvalidKeyError } from "./errors.js";

export interface KeyRingEntry {
  readonly id: string; // e.g., "k_2026_05"
  readonly key: Uint8Array; // 32 bytes
  readonly createdAt: Date;
  // `Date | undefined` (not bare `Date`) is required by tsconfig.base's
  // `exactOptionalPropertyTypes: true`. The constructor reads this property
  // by value (`e.retiredAt === undefined`) to classify active vs retired —
  // every entry must carry the property, present-and-undefined for actives.
  readonly retiredAt?: Date | undefined; // undefined when active
}

/**
 * In-memory key ring with rotation semantics.
 *
 * Phase 1 scope: no persistence, no I/O. Plan-018 Tier 5 will load entries
 * from its storage backend and hand them to the constructor.
 *
 * Constructor invariants (design spec §3.3):
 *   1. At least one entry with `retiredAt: undefined` (active).
 *   2. At most one entry with `retiredAt: undefined`.
 *   Together: exactly one active entry per instance.
 */
export class KeyRing {
  readonly #entries: readonly KeyRingEntry[];

  constructor(entries: readonly KeyRingEntry[]) {
    const active = entries.filter((e) => e.retiredAt === undefined);
    if (active.length === 0) {
      throw new InvalidKeyError("KeyRing requires at least one active entry");
    }
    if (active.length > 1) {
      throw new InvalidKeyError("KeyRing requires at most one active entry");
    }
    // Defensive copy so callers can't mutate our backing array.
    this.#entries = [...entries];
  }

  active(): KeyRingEntry {
    // Invariant guarantees exactly one match.
    return this.#entries.find((e) => e.retiredAt === undefined)!;
  }

  byId(id: string): KeyRingEntry | undefined {
    return this.#entries.find((e) => e.id === id);
  }

  /**
   * Returns a **new** `KeyRing` instance with the prior active entry retired
   * (its `retiredAt` set to the rotation timestamp) and `next` as the new
   * active entry. The pre-rotation instance is unchanged.
   *
   * Callers must reassign the variable holding the `KeyRing` after rotation —
   * `keyRing = keyRing.rotate(next)`. Calling `rotate()` and discarding the
   * return value silently keeps the old key active. See design spec §8.3.
   */
  rotate(next: KeyRingEntry): KeyRing {
    if (next.retiredAt !== undefined) {
      throw new InvalidKeyError("rotate() refuses a `next` that is already retired");
    }
    if (this.#entries.some((e) => e.id === next.id)) {
      throw new InvalidKeyError(`rotate() refuses duplicate entry id: ${next.id}`);
    }
    const now = new Date();
    const retiredPrior = this.#entries.map((e) =>
      e.retiredAt === undefined ? { ...e, retiredAt: now } : e,
    );
    return new KeyRing([...retiredPrior, next]);
  }
}

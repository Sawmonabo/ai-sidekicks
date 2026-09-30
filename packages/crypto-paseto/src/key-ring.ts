import { InvalidKeyError } from "./errors.js";

/** One key in a {@link KeyRing}: a 32-byte key, active while `retiredAt` is undefined. */
export interface KeyRingEntry {
  readonly id: string; // e.g., "k_2026_05"
  readonly key: Uint8Array; // 32 bytes
  readonly createdAt: Date;
  // `| undefined` is needed under `exactOptionalPropertyTypes`, so an active entry can carry the
  // property explicitly.
  readonly retiredAt?: Date | undefined; // undefined when active
}

/**
 * In-memory key ring with rotation; it does no persistence or I/O.
 *
 * The constructor throws `InvalidKeyError` unless there is exactly one active entry, every key is
 * 32 bytes, and ids are unique. Entries are copied on the way in and out, so a caller cannot
 * change the ring's keys or dates.
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
    // Duplicate ids would make `byId()` order-dependent, possibly returning a retired entry for
    // an active id. A key of the wrong length is refused here so it does not fail later, far from
    // the cause, inside `encryptV4Local` / `decryptV4Local`.
    const seenIds = new Set<string>();
    for (const e of entries) {
      if (e.key.length !== 32) {
        throw new InvalidKeyError(
          `KeyRing entry key must be 32 bytes (id: ${e.id}, got ${e.key.length})`,
        );
      }
      if (seenIds.has(e.id)) {
        throw new InvalidKeyError(`KeyRing rejects duplicate entry id: ${e.id}`);
      }
      seenIds.add(e.id);
    }
    // `readonly` does not stop a caller writing to `entry.key[0]` or `entry.createdAt.setTime()`,
    // so entries are deep-cloned here and again in `active()` / `byId()`.
    this.#entries = entries.map((e) => KeyRing.#cloneEntry(e));
  }

  static #cloneEntry(e: KeyRingEntry): KeyRingEntry {
    return {
      id: e.id,
      key: new Uint8Array(e.key),
      createdAt: new Date(e.createdAt.getTime()),
      retiredAt: e.retiredAt === undefined ? undefined : new Date(e.retiredAt.getTime()),
    };
  }

  /** Returns a copy of the one active entry. */
  active(): KeyRingEntry {
    // The constructor guarantees exactly one match.
    return KeyRing.#cloneEntry(this.#entries.find((e) => e.retiredAt === undefined)!);
  }

  /** Returns a copy of the entry with this id, active or retired, or undefined if there is none. */
  byId(id: string): KeyRingEntry | undefined {
    const e = this.#entries.find((entry) => entry.id === id);
    return e === undefined ? undefined : KeyRing.#cloneEntry(e);
  }

  /**
   * Returns a **new** `KeyRing` instance with the prior active entry retired
   * (its `retiredAt` set to the rotation timestamp) and `next` as the new
   * active entry. The pre-rotation instance is unchanged.
   *
   * Callers must reassign the variable holding the `KeyRing` after rotation —
   * `keyRing = keyRing.rotate(next)`. Calling `rotate()` and discarding the
   * return value silently keeps the old key active. Throws `InvalidKeyError` if `next` is
   * already retired or its id is already in the ring.
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

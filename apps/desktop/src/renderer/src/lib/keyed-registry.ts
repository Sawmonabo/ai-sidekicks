// One keyed registry, where the duplicate policy is a parameter because a second registration
// means different things to different registries:
//
//   - `"throw"`: a repeat is a defect. Keeping the last would make behavior depend on import order.
//   - `"idempotent"`: a repeat is expected and a no-op, such as registration that may run twice
//     under a double-mount.
//   - `"owner-scoped"`: a repeat by the same owner replaces; by a different owner it throws.
//
// Insertion order is preserved (`Map` semantics) and several callers depend on it.

import { RefusalError, refuse, type Refusal } from "./refusal/contract.js";

/** The subsystem every registry refusal names as its author. */
const REGISTRY_ORIGIN = "keyed-registry";

/** What a second registration under one key means. Chosen per registry, never per call. */
export type DuplicatePolicy = "throw" | "idempotent" | "owner-scoped";

/** What a {@link KeyedRegistry} is built from. */
export interface KeyedRegistryOptions<Value> {
  readonly duplicatePolicy: DuplicatePolicy;
  /** What the registry holds, in the words a failure message uses: "command", "pane kind". */
  readonly describeWhat: string;
  /** Who owns a value. Required for `"owner-scoped"` and meaningless otherwise. */
  readonly ownerOf?: (value: Value) => string;
  /** A clause appended to a refusal saying why a repeat is a defect in this registry. */
  readonly duplicateHint?: string;
}

/**
 * Raised when a registration is refused. A `RefusalError` because the seams that register
 * already render refusals; `key` is kept beside it because `detail` is prose.
 */
export class DuplicateRegistrationError extends RefusalError {
  public readonly key: string;

  public constructor(refusal: Refusal, key: string) {
    super(refusal);
    this.name = "DuplicateRegistrationError";
    this.key = key;
  }
}

/**
 * A map of keys to values that applies one {@link DuplicatePolicy} to repeat registrations.
 * Refused registrations throw {@link DuplicateRegistrationError}.
 */
export class KeyedRegistry<Key, Value> {
  readonly #valuesByKey = new Map<Key, Value>();
  readonly #duplicatePolicy: DuplicatePolicy;
  readonly #describeWhat: string;
  readonly #ownerOf: ((value: Value) => string) | undefined;
  readonly #duplicateHint: string;

  public constructor(options: KeyedRegistryOptions<Value>) {
    if (options.duplicatePolicy === "owner-scoped" && options.ownerOf === undefined) {
      // Thrown at construction: discovering this at the first conflict would be too late.
      throw new RefusalError(
        refuse(
          REGISTRY_ORIGIN,
          "owner-reader-missing",
          `an owner-scoped ${options.describeWhat} registry needs an ownerOf ` +
            `reader to decide whether a repeat is a replacement or a conflict`,
        ),
      );
    }
    this.#duplicatePolicy = options.duplicatePolicy;
    this.#describeWhat = options.describeWhat;
    this.#ownerOf = options.ownerOf;
    this.#duplicateHint = options.duplicateHint === undefined ? "" : `; ${options.duplicateHint}`;
  }

  /** Register one value, applying the policy. Returns whether the registry changed. */
  public register(key: Key, value: Value): boolean {
    const existing = this.#valuesByKey.get(key);
    if (existing === undefined) {
      this.#valuesByKey.set(key, value);
      return true;
    }
    switch (this.#duplicatePolicy) {
      case "throw":
        throw this.#alreadyRegistered(key);
      case "idempotent":
        return false;
      case "owner-scoped": {
        if (this.#ownerName(existing) !== this.#ownerName(value)) {
          throw this.#ownerConflict(key, existing, value);
        }
        this.#valuesByKey.set(key, value);
        return true;
      }
    }
  }

  /** Register several atomically: every key is checked first, so a refusal stores nothing. */
  public registerAll(entries: readonly (readonly [Key, Value])[]): void {
    const seenInBatch = new Set<Key>();
    for (const [key, value] of entries) {
      if (seenInBatch.has(key)) {
        throw new DuplicateRegistrationError(
          refuse(
            REGISTRY_ORIGIN,
            "duplicate-in-batch",
            `${this.#describeWhat} "${String(key)}" appears twice in one registration batch`,
          ),
          String(key),
        );
      }
      seenInBatch.add(key);
      if (this.#duplicatePolicy === "throw" && this.#valuesByKey.has(key)) {
        throw this.#alreadyRegistered(key);
      }
      if (this.#duplicatePolicy === "owner-scoped") {
        const existing = this.#valuesByKey.get(key);
        if (existing !== undefined && this.#ownerName(existing) !== this.#ownerName(value)) {
          throw this.#ownerConflict(key, existing, value);
        }
      }
    }
    for (const [key, value] of entries) {
      this.#valuesByKey.set(key, value);
    }
  }

  public unregister(key: Key): boolean {
    return this.#valuesByKey.delete(key);
  }

  public get(key: Key): Value | undefined {
    return this.#valuesByKey.get(key);
  }

  public has(key: Key): boolean {
    return this.#valuesByKey.has(key);
  }

  /** Every registered value, in registration order. */
  public all(): readonly Value[] {
    return [...this.#valuesByKey.values()];
  }

  public keys(): readonly Key[] {
    return [...this.#valuesByKey.keys()];
  }

  public get size(): number {
    return this.#valuesByKey.size;
  }

  public clear(): void {
    this.#valuesByKey.clear();
  }

  #alreadyRegistered(key: Key): DuplicateRegistrationError {
    return new DuplicateRegistrationError(
      refuse(
        REGISTRY_ORIGIN,
        "duplicate-registration",
        `${this.#describeWhat} "${String(key)}" is already registered${this.#duplicateHint}`,
      ),
      String(key),
    );
  }

  // The conflict raised when a different owner claims a taken key.

  #ownerConflict(key: Key, existing: Value, incoming: Value): DuplicateRegistrationError {
    return new DuplicateRegistrationError(
      refuse(
        REGISTRY_ORIGIN,
        "owner-conflict",
        `${this.#describeWhat} "${String(key)}" is already registered by ` +
          `${this.#ownerName(existing)}; ${this.#ownerName(incoming)} cannot claim it too`,
      ),
      String(key),
    );
  }

  // `ownerOf` is always present under `"owner-scoped"`; the empty fallback only keeps this total.

  #ownerName(value: Value): string {
    return this.#ownerOf === undefined ? "" : this.#ownerOf(value);
  }
}

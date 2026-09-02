// One keyed registry, and the three answers a registry can give to a duplicate.
//
// The console had five of these: the surface registry (throw unless the same owner
// re-claims), the command registry (throw on any repeat), the main process's route
// registry (silently idempotent), and two array-plus-linear-find tables that are
// byte-for-byte the same idea. Five implementations is not five requirements — it
// is one requirement and four rediscoveries, and they had already diverged on the
// question that actually matters: what a second registration MEANS.
//
// So the policy is a parameter and not a coincidence of which file you landed in:
//
//   • `"throw"` — a repeat is a defect. Two families claiming one command id have a
//     real conflict, and keeping the last would make behaviour depend on module
//     import order.
//   • `"idempotent"` — a repeat is expected and a no-op. Registration that runs
//     once per window but may run twice under a double-mount.
//   • `"owner-scoped"` — a repeat by the SAME owner replaces; by a different owner
//     it throws. The surface registry's rule, and the reason `ownerOf` exists.
//
// Insertion order is preserved (`Map` semantics) and several callers depend on it,
// so nothing here sorts.

import { ConsoleRefusalError, refuse, type ConsoleRefusal } from "./refusal.js";

/** The subsystem every registry refusal names as its author. */
const REGISTRY_ORIGIN = "keyed-registry";

/**
 * The three answers a registry can give to a duplicate, as a tuple.
 *
 * The header above claims there are three, and a claim about a set's size is only
 * checkable once the set is countable at runtime — a union alone is a compile-time
 * shape nothing can walk. `DuplicatePolicy` is derived from this, so the policies a
 * test enumerates and the policies `register` switches over cannot come apart.
 */
export const DUPLICATE_POLICIES = ["throw", "idempotent", "owner-scoped"] as const;

/** What a second registration under one key means. Chosen per registry, never per call. */
export type DuplicatePolicy = (typeof DUPLICATE_POLICIES)[number];

export interface KeyedRegistryOptions<Value> {
  readonly duplicatePolicy: DuplicatePolicy;
  /**
   * What the registry holds, in the words a failure message should use — "command",
   * "surface slot", "scenario". Appears in every error this class raises.
   */
  readonly describeWhat: string;
  /**
   * Who owns a value. REQUIRED for `"owner-scoped"` and meaningless otherwise: the
   * policy is a promise about owners, and a registry that could not name one could
   * not keep it.
   */
  readonly ownerOf?: (value: Value) => string;
  /**
   * One clause appended to a refusal, saying why the repeat is a defect HERE.
   *
   * "already registered" states what happened; a caller reading it wants to know
   * what breaks, and the answer differs per registry. Optional, because a registry
   * whose refusal needs no explanation should not invent one.
   */
  readonly duplicateHint?: string;
}

/**
 * Raised when a registration is refused.
 *
 * A `ConsoleRefusalError` rather than a bare `Error` carrying its own message
 * vocabulary: a registration conflict surfaces at a seam that already renders
 * refusals — the surface registry mounting a family, the palette registering a
 * command — and `code` / `detail` / `origin` is what those three renderings consume.
 * A second shape here would mean translating one at the catch site.
 *
 * `key` stays on the class beside the refusal because `detail` is prose a person
 * reads, and a caller reporting the conflict needs the value it collided on.
 */
export class DuplicateRegistrationError extends ConsoleRefusalError {
  public readonly key: string;

  public constructor(refusal: ConsoleRefusal, key: string) {
    super(refusal);
    this.name = "DuplicateRegistrationError";
    this.key = key;
  }
}

export class KeyedRegistry<Key, Value> {
  readonly #valuesByKey = new Map<Key, Value>();
  readonly #duplicatePolicy: DuplicatePolicy;
  readonly #describeWhat: string;
  readonly #ownerOf: ((value: Value) => string) | undefined;
  readonly #duplicateHint: string;

  public constructor(options: KeyedRegistryOptions<Value>) {
    if (options.duplicatePolicy === "owner-scoped" && options.ownerOf === undefined) {
      // Thrown at construction rather than at the first duplicate, because a
      // registry that discovers it cannot honour its own policy only when a
      // conflict arrives has already admitted the conflicting registration.
      throw new ConsoleRefusalError(
        refuse(
          REGISTRY_ORIGIN,
          "owner-reader-missing",
          `an owner-scoped ${options.describeWhat} registry needs an ownerOf reader to decide whether a repeat is a replacement or a conflict`,
        ),
      );
    }
    this.#duplicatePolicy = options.duplicatePolicy;
    this.#describeWhat = options.describeWhat;
    this.#ownerOf = options.ownerOf;
    this.#duplicateHint = options.duplicateHint === undefined ? "" : `; ${options.duplicateHint}`;
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

  /**
   * The conflict an owner-scoped registry raises when a DIFFERENT owner claims a
   * taken key. One builder rather than two identical literals, because `register`
   * and `registerAll` raised the same conflict from two hand-copied messages.
   */
  #ownerConflict(key: Key, existing: Value, incoming: Value): DuplicateRegistrationError {
    return new DuplicateRegistrationError(
      refuse(
        REGISTRY_ORIGIN,
        "owner-conflict",
        `${this.#describeWhat} "${String(key)}" is already registered by ${this.#ownerName(existing)}; ${this.#ownerName(incoming)} cannot claim it too`,
      ),
      String(key),
    );
  }

  /**
   * Who owns a value. `ownerOf` is present under `"owner-scoped"` — the constructor
   * refuses that policy without one — so the empty fallback is unreachable there and
   * exists only to keep the reader total.
   */
  #ownerName(value: Value): string {
    return this.#ownerOf === undefined ? "" : this.#ownerOf(value);
  }

  /**
   * Register one value, applying the policy.
   *
   * Returns whether the registry changed, so an `"idempotent"` caller can tell a
   * first registration from a repeat without reading the map twice.
   */
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

  /**
   * Register several atomically.
   *
   * Every key is checked before anything is stored, so a duplicate half way
   * through one family's contribution leaves the registry exactly as it was rather
   * than half-populated — a state no caller can reason about and none unwinds.
   */
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
}

/**
 * Read a key that must be present, or throw naming what was missing.
 *
 * The find-or-throw-`RangeError` body appeared four times in this tree, each with
 * its own message wording, so the same missing-key defect read differently
 * depending on which table you hit. One function, one wording.
 *
 * A `RangeError` and deliberately NOT a `ConsoleRefusal`, unlike the duplicate
 * registrations above. A refusal is a value with three renderings and an author a
 * person can read; a key missing from a table the caller itself populated has
 * nowhere to render and nobody to name. It is a defect, and the platform error is
 * what a defect throws.
 */
export function lookupOrThrow<Key, Value>(
  valuesByKey: ReadonlyMap<Key, Value>,
  key: Key,
  describeWhat: string,
): Value {
  const value = valuesByKey.get(key);
  if (value === undefined) {
    throw new RangeError(`no ${describeWhat} named "${String(key)}"`);
  }
  return value;
}

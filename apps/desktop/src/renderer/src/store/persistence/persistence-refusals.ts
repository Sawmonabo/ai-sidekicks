// Why the persistence store refuses, and the one constructor that says so.
//
// The closed refusal vocabulary is declared below every module that raises one (the adapters,
// the identifier grammar, the value-class table and the write chokepoint), so the lowest module
// in `store/persistence/` does not depend on one of its highest. The codes are an `as const`
// array and the union derives from it, so the chokepoint's caller-fault table is checked
// against this list and a new code does not compile until it is classified.

import { refuse, type Refusal } from "@renderer/lib/refusal.js";

/** Why the chokepoint refused a write. Rendered verbatim; never swallowed. */
export const PERSISTENCE_REFUSAL_CODES = [
  "address-not-identifier-shaped",
  "value-class-unknown",
  "value-shape-invalid",
  "value-not-identifier-shaped",
  "value-too-large",
  "adapter-unavailable",
  "quota-exceeded",
] as const;

/** One refusal code. Derived, so the vocabulary is declared exactly once. */
export type PersistenceRefusalCode = (typeof PERSISTENCE_REFUSAL_CODES)[number];

/**
 * The subsystem name every persistence refusal carries, so a refusal surfacing far from where
 * it was raised still names its author.
 */
export const PERSISTENCE_REFUSAL_ORIGIN = "persistence";

/**
 * A typed refusal: the console's one refusal shape (`lib/refusal.ts`), narrowed on `code` to
 * the closed union persistence owns. It satisfies `isRefusal` and renders through the same
 * refusal renderings as every other producer's.
 */
export interface PersistenceRefusal extends Refusal {
  readonly code: PersistenceRefusalCode;
}

/**
 * Builds a persistence refusal. Every refusal from the grammar, the value-class table, the
 * chokepoint and the adapters comes through here, so `origin` is spelled once. Built on
 * `refuse`, whose generic code parameter carries the narrowed vocabulary through.
 */
export function refusePersistence(
  code: PersistenceRefusalCode,
  detail: string,
): PersistenceRefusal {
  return refuse(PERSISTENCE_REFUSAL_ORIGIN, code, detail);
}

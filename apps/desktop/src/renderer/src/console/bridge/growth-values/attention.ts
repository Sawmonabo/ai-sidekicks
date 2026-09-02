// The attention plane's value: one stored preference, read and written through the
// same declaration.
//
// One of the domain modules behind `growth-values/index.ts`. The barrel states the
// rules every value here obeys — why a shape earns a name, what belongs in the
// signature table instead, and what belongs in a module of its own — and publishes
// the whole set. Import from the barrel; this file is the domain's own text.

/**
 * One notification preference, as both the read reply and the update request carry it.
 *
 * `Spec-019 §Interfaces And Contracts` requires the preference pair to "support
 * per-surface preferences", and `Spec-019 §Resolved Questions and V1 Scope Decisions`
 * scopes the store itself to global-per-participant in V1 — so the console's shape is
 * an opaque keyed value rather than an enumeration of surfaces, and stays that way
 * until a document names the keys. Read and update share one declaration because they
 * are the two sides of one record: two copies would let the reply and the request
 * disagree about what a preference IS, which is a disagreement nothing here can catch.
 */
export interface GrowthAttentionPreference {
  readonly key: string;
  readonly value: Readonly<Record<string, unknown>>;
}

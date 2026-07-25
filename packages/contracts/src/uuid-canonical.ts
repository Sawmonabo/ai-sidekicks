// Brand-preserving UUID canonicalization for use as a Map key / hash input.
//
// THE single definition of "canonical UUID form" shared across surfaces:
// today the bootstrap channel-id derivation (`channel-id.ts`) and the
// control-plane presence map (`@ai-sidekicks/control-plane`
// `PresenceRegisterService`) both key off UUID identity, and both route their
// lowercasing through this helper so "canonical" means ONE thing repo-wide.

/**
 * Canonicalize a UUID string to its lowercase hex form, preserving the brand.
 *
 * UUID hex text is case-INSENSITIVE (RFC 9562 §4): `0197F00D-…` and
 * `0197f00d-…` denote the SAME logical UUID. The canonical text
 * representation is lowercase. The branded-UUID schemas in this package
 * (`SessionIdSchema`, `ParticipantIdSchema`, … — all `brandedUuidIdSchema`,
 * i.e. `z.string().uuid()`) accept an uppercase or mixed-case UUID unchanged
 * (the validator performs no normalization) for ordinary version-1–8 UUIDs —
 * but NOT for the Max UUID: Zod 4's versionless `uuid` regex admits the
 * nil/max sentinels only as exact lowercase literals (its general
 * alternate's `[1-8]` version nibble excludes them), so `FFFFFFFF-…` REJECTS
 * while `ffffffff-…` parses. Producers of the Spec-006 daemon-scope
 * anchoring sentinel (the Max UUID) must therefore emit it lowercase — the
 * form this helper outputs. (The nil UUID is all digits; case is vacuous
 * there.) Whenever a UUID is used as a **Map key** or a **hash input**, two
 * case-variants of one logical id must collapse to a single key or they
 * split / lose state — so callers MUST canonicalize first.
 *
 * The generic preserves the caller's brand: `SessionId -> SessionId`,
 * `ParticipantId -> ParticipantId`, plain `string -> string`. The `as T` cast
 * is the single contained unsoundness — `String.prototype.toLowerCase()`
 * returns an unbranded `string`, and lowercasing cannot change which logical
 * id the value denotes, so re-stamping the caller's brand is sound in
 * practice. This helper is the ONE acceptable home for that cast; callers get
 * a brand-correct value with no cast of their own.
 *
 * Scope note: this is the CONTAINED fix for the case-split bug class — it is
 * applied explicitly at each Map-key / hash-input boundary. Folding
 * `.toLowerCase()` into the `brandedUuidIdSchema` factory itself (so every
 * parse normalizes) is a DEFERRED follow-up: branding in this codebase is
 * cast-based (ids are branded by bare `as SessionId` casts at DB-row reads,
 * not by parsing through the schema), so a schema-level transform would not
 * fire on those paths, and it would change a shared primitive whose other
 * cast-site consumers belong to different plans. Until that follow-up lands,
 * canonicalize at the boundary via this helper.
 */
export function canonicalizeUuid<T extends string>(value: T): T {
  return value.toLowerCase() as T;
}

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
 * UUID hex text is case-INSENSITIVE (RFC 9562 section 4): `0197F00D-…` and
 * `0197f00d-…` denote the SAME logical UUID. The canonical text
 * representation is lowercase. The branded-UUID schemas in this package
 * (`SessionIdSchema`, `ParticipantIdSchema`, … — all `brandedUuidIdSchema`)
 * accept an uppercase or mixed-case UUID unchanged, and perform no
 * normalization of their own. That acceptance is **uniform across every
 * alternative of the accept set** — the ordinary version-1–8 forms, the Nil
 * UUID, and the Max UUID alike — because `internal/branded.ts` validates
 * against its own `RFC_9562_TEXT_FORM` predicate carrying the `i` flag.
 *
 * It was not always uniform, and the exception is worth remembering because it
 * shaped a producer obligation: while these schemas delegated to Zod's
 * versionless `uuid` regex, that pattern reached the two sentinels only through
 * EXACT LOWERCASE string literals on a regex with no `i` flag, and its general
 * alternative could not rescue the Max UUID because a `[1-8]` version nibble
 * rejects `f`. So `FFFFFFFF-…` refused while `ffffffff-…` parsed. Producers of
 * daemon-scope anchoring sentinel are no longer OBLIGED to emit it lowercase
 * for the parse to succeed — but they should still emit the canonical lowercase
 * form this helper outputs, for the Map-key reason below rather than for the
 * validator's.
 *
 * Whenever a UUID is used as a **Map key** or a **hash input**, two
 * case-variants of one logical id must collapse to a single key or they
 * split / lose state — so callers MUST canonicalize first. Widening the
 * validator did not weaken that rule; if anything it strengthens it, since one
 * more spelling of the sentinel now reaches these boundaries.
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
 * parse normalizes) is **declined, not deferred**, and the reason is unchanged
 * by the accept-set widening: branding in this codebase is cast-based (ids are
 * branded by bare `as SessionId` casts at DB-row reads, not by parsing through
 * the schema), so a schema-level transform would not fire on those paths — it
 * would leave the case-split alive at exactly the boundaries that matter while
 * appearing to have fixed it, which is worse than not having it. Canonicalize
 * at the boundary via this helper.
 */
export function canonicalizeUuid<T extends string>(value: T): T {
  return value.toLowerCase() as T;
}

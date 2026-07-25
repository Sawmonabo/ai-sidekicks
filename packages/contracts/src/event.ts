// Session event contracts — the canonical event-type census (Plan-006 T1.2),
// the named canonical `EventEnvelopeSchema` carrier (Plan-006 T1.3), plus the
// V1 subset of payload variants of the canonical EventEnvelope shape
// per docs/architecture/contracts/api-payload-contracts.md § Tier 4 Plan-006.
//
// Plan-001 PR #2 ships only the three event types its vertical slice needs:
//   • session.created    — emitted on `SessionCreate` admit
//   • membership.created  — emitted on `SessionJoin` admit
//   • channel.created    — emitted when a session's main channel materializes
//
// The discriminated-union `SessionEvent` discriminates on the wire `type`
// string. Adding a new variant later is additive per ADR-018 §Decision #8
// (new event types allowed under a MINOR version bump). The full taxonomy
// from Spec-006 §Event Type Enumeration is registered below at the post-B18
// census (Plan-006 T1.2, closed by T1.10): `SessionEventType` (156 literals),
// the per-category `*_EVENT_TYPES` arrays, and `SESSION_EVENT_CATEGORY_BY_TYPE`
// (20 categories). Payload variants remain intentionally a strict subset —
// each is owned by its emitting plan and joins `SessionEventSchema` through
// the union-registration seam (CP-009-4 / CP-010-5 / CP-012-2 / CP-016-3
// class) — so census membership is type registration, not payload support.
//
// All three V1 wire strings are registered in Spec-006 §Event Type
// Enumeration: `session.created` and `channel.created` under
// `session_lifecycle`; `membership.created` under `membership_change`
// (registered 2026-05-01 via BL-105 closure). The
// `<category>.<verb>` namespace convention is governed by Spec-006
// §Canonical Serialization Rules; the resource-lifecycle naming
// (`<resource>.created`) parallels `session.created` / `channel.created`
// / `invite.created`.
//
// Versioning: `version` is an `EventEnvelopeVersion` — a semver
// `"MAJOR.MINOR"` STRING per ADR-018 §Decision #1. It is NEVER numeric on
// the wire (lexical compare on strings like "1.10" vs "1.9" is unsafe; the
// reader parses MAJOR/MINOR as integers). The format check below enforces
// the regex from `docs/architecture/contracts/api-payload-contracts.md §Plan-006 — Session Event Taxonomy`.
//
// Refs: Spec-001 §Interfaces, Spec-006 §Event Type Enumeration + §Canonical
// Serialization Rules, ADR-017 (event sourcing), ADR-018 (cross-version
// compatibility).
import { z } from "zod";

import {
  DRIVER_CAPABILITY_FLAGS,
  DRIVER_TOOL_DESCRIPTION_MAX_LEN,
  DRIVER_TOOL_NAME_MAX_LEN,
  IdempotencyClassSchema,
  type DriverCapabilityFlag,
  type NormalizedProviderToolMetadata,
} from "./provider-driver.js";
import {
  CHANNEL_NAME_MAX_LEN,
  ChannelIdSchema,
  IdentityHandleSchema,
  MembershipIdSchema,
  MembershipRoleSchema,
  ParticipantIdSchema,
  SessionIdSchema,
  wireFreeFormString,
  type ChannelId,
  type MembershipId,
  type MembershipRole,
  type ParticipantId,
  type SessionId,
} from "./session.js";

// --------------------------------------------------------------------------
// EventCategory — canonical taxonomy enum.
// --------------------------------------------------------------------------
//
// Mirrors the EventCategory registry in `docs/architecture/contracts/api-payload-contracts.md §Plan-006 — Session Event Taxonomy`
// (20 categories per Spec-006 §Event Type Summary post-B18). Code ships all
// 20: the 16-category V1 set plus `channel_arbitration`,
// `onboarding_lifecycle`, `cross_node_dispatch` (Plan-006 T1.1) and
// `mcp_governance` (Plan-006 T1.10, closing the 2026-07-22 B18 amendment).
// `Spec-006 §Canonical Serialization Rules` specifies that `category` participates in the canonical-bytes
// computation that backs the integrity protocol's BLAKE3 hash chain and
// Ed25519 signature; producers MUST emit the category that matches the type's
// namespace, and consumers MUST NOT silently coerce mismatches. The literal
// `category` per variant in the discriminatedUnion below enforces this on
// the wire — a `{type: "session.created", category: "membership_change"}`
// payload is rejected at parse time, BEFORE it can be hashed under the
// wrong category string and break replay.
//
// ORDER IS NOT LOAD-BEARING — `Spec-006 §Canonical Serialization Rules` specifies RFC 8785 JCS
// canonicalization, which serializes the LITERAL wire string ("session_
// lifecycle", "membership_change", etc.) into the canonical bytes that back
// the BLAKE3 hash chain and Ed25519 signature. The TypeScript enum's
// declaration order does not affect canonical bytes; reordering, inserting,
// or appending categories is byte-equivalent at the integrity layer (it IS
// still a contract bump per ADR-018 §Decision #8: removals are MAJOR,
// additions are MINOR).

export type EventCategory =
  | "run_lifecycle"
  | "assistant_output"
  | "tool_activity"
  | "interactive_request"
  | "artifact_publication"
  | "membership_change"
  | "session_lifecycle"
  | "approval_flow"
  | "usage_telemetry"
  | "runtime_node_lifecycle"
  | "recovery_events"
  | "participant_lifecycle"
  | "audit_integrity"
  | "security_events"
  | "event_maintenance"
  | "policy_events"
  | "channel_arbitration"
  | "onboarding_lifecycle"
  | "cross_node_dispatch"
  | "mcp_governance";
export const EventCategorySchema: z.ZodType<EventCategory> = z.enum([
  "run_lifecycle",
  "assistant_output",
  "tool_activity",
  "interactive_request",
  "artifact_publication",
  "membership_change",
  "session_lifecycle",
  "approval_flow",
  "usage_telemetry",
  "runtime_node_lifecycle",
  "recovery_events",
  "participant_lifecycle",
  "audit_integrity",
  "security_events",
  "event_maintenance",
  "policy_events",
  "channel_arbitration",
  "onboarding_lifecycle",
  "cross_node_dispatch",
  "mcp_governance",
]);

// --------------------------------------------------------------------------
// EventEnvelopeVersion — branded "MAJOR.MINOR" semver string.
// --------------------------------------------------------------------------
//
// Regex from api-payload-contracts.md § Plan-006:
//   /^(0|[1-9]\d*)\.(0|[1-9]\d*)$/
// Rejects leading zeros on either segment ("01.0", "1.01") and pure
// numeric/single-segment forms ("1", "1.0.0").

export const EVENT_ENVELOPE_VERSION_PATTERN: RegExp = /^(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

// Length ceiling for an EventEnvelopeVersion string, enforced at the parse
// boundary BEFORE the format regex. This is a bound on parse cost, not a
// format rule: `compareEventEnvelopeVersion` parses each segment with `BigInt`
// for exact ordering above `Number.MAX_SAFE_INTEGER`, and BigInt construction
// from a decimal string is super-linear in digit count — so an unbounded but
// regex-valid input (a single segment of arbitrarily many digits) would let a
// caller drive parse work without limit. Real protocol versions are
// single/low-double-digit segments per ADR-018 §Decision #1, so 64 characters
// is generous headroom for any plausible MAJOR.MINOR while keeping the BigInt
// parse trivially cheap. This is a strict MAJOR.MINOR protocol-version bound,
// deliberately distinct from `VERSION_STRING_MAX_LEN` (error.ts), which caps
// free-form version strings in error details — the two must not be coupled.
export const EVENT_ENVELOPE_VERSION_MAX_LEN = 64;

export type EventEnvelopeVersion = string & {
  readonly __brand: "EventEnvelopeVersion";
};
/**
 * Runtime validator for the branded {@link EventEnvelopeVersion} — the
 * producer-set `"MAJOR.MINOR"` protocol version whose bump/stub/read rules
 * live in `Spec-006 §EventEnvelope Version Semantics` (format per
 * `ADR-018 §Decision` #1; see the section comment above). An out-of-range
 * version is rejected at the version-floor gate and reader-side version
 * negotiation (never by this format-and-length-only validator) as the
 * shipped typed error contracts `VersionFloorExceededErrorSchema` /
 * `VersionCeilingExceededErrorSchema` (error.ts): below-floor writes
 * return `VERSION_FLOOR_EXCEEDED` per `ADR-018 §Decision` #4; join-time
 * negotiation surfaces both `VERSION_FLOOR_EXCEEDED` and
 * `VERSION_CEILING_EXCEEDED` per §Decision #10, which also mandates their
 * registration ahead of the first Plan-001 emitter — both shipped by
 * Plan-001 T2.3 and cross-linked here, not re-authored.
 */
export const EventEnvelopeVersionSchema: z.ZodType<EventEnvelopeVersion> = z
  .string()
  .max(EVENT_ENVELOPE_VERSION_MAX_LEN, {
    message: `EventEnvelopeVersion must be at most ${EVENT_ENVELOPE_VERSION_MAX_LEN} characters.`,
  })
  .regex(EVENT_ENVELOPE_VERSION_PATTERN, {
    message:
      'EventEnvelopeVersion must be a "MAJOR.MINOR" semver string per ADR-018 §Decision #1 (e.g. "1.0", "2.5"; not numeric, not three-segment, no leading zeros).',
  })
  .brand<"EventEnvelopeVersion">() as unknown as z.ZodType<EventEnvelopeVersion>;

// --------------------------------------------------------------------------
// compareEventEnvelopeVersion — total ordering of EventEnvelopeVersion.
// --------------------------------------------------------------------------
//
// Returns -1 / 0 / 1 (a < b / a == b / a > b) — the standard three-way
// comparator shape (Array.prototype.sort, semver.compare). Callers express the
// predicate at the call site: a below-floor check is
// `compareEventEnvelopeVersion(clientVersion, floor) < 0`.
//
// Lives here (not in a consumer package) because it is the ordering of a
// contracts value type: the control-plane version-floor gate (Plan-003
// T3.3/T3.4) AND the daemon's envelope version negotiation (ADR-018 §6/§7/§10)
// both compare EventEnvelopeVersion values. Contracts is their only shared
// ancestor; a consumer-local helper would force the other consumer to depend
// upward or re-implement the comparison (the lexical "10" < "9" bug, twice).
//
// Numeric MAJOR-then-MINOR tuple compare — deliberately NOT the `semver`
// library: the type is strictly two-segment (EVENT_ENVELOPE_VERSION_PATTERN),
// so semver's coercion / range / prerelease machinery is dead weight and a
// needless dependency.
//
// Inputs are brand-validated EventEnvelopeVersion, so the regex already
// guarantees exactly two non-negative-integer, leading-zero-free segments:
// `split(".")` yields a length-2 array of valid integer literals. The brand IS
// the proof of well-formedness — this function does NOT re-validate (that would
// contradict the brand). The guard against a malformed string lives at the
// PARSE boundary (callers must `EventEnvelopeVersionSchema.parse`, never
// `as`-cast). A caller that defeats the brand with a cast carrying a
// NON-integer segment now THROWS (`SyntaxError` at `BigInt()`) instead of
// silently mis-ordering — a fail-loud, not fail-silent, improvement: a wrong
// answer from the version-floor gate becomes an exception at the boundary
// rather than a covert admit.

export function compareEventEnvelopeVersion(
  a: EventEnvelopeVersion,
  b: EventEnvelopeVersion,
): -1 | 0 | 1 {
  // The `as [bigint, bigint]` is justified by the brand: the regex guarantees
  // exactly two segments, each a valid non-negative integer literal. The schema
  // also bounds input length (EVENT_ENVELOPE_VERSION_MAX_LEN), so the comparator
  // only ever receives a string within that cap. Within that bound, `BigInt`
  // (not `Number`) makes the compare EXACT above `Number.MAX_SAFE_INTEGER` —
  // where a `Number` parse would collapse two distinct large versions to the
  // same float. That exactness is the point: the version floor reads this
  // ordering, so an off-by-a-float result there is a security boundary, not a
  // rounding nit.
  const [aMajor, aMinor] = a.split(".").map(BigInt) as [bigint, bigint];
  const [bMajor, bMinor] = b.split(".").map(BigInt) as [bigint, bigint];
  if (aMajor !== bMajor) return aMajor < bMajor ? -1 : 1;
  if (aMinor !== bMinor) return aMinor < bMinor ? -1 : 1;
  return 0;
}

// --------------------------------------------------------------------------
// Per-field length caps — defense-in-depth bounds on free-form strings.
// --------------------------------------------------------------------------
//
// The HTTP/tRPC framework layer (owned by Plan-004/005) is authoritative on
// total request-body size. These per-field caps live in the contracts package
// as a SECOND line of defense so a future non-HTTP caller (daemon-internal
// IPC, replay machinery, fixtures) can't smuggle a single pathological field
// past the parser. Values are conservative defaults; raising them is a
// contract bump per ADR-018 §Decision #8 (MINOR widening is acceptable —
// shrinking is MAJOR).
//
// Rationale per cap:
//   • EVENT_FIELD_MAX_LEN (256)        — id / actor / correlationId /
//     causationId. UUIDs are 36 chars; 256 leaves plenty of headroom for any
//     composite identifier scheme without enabling DoS. Defined in this file.
//   • ERROR_MESSAGE_MAX_LEN (8192)     — top-level `message` field on error
//     envelopes. 8 KiB is well above any human-readable error string but
//     still bounded. Defined in error.ts (co-located with the error
//     envelope schema that consumes it).
//   • IDENTITY_HANDLE_MAX_LEN (64)     — display handles (Plan-018 owns the
//     canonical grammar; this is a wire-layer ceiling). Defined in session.ts
//     so it can be co-located with `SessionJoinRequestSchema`; the underlying
//     `IdentityHandleSchema` is re-imported here for the membership.created
//     payload so the validation chain stays single-sourced.
//   • CHANNEL_NAME_MAX_LEN (128)       — channel display labels (UI-visible).
//     Defined in session.ts (co-located with `ChannelSummarySchema`); re-
//     imported here for the channel.created payload.
//   • RESOURCE_LABEL_MAX_LEN (128)     — Spec-001 §Resource Limits resource
//     labels (e.g. "concurrent runs per session"). Defined in error.ts.
//
// Free-form string fields (id / actor / correlationId / causationId / message
// / details.resource / identityHandle / channel name) all consume the
// `wireFreeFormString(maxLen, label)` helper from session.ts, which applies
// the length bounds AND a whitespace-only rejection AND a NUL-byte rejection.
// The trust boundary lives at the wire layer because the daemon accepts
// input from external (cross-node, future RPC) callers — producer trust is
// a weaker argument once a non-trusted process can synthesize a wire
// envelope. NUL bytes also corrupt OpenTelemetry trace lines that the
// observability layer emits from `correlationId` / `causationId`.

export const EVENT_FIELD_MAX_LEN = 256;

// --------------------------------------------------------------------------
// EventEnvelope — the canonical event message (Plan-006 T1.3).
// --------------------------------------------------------------------------
//
// The named carrier for every session event, per
// `docs/architecture/contracts/api-payload-contracts.md §Plan-006 — Session Event Taxonomy`
// (the wire authority) and `Spec-006 §Canonical Serialization Rules` (the
// canonical 11-member field set). Two layers share this file, and the split
// is deliberate:
//
//   • ENVELOPE layer (`EventEnvelopeSchema`) — the version-TOLERANT carrier.
//     `type` is a bounded free-form string, NOT the `SessionEventType`
//     census union: MINOR envelope bumps may introduce new event types
//     (`ADR-018 §Decision` #8, additive-only), and a reader MUST persist an
//     envelope whose `type` it cannot interpret as a version stub — never
//     drop or reject it (`ADR-018 §Decision` #5, #9 accept-and-stub;
//     `Spec-006 §EventEnvelope Version Semantics`). A census-typed envelope
//     schema would reject exactly the envelopes the stub path exists to
//     preserve. `payload` is likewise an open record: unknown payload
//     fields from a higher-MINOR producer are preserved verbatim for
//     future upcasting, never stripped.
//   • STRICT layer (`SessionEventSchema` + `SESSION_EVENT_CATEGORY_BY_TYPE`
//     below) — the interpretation surface, where unknown types and
//     category/type mismatches fail loud at parse time.
//
// Bounds on the tolerance, both mirrored from the wire authority:
//   • `category` stays the closed canonical enum (`EventCategorySchema`):
//     the wire authority types it `EventCategory`, `category` participates
//     in the canonical bytes, and a reader with no registry rows for a
//     category cannot route or verify under it — category additions are
//     code-accompanied MINOR contract bumps (see the EventCategory note
//     above), not runtime-tolerated strings.
//   • The TOP-LEVEL member set is CLOSED (`.strict()`):
//     `Spec-006 §Canonical Serialization Rules` fixes membership at exactly
//     the eleven fields below (I-006-1-03), and `pii_payload` is a storage
//     column, deliberately NOT an envelope member. Default Zod stripping
//     would silently desync the parse output from the canonical bytes the
//     integrity protocol hashes and signs; the additive channel for new
//     data is `payload`, never a new envelope member.

/**
 * The canonical event message — every session event travels in this
 * envelope ({@link EventEnvelopeSchema} is the runtime validator).
 *
 * Member set is the canonical eleven of
 * `Spec-006 §Canonical Serialization Rules` (I-006-1-03). Declaration order
 * mirrors the wire authority and is NOT load-bearing: serialized order of
 * the canonical bytes is mandated by RFC 8785 §3.2.3 UTF-16 code-unit
 * lex-sort of member names (the `Spec-006 §Canonical Serialization Rules`
 * amendment) — this declaration documents membership only; Phase 2's
 * canonicalizer owns byte production. Storage mirror: each canonical member
 * maps to a `session_events` column in
 * `local-sqlite-schema.md §Session Events (Plan-001, extended by Plans 006, 015)`,
 * whose column comments mirror this envelope field-by-field (the Plan-006
 * T1.7 bijection; storage-only columns are deliberately non-members).
 */
export interface EventEnvelope {
  // Opaque on the wire — see the `id` note in `buildCommonShape()`.
  id: string;
  sessionId: SessionId;
  // Daemon-assigned, strictly monotonic per session — the canonical replay
  // key per ADR-017.
  sequence: number;
  // ISO 8601. The narrower CANONICAL form (RFC 3339 UTC, ms precision) is
  // enforced at hashing time by Phase 2's normalization, not here.
  occurredAt: string;
  category: EventCategory;
  /**
   * Deliberately `string`, NOT `SessionEventType` — the envelope is the
   * version-tolerant carrier (see the layering note above): a reader must
   * parse an envelope whose `type` it does not know yet in order to
   * persist it as a version stub (`ADR-018 §Decision` #5, #8, #9). Do not
   * "tighten" this member to the census union.
   */
  type: string;
  /**
   * `actor` is `string | null` per
   * `docs/architecture/contracts/api-payload-contracts.md §Plan-006 — Session Event Taxonomy`
   * (participant_id, agent_id, or null for system); the zod schema also
   * makes it optional (key may be absent), so we match the inferred
   * output: `actor?: string | null | undefined`. It is the canonical
   * set's only nullable member — present-null and absent are
   * wire-distinguishable per `Spec-006 §Canonical Serialization Rules`
   * ("fields with value null MUST be included"). Empty string is rejected
   * — a present-but-empty actor is a producer bug (a system event should
   * send `null` or omit the key, not an empty string).
   */
  actor?: string | null | undefined;
  /**
   * Category-specific fields, open by design (higher-MINOR fields are
   * preserved verbatim) — with one carve-out: an own `__proto__` payload
   * key is rejected loud, because Zod's record parser cannot preserve it
   * and silent stripping is forbidden under I-006-1-03's no-collapse
   * rationale (see the pre-guard on {@link EventEnvelopeSchema}). May
   * carry the cross-cutting sourceEpoch + sourcePosition pair; the typed
   * stamp shapes are {@link SourceEpochSchema} / {@link SourcePositionSchema}
   * and the {@link withEpochStamp} composition helper below (Plan-006 T1.9).
   */
  payload: Record<string, unknown>;
  // Optional, NOT nullable (wire authority: `correlationId?: string`) —
  // absent is the correlation pair's only no-value wire state; `actor`
  // alone carries the null-for-system convention.
  correlationId?: string | undefined;
  causationId?: string | undefined;
  /**
   * Producer-set `"MAJOR.MINOR"` semver string, never numeric on the wire
   * (`ADR-018 §Decision` #1): written by the emitting daemon at emit time,
   * never copied from a received event (`ADR-018 §Decision` #2), and never
   * rewritten on read — upcasters transform the in-memory representation
   * at dispatch time only, so the log row's `.version` is part of the
   * event's durable identity (`ADR-018 §Decision` #6;
   * `Spec-006 §EventEnvelope Version Semantics`) (I-006-1-04). The
   * {@link EventEnvelopeVersion} brand keeps unvalidated strings out.
   */
  version: EventEnvelopeVersion;
}

// --------------------------------------------------------------------------
// Common envelope fields shared by EventEnvelopeSchema and every
// SessionEvent variant.
// --------------------------------------------------------------------------
//
// Defined as a shape factory (not a schema) so the envelope schema and each
// variant can spread it — the envelope supplying the tolerant
// `category`/`type`/`payload` trio, each variant supplying its own `type`
// literal, its own literal `category`, and its own `payload`. Per Spec-001
// § Data And Storage Changes the daemon assigns the persisted event id
// (UUID v7 in current daemon code, but the wire contract per
// `docs/architecture/contracts/api-payload-contracts.md §Plan-006 — Session Event Taxonomy` is opaque `id: string`
// — no UUID-format invariant is asserted at the wire layer); `sequence` is
// the canonical replay key per ADR-017.
//
// Note that `category` is NOT in `buildCommonShape()` — the variants need
// it literal-typed per variant so the parser rejects category/type
// mismatches (see Spec-006 §Canonical Serialization Rules), while the
// envelope binds it to the full canonical enum.
//
// The factory pattern is for stylistic consistency: the per-variant schema
// declarations also need to be reproduced in the `discriminatedUnion` block
// below (because `z.ZodType<T>` erases the literal-typed discriminator),
// and reusing the same factory in both places keeps the two surfaces in
// lockstep — divergence would surface as a TypeScript error at the
// `z.ZodType<...Event>` annotation. (Zod 4 check chains are immutable and
// safe to share, so a shared `const` would also be correct; the factory
// just makes accidental drift between the variant schemas and the union
// branch schemas harder.)

const buildCommonShape = () => ({
  // `id`: opaque on the wire (no UUID-format invariant). The daemon assigns
  // UUID v7 internally per Spec-006 (sortable timestamp ordering), but the
  // wire contract per `docs/architecture/contracts/api-payload-contracts.md §Plan-006 — Session Event Taxonomy` is `id: string`. A
  // future spec edit may tighten this to `z.uuid()`; until then, accepting
  // any non-empty bounded string (length cap + whitespace + NUL guards)
  // matches the documented contract.
  id: wireFreeFormString(EVENT_FIELD_MAX_LEN, "EventEnvelope.id"),
  sessionId: SessionIdSchema,
  // `sequence` is a non-negative integer. The daemon assigns a strictly
  // monotonic per-session sequence on append; gaps are an integrity bug.
  sequence: z.number().int().nonnegative(),
  // `occurredAt` is ISO 8601 per `docs/architecture/contracts/api-payload-contracts.md §Plan-006 — Session Event Taxonomy`.
  // `{ offset: true }` widens default Z-only acceptance to include numeric
  // RFC 3339 §5.6 offsets ("+00:00", "-05:00"). The narrower CANONICAL form
  // for the integrity protocol (`Spec-006 §Canonical Serialization Rules` — Z-suffixed UTC, ms
  // precision) is enforced at hashing time by Plan-006's normalization
  // step, NOT at the wire layer here.
  occurredAt: z.iso.datetime({ offset: true }),
  // `actor` is a participant_id, agent_id, or null/absent for system-emitted
  // events (`docs/architecture/contracts/api-payload-contracts.md §Plan-006 — Session Event Taxonomy` — "or null for system").
  // The helper rejects empty/whitespace-only/NUL strings — a system event
  // must use `null` or omit the key, NOT send an empty string. `.nullable()`
  // is composed AFTER the helper so the inner string checks only run on
  // string values (Zod evaluates the wrapped schema only when the value is
  // a string; `null` short-circuits past the chain).
  actor: wireFreeFormString(EVENT_FIELD_MAX_LEN, "EventEnvelope.actor").nullable().optional(),
  correlationId: wireFreeFormString(EVENT_FIELD_MAX_LEN, "EventEnvelope.correlationId").optional(),
  causationId: wireFreeFormString(EVENT_FIELD_MAX_LEN, "EventEnvelope.causationId").optional(),
  version: EventEnvelopeVersionSchema,
});

/**
 * Runtime validator for the canonical {@link EventEnvelope} carrier —
 * declares exactly the canonical 11-field set per
 * `Spec-006 §Canonical Serialization Rules` (I-006-1-03); serialized order
 * is mandated by RFC 8785 §3.2.3 UTF-16 code-unit lex-sort of member names
 * per that section's amendment (this schema fixes MEMBERSHIP; Phase 2's
 * canonicalizer produces the bytes). `version` remains the branded,
 * producer-set {@link EventEnvelopeVersion} — never rewritten on read
 * (`ADR-018 §Decision` #1, #2, #6;
 * `Spec-006 §EventEnvelope Version Semantics`) (I-006-1-04).
 */
export const EventEnvelopeSchema: z.ZodType<EventEnvelope> = z
  .object({
    // id / sessionId / sequence / occurredAt / actor / correlationId /
    // causationId / version — single-sourced with the SessionEvent
    // variants below, so the carrier and the strict layer cannot drift on
    // shared-field validation.
    ...buildCommonShape(),
    category: EventCategorySchema,
    // Bounded free-form, NOT the census union (see the layering note
    // above). Same wire guards as every free-form field — length cap,
    // whitespace-only rejection, NUL rejection; all census literals pass.
    type: wireFreeFormString(EVENT_FIELD_MAX_LEN, "EventEnvelope.type"),
    // Open record behind a raw-input pre-guard: category-specific fields
    // are validated by the strict layer; unknown keys from a higher-MINOR
    // producer are preserved verbatim, never stripped — with ONE carve-out.
    // Zod's record parser unconditionally SKIPS an own `__proto__` input
    // key (anti-pollution hardening), so preserve-verbatim is impossible
    // for that key, and the default outcome would be a silent drop: two
    // distinct wire byte-strings collapsing to one parse output — the
    // exact no-collapse hazard the `.strict()` note below forbids. The
    // pre-guard therefore rejects an own `__proto__` payload key loud.
    // It MUST inspect the raw pre-record value (superRefine BEFORE the
    // .pipe into the record stage): a refine on the record's output can
    // never see the already-dropped key.
    payload: z
      .unknown()
      .superRefine((value, ctx) => {
        if (typeof value === "object" && value !== null && Object.hasOwn(value, "__proto__")) {
          ctx.addIssue({
            code: "custom",
            message:
              "EventEnvelope.payload MUST NOT carry an own __proto__ key — the record parser cannot preserve it, and silent stripping is forbidden (I-006-1-03).",
          });
        }
      })
      .pipe(z.record(z.string(), z.unknown())),
  })
  // Top-level membership is CLOSED even though the carrier is otherwise
  // tolerant — the canonical set is fixed (I-006-1-03), and stripping an
  // unknown member silently would desync parse output from the hashed
  // canonical bytes. `pii_payload` is the named non-member: a storage
  // column, never an envelope field.
  .strict();

// --------------------------------------------------------------------------
// Cross-cutting epoch-attribution carrier (Plan-006 T1.9 — CP-004-12).
// --------------------------------------------------------------------------
//
// `sourceEpoch` + `sourcePosition` are the ONE cross-cutting payload field
// pair in the taxonomy (`Spec-006 §Event Type Enumeration`, registered
// 2026-07-20): a late-appended NON-LIFECYCLE row that the run engine
// attributes to a SUPERSEDED execution epoch carries the pair; a
// current-epoch row carries neither. Absence IS the current-epoch signal —
// the stamp is never fabricated at read time.
//
// PAYLOAD FIELD, NOT AN ENVELOPE FIELD. The pair rides inside `payload`, so
// it sits in the RFC 8785 canonical bytes (signed, hash-chained, shred-safe
// like any payload field) while the canonical envelope member set stays the
// fixed eleven — I-006-1-03 is untouched and NO version bump is taken. That
// no-bump path holds because `ADR-018 §Reversibility Assessment`'s point of
// no return is an EMISSION event, not a code merge: the project is
// pre-first-release with no production deployment, so no `"1.0"` envelope
// has been emitted in a non-test environment — shipped emitter code on
// `develop` (the Plan-003 runtime-node emitter's `RUNTIME_NODE_EVENT_VERSION`)
// does not cross it. The pair is therefore part of the v1.0 baseline payload
// contract from first emit, the same baseline-membership path the earlier
// campaign field registrations rode. Had that point been crossed first, the
// registration would instead take the MINOR envelope bump (`"1.1"`) per
// `ADR-018 §Decision` #8's new-optional-field rule.
//
// WRAP ADMISSION — which payload branches take the stamp. Admission is keyed
// on RUN-SCOPEDNESS (the variant's payload carries `runId`), NOT on family
// membership alone: the late-append window covers the five run-scoped
// families (`assistant_output`, `tool_activity`, `usage_telemetry`,
// `artifact_publication`, and the `interactive_request` CLOSED PAIR
// `driver_ask.requested` + `driver_ask.canceled`), and within them only the
// run-attributed variants admit the pair. The account-plane
// `usage.rate_limit_update` (no `runId` —
// `Spec-006 §Usage Telemetry (usage_telemetry)`) is the named exclusion:
// an epoch stamp on a row with no run identity is unattributable by
// construction. `run_lifecycle` branches never admit it either — a
// lifecycle straggler is ABSORBED, never late-appended.
//
// As of this registration the wrap set is EMPTY BY CONSTRUCTION:
// `SessionEventSchema` carries only the three Plan-001 variants
// (`session.created`, `membership.created`, `channel.created`), none of them
// run-scoped, so no branch here composes the helper yet. Later registrants
// of the five families arriving through the union-registration seam (the
// CP-009-4 / CP-010-5 / CP-012-2 / CP-016-3 class) inherit the admission
// requirement from `Spec-006 §Event Type Enumeration` — a strict payload
// schema that skipped the wrap would REJECT a stamped row at subscription or
// replay validation. __tests__/event-source-epoch.test.ts walks the live
// union and fails when a run-scoped branch of an admitting family lands
// unwrapped, or when any other branch lands wrapped.
//
// OWNERSHIP BOUNDARY — this file owns the TYPED SHAPE only. Execution-epoch
// semantics (`0` is the pre-any-rollback epoch; the epoch advances with each
// ACCEPTED `run.rolled_back` rewind) belong to
// `Spec-004 §Required Behavior` + `Run State Machine §Invariants`; the
// stamp's value source is Plan-004 T3.11's per-event operation association;
// the stamping and consumption invariants are Plan-004's (I-004-14
// late-event absorption, I-004-15 supersede marking).

/**
 * The pre-rollback execution epoch a late-appended non-lifecycle row is
 * attributed to — a nonnegative integer, `0` being the pre-any-rollback
 * epoch (`Spec-004 §Required Behavior` owns the advance semantics; see the
 * ownership boundary above).
 *
 * Spelled as an alias rather than a `z.infer` of the schema below for the
 * same `isolatedDeclarations` reason as {@link EventCategory} /
 * {@link EventEnvelope}: the exported schema needs the explicit
 * `z.ZodType<T>` annotation, so the type must exist first. It is exactly the
 * schema's inferred output.
 */
export type SourceEpoch = number;
export const SourceEpochSchema: z.ZodType<SourceEpoch> = z.number().int().nonnegative();

/**
 * The normalized session position (the turn-boundary vocabulary of
 * Spec-004's `targetPosition`) a stamped row occupies within its source
 * epoch — a nonnegative integer.
 *
 * Registered as the stamp's companion because no run-scoped family's payload
 * carries a native position key, and the supersede cutoff
 * (`turn > targetPosition`) cannot rank a late row against its epoch's
 * surviving prefix without one.
 */
export type SourcePosition = number;
export const SourcePositionSchema: z.ZodType<SourcePosition> = z.number().int().nonnegative();

// The three shared wire literals. Exported as consts — not inlined at each
// use site — because a later rename is forbidden-non-additive
// (`ADR-018 §Decision` #8) and each literal is shared across two plans'
// code: Plan-004 T3.11 stamps the pair at ingestion and T3.14 reads it in
// the supersede projection, while the Plan-006 T3.2 compactor writes the
// resolved originating position into the audit stub under `originPosition`,
// which the Plan-004 T3.12 rewind-span check reads back. The stamp keys are
// the registered payload-field names of
// `Spec-006 §Event Type Enumeration`; `originPosition` is the audit-stub
// PROJECTION key of `Spec-006 §Compacted Event Format` — a stub-projection
// field, never a `session_events` column and never a live payload key.
//
// `as const` rather than a written literal annotation: the literal type stays
// syntactically evident (so `isolatedDeclarations` is satisfied) and the keys
// stay usable as computed property names in the composition helper below.
export const SOURCE_EPOCH_PAYLOAD_KEY = "sourceEpoch" as const;
export const SOURCE_POSITION_PAYLOAD_KEY = "sourcePosition" as const;
export const ORIGIN_POSITION_STUB_KEY = "originPosition" as const;

/**
 * Composes the optional `sourceEpoch` + `sourcePosition` stamp onto a
 * run-scoped payload schema, with the pairing refinement that keeps a
 * half-stamped or unattributable row off the wire.
 *
 * Admission is the caller's decision and is keyed on run-scopedness — see
 * the WRAP ADMISSION note above before wrapping a new branch.
 *
 * Four properties are load-bearing:
 *
 *   • THE PAIR IS DECLARED HERE, ONCE. The generic constraint rejects a
 *     payload shape that already declares `sourceEpoch` or `sourcePosition`,
 *     so a registrant cannot hand-roll the cross-cutting pair alongside the
 *     canonical one — and cannot double-wrap. This is the one admission rule
 *     the compiler enforces; the rest live in the ratchet.
 *   • STRICTNESS SURVIVES. `.extend()` preserves the object's catchall
 *     config, so a composed payload rejects unknown keys exactly as it did
 *     before — composition never widens a payload into accepting arbitrary
 *     keys (the no-collapse stance of I-006-1-03). Strictness is INHERITED,
 *     not imposed: the `$strict` parameter annotation states the
 *     precondition, but Zod's object-config type parameters are
 *     structurally interchangeable, so a caller CAN pass a non-strict
 *     payload and get a non-strict composition back. Wrapping a non-strict
 *     payload is a contract violation the admission ratchet in
 *     __tests__/event-source-epoch.test.ts rejects.
 *   • THE STAMP IS OPTIONAL, AND ABSENCE IS MEANINGFUL. An unstamped
 *     payload stays valid: absence means current-epoch, so a required key
 *     would force producers to fabricate an attribution.
 *   • THE PAIR TRAVELS WITH RUN IDENTITY. Either stamp key present ⇒ BOTH
 *     present AND `runId` PRESENT AND NON-NULL. Epochs and positions are
 *     run-local and the supersede cutoff reads run identity, epoch, and
 *     position together, so a stamp missing any leg is unattributable —
 *     rejected at parse time rather than persisted as an un-rankable row.
 *     Null is rejected alongside absent because a nullable `runId` spells
 *     "no run" in exactly the way absence does; admitting it would let an
 *     un-rankable row through the one check that exists to stop it. Only
 *     those two values are rejected — an empty-string `runId` is the base
 *     schema's business, not the refinement's. The `runId` leg is checked
 *     at RUNTIME (the helper is generic over the payload shape, so it
 *     cannot see the key at compile time): a payload schema with no `runId`
 *     key at all — `usage.rate_limit_update` foremost — therefore rejects
 *     every stamped row, which is the correct outcome for a branch that
 *     should not have been wrapped in the first place.
 */
export function withEpochStamp<
  Shape extends z.core.$ZodShape & { sourceEpoch?: never; sourcePosition?: never },
>(
  payloadSchema: z.ZodObject<Shape, z.core.$strict>,
): z.ZodObject<
  Shape & {
    sourceEpoch: z.ZodOptional<z.ZodType<SourceEpoch>>;
    sourcePosition: z.ZodOptional<z.ZodType<SourcePosition>>;
  },
  z.core.$strict
> {
  // The return cast is justified by Zod's own typing of the two composition
  // steps: `.extend()` returns `ZodObject<util.Extend<Shape, U>, Config>` —
  // Config (here `$strict`) carried through — and `.superRefine()` returns
  // `this`, so the value IS the annotated shape at runtime. What TypeScript
  // cannot do is REDUCE `util.Extend` while `Shape` is generic: it is
  // `Flatten<keyof A & keyof B extends never ? A & B : …>`, and that
  // conditional stays deferred until `keyof Shape` is known, so no
  // relation to the written intersection can be proven here. Note the
  // branch it would take: for a `Shape` that declares NEITHER stamp key —
  // the only shape the constraint admits in practice — `keyof Shape &
  // keyof U` is `never`, making `A & B`, this exact intersection, the arm
  // that fires once `Shape` resolves. So the cast asserts the branch the
  // constraint steers every real caller into; it is not papering over a
  // mismatch. (The constraint is satisfiable by a pathological `Shape` that
  // declares `sourceEpoch?: never` explicitly, which would take the other
  // arm; nothing in the taxonomy spells a payload that way.) Same stance as
  // `EventEnvelopeVersionSchema`'s brand cast above.
  //
  // Residual, for JS callers who bypass the constraint: a colliding base
  // schema that carries any refinement THROWS out of `util.extend`
  // ("Cannot overwrite keys on object schemas containing refinements"),
  // while a check-free colliding base is silently overridden — the spread
  // order puts the canonical stamp schemas last, so they win. Neither path
  // can be reached from TypeScript.
  //
  // Runtime behavior is pinned independently by
  // __tests__/event-source-epoch.test.ts — strictness preserved, stamp
  // optional, pairing enforced.
  return (
    payloadSchema
      // Keyed off the exported consts (not re-typed literals) so the schema
      // keys and the pinned wire names cannot drift apart.
      .extend({
        [SOURCE_EPOCH_PAYLOAD_KEY]: SourceEpochSchema.optional(),
        [SOURCE_POSITION_PAYLOAD_KEY]: SourcePositionSchema.optional(),
      })
      .superRefine((value, ctx) => {
        // Cast justified by the parameter type: `value` is the parsed output
        // of a `.strict()` ZodObject, so it is a plain own-property object.
        // The helper is generic over the payload shape, so the stamp and
        // `runId` keys are only reachable by index here.
        const stamped = value as Record<string, unknown>;
        const hasEpoch = stamped[SOURCE_EPOCH_PAYLOAD_KEY] !== undefined;
        const hasPosition = stamped[SOURCE_POSITION_PAYLOAD_KEY] !== undefined;
        // Unstamped is the current-epoch default, not a violation.
        if (!hasEpoch && !hasPosition) return;
        if (!hasPosition) {
          ctx.addIssue({
            code: "custom",
            path: [SOURCE_POSITION_PAYLOAD_KEY],
            message: `A ${SOURCE_EPOCH_PAYLOAD_KEY} stamp REQUIREs ${SOURCE_POSITION_PAYLOAD_KEY}: the supersede cutoff cannot rank the row against its epoch's surviving prefix without a position.`,
          });
        }
        if (!hasEpoch) {
          ctx.addIssue({
            code: "custom",
            path: [SOURCE_EPOCH_PAYLOAD_KEY],
            message: `A ${SOURCE_POSITION_PAYLOAD_KEY} stamp REQUIREs ${SOURCE_EPOCH_PAYLOAD_KEY}: a position without its epoch names no epoch to supersede against.`,
          });
        }
        // `runId` is the payload-level run-identity key every run-scoped
        // family carries; epochs and positions are run-local, so a stamp
        // without it is unattributable by construction. Explicit
        // `undefined`-or-`null` rather than a truthiness test: `null` is a
        // real "no run" value a nullable payload field can carry and must be
        // rejected, but `!stamped["runId"]` would ALSO reject `""`, and an
        // empty-string runId is the base schema's lane (a `.min(1)` there),
        // not the pairing refinement's. Two `===` clauses rather than
        // `== null` because `eqeqeq` forbids the loose form.
        if (stamped["runId"] === undefined || stamped["runId"] === null) {
          ctx.addIssue({
            code: "custom",
            path: ["runId"],
            message: `A ${SOURCE_EPOCH_PAYLOAD_KEY}/${SOURCE_POSITION_PAYLOAD_KEY} stamp REQUIREs a present, non-null runId: epochs and positions are run-local, so an epoch stamp on a row with no run identity is unattributable.`,
          });
        }
      }) as unknown as z.ZodObject<
      Shape & {
        sourceEpoch: z.ZodOptional<z.ZodType<SourceEpoch>>;
        sourcePosition: z.ZodOptional<z.ZodType<SourcePosition>>;
      },
      z.core.$strict
    >
  );
}

// --------------------------------------------------------------------------
// Per-variant payload schemas — extracted as named consts to deduplicate
// between the standalone `*EventSchema` exports and the discriminated-union
// branch schemas. Same principle as `buildCommonShape()`.
// --------------------------------------------------------------------------

const sessionCreatedPayloadSchema = z
  .object({
    sessionId: SessionIdSchema,
    config: z.record(z.string(), z.unknown()),
    metadata: z.record(z.string(), z.unknown()),
  })
  .strict();

const membershipCreatedPayloadSchema = z
  .object({
    membershipId: MembershipIdSchema,
    participantId: ParticipantIdSchema,
    role: MembershipRoleSchema,
    // `identityHandle` validation is single-sourced via session.ts's
    // `IdentityHandleSchema` so future tightening at one site applies
    // consistently here AND in `SessionJoinRequestSchema`. See session.ts
    // for the rationale (length cap + whitespace + NUL guards; Plan-018
    // owns the canonical handle grammar).
    identityHandle: IdentityHandleSchema,
  })
  .strict();

const channelCreatedPayloadSchema = z
  .object({
    channelId: ChannelIdSchema,
    // `name` is optional; the implicit `main` channel is unnamed on the
    // wire (matches ChannelSummary.name optionality in session.ts). When
    // present, the same `wireFreeFormString` guards apply (length cap +
    // whitespace + NUL rejection) — channel names are user-visible UI
    // labels, same trust-boundary stance as `identityHandle`.
    name: wireFreeFormString(CHANNEL_NAME_MAX_LEN, "channel.created.name").optional(),
  })
  .strict();

// --------------------------------------------------------------------------
// session.created — emitted on session admit.
// --------------------------------------------------------------------------
//
// Payload mirrors the session-bootstrap projection: the new session id
// (redundant with the envelope's `sessionId`, kept for projector convenience)
// plus the resolved config + metadata. The owner participant is conveyed via
// the membership.created event that follows.

// Variant interfaces extend the canonical EventEnvelope, narrowing the
// tolerant `type` / `category` / `payload` members to the variant's
// literals + typed payload. The subtype relation is compile-checked, with
// scoped reach: ADDING or NARROWING an envelope member ripples into every
// variant schema annotation as a type error, while REMOVING one compiles
// clean (ZodType's output parameter is covariant, so a schema emitting an
// extra property stays assignable to the shrunken interface) — the remove
// direction is caught by the 11-key membership pin in the test suite
// instead. Together they are the I-006-1-03 drift guard.
export interface SessionCreatedEvent extends EventEnvelope {
  type: "session.created";
  category: "session_lifecycle";
  payload: {
    sessionId: SessionId;
    config: Record<string, unknown>;
    metadata: Record<string, unknown>;
  };
}
export const SessionCreatedEventSchema: z.ZodType<SessionCreatedEvent> = z
  .object({
    ...buildCommonShape(),
    type: z.literal("session.created"),
    category: z.literal("session_lifecycle"),
    payload: sessionCreatedPayloadSchema,
  })
  .strict();

// --------------------------------------------------------------------------
// membership.created — emitted when a participant is admitted to a session.
// --------------------------------------------------------------------------

export interface MembershipCreatedEvent extends EventEnvelope {
  type: "membership.created";
  category: "membership_change";
  payload: {
    membershipId: MembershipId;
    participantId: ParticipantId;
    role: MembershipRole;
    identityHandle: string;
  };
}
export const MembershipCreatedEventSchema: z.ZodType<MembershipCreatedEvent> = z
  .object({
    ...buildCommonShape(),
    type: z.literal("membership.created"),
    category: z.literal("membership_change"),
    payload: membershipCreatedPayloadSchema,
  })
  .strict();

// --------------------------------------------------------------------------
// channel.created — emitted when a session channel materializes.
// --------------------------------------------------------------------------

export interface ChannelCreatedEvent extends EventEnvelope {
  type: "channel.created";
  category: "session_lifecycle";
  payload: {
    channelId: ChannelId;
    name?: string | undefined;
  };
}
export const ChannelCreatedEventSchema: z.ZodType<ChannelCreatedEvent> = z
  .object({
    ...buildCommonShape(),
    type: z.literal("channel.created"),
    category: z.literal("session_lifecycle"),
    payload: channelCreatedPayloadSchema,
  })
  .strict();

// --------------------------------------------------------------------------
// SessionEvent — discriminated union over `type`.
// --------------------------------------------------------------------------
//
// `z.discriminatedUnion` requires every variant to be a literal-typed
// ZodObject sharing the same discriminator key. This gives O(1) parse-time
// dispatch and narrowed inferred types at the consumption site
// (e.g. `if (e.type === "session.created") e.payload.config // typed`).
//
// We rebuild the variant schemas here (not the exported `*EventSchema`
// values) because `z.ZodType<T>` erases the literal-typed `type` field
// that `discriminatedUnion` needs to discriminate. This duplication is
// load-bearing: it lets the public API surface stay `isolatedDeclarations`-
// friendly while preserving Zod's discriminator dispatch internally.
// Payloads are shared via the named `*PayloadSchema` consts above so
// payload shapes can't drift between the two surfaces.

export type SessionEvent = SessionCreatedEvent | MembershipCreatedEvent | ChannelCreatedEvent;
export const SessionEventSchema: z.ZodType<SessionEvent> = z.discriminatedUnion("type", [
  z
    .object({
      ...buildCommonShape(),
      type: z.literal("session.created"),
      category: z.literal("session_lifecycle"),
      payload: sessionCreatedPayloadSchema,
    })
    .strict(),
  z
    .object({
      ...buildCommonShape(),
      type: z.literal("membership.created"),
      category: z.literal("membership_change"),
      payload: membershipCreatedPayloadSchema,
    })
    .strict(),
  z
    .object({
      ...buildCommonShape(),
      type: z.literal("channel.created"),
      category: z.literal("session_lifecycle"),
      payload: channelCreatedPayloadSchema,
    })
    .strict(),
]);

// --------------------------------------------------------------------------
// SessionEventType — the canonical event-type census (Plan-006 T1.2).
// --------------------------------------------------------------------------
//
// Every wire `type` string from Spec-006 §Event Type Enumeration is
// registered below. The post-B18 census in `Spec-006 §Event Type Summary`
// is 156 types across 20 categories. The fifteen minted by the 2026-07-22
// B18 amendment — three provider-surface `session.*`, three forward,
// non-state `run.*`, three `usage.*`, `user.message`, and the five `mcp.*`
// under the `mcp_governance` category — were registered here by T1.10.
//
// Two Plan-006 §Invariants govern this block:
//   • I-006-1-01 — category/type bijection: every type belongs to exactly
//     one category, `SESSION_EVENT_CATEGORY_BY_TYPE` covers all 156 types,
//     and its values span all 20 shipped categories. The type-level leg is
//     the `satisfies Record<SessionEventType, EventCategory>` totality
//     check below (missing, unknown, or duplicate keys are compile
//     errors); the runtime leg (size === 156, 20 distinct categories,
//     per-category partition) lives in __tests__/session-event.test.ts.
//   • I-006-1-02 — event-type-string immutability: type strings are
//     immutable wire identifiers (`Spec-006 §Canonical Serialization Rules`;
//     ADR-018 §Decision #8 — MINOR bumps are additive-only), so renaming a
//     registered literal is forbidden. The three Plan-001 literals
//     (`session.created`, `membership.created`, `channel.created`) are
//     byte-identical to their Phase-2 registration.
//
// Blocks are grouped by category in `EventCategory` declaration order;
// within a block, types follow Spec-006 §Event Type Enumeration document
// order. Declaration order is NOT load-bearing (RFC 8785 JCS serializes the
// literal strings — see the EventCategory note above); the grouping exists
// so reviewers can reconcile each block against its spec section and
// against the same-ordered per-category arrays + registry entries below.
//
// A type's category is the REGISTRY entry, never the namespace prefix:
// `session.clock_unsynced` / `session.clock_corrected` are
// `runtime_node_lifecycle` (the `session.` prefix is preserved because a
// rename is wire-breaking — Spec-006 §Runtime Node Lifecycle "Name
// preservation"), `daemon.*` are `security_events`, `schema.migrated` is
// `event_maintenance`, `moderation.review_flagged` is `approval_flow`, and
// `orchestration.rejected` is `channel_arbitration`.
export type SessionEventType =
  // run_lifecycle (13) — Spec-006 §Run Lifecycle: the nine Run State
  // Machine states, the B1 forward non-terminal rollback event, and the
  // three B18 forward, non-state rows (T1.10).
  | "run.queued"
  | "run.starting"
  | "run.running"
  | "run.waiting_for_approval"
  | "run.waiting_for_input"
  | "run.paused"
  | "run.completed"
  | "run.interrupted"
  | "run.failed"
  | "run.rolled_back"
  | "run.provider_initialized"
  | "run.turn_started"
  | "run.worker_shutdown"
  // assistant_output (2) — Spec-006 §Assistant Output.
  | "assistant.message"
  | "assistant.thinking_update"
  // tool_activity (7) — Spec-006 §Tool Activity: three live-invocation
  // rows, two Spec-015 recovery rows, two B1 subagent-lifecycle rows.
  | "tool.invoked"
  | "tool.result"
  | "tool.error"
  | "tool.replayed"
  | "tool.skipped_during_recovery"
  | "subagent.started"
  | "subagent.completed"
  // interactive_request (16) — Spec-006 §Queue and Intervention: queue (5)
  // + intervention (6) + B1 driver-ask (4) subfamilies, plus the B18
  // `user.message` row from Spec-006 §User Message Events, registered here
  // by T1.10.
  | "queue_item.created"
  | "queue_item.admitted"
  | "queue_item.superseded"
  | "queue_item.canceled"
  | "queue_item.expired"
  | "intervention.requested"
  | "intervention.accepted"
  | "intervention.applied"
  | "intervention.rejected"
  | "intervention.degraded"
  | "intervention.expired"
  | "driver_ask.requested"
  | "driver_ask.responded"
  | "driver_ask.expired"
  | "driver_ask.canceled"
  | "user.message"
  // artifact_publication (6) — Spec-006 §Artifact and Diff Publication.
  | "artifact.published"
  | "artifact.visibility_updated"
  | "artifact.superseded"
  | "diff.created"
  | "pr.prepared"
  | "pr.submitted"
  // membership_change (13) — Spec-006 §Invite and Membership (9) +
  // §Presence (4).
  | "invite.created"
  | "invite.accepted"
  | "invite.revoked"
  | "invite.expired"
  | "membership.created"
  | "membership.role_changed"
  | "membership.suspended"
  | "membership.revoked"
  | "membership.reactivated"
  | "presence.online"
  | "presence.idle"
  | "presence.reconnecting"
  | "presence.offline"
  // session_lifecycle (31) — Spec-006 §Session Lifecycle (12, incl. the
  // three B18 rows) + §Channel and Agent Lifecycle (7) + §Repo, Workspace,
  // and Worktree Lifecycle (11) + §PTY Control (1).
  | "session.created"
  | "session.activated"
  | "session.archived"
  | "session.reactivated"
  | "session.closed"
  | "session.purge_requested"
  | "session.purged"
  | "session.goal_updated"
  | "session.goal_cleared"
  | "session.provider_status"
  | "session.notice"
  | "session.renamed"
  | "channel.created"
  | "channel.muted"
  | "channel.unmuted"
  | "channel.archived"
  | "agent.attached"
  | "agent.detached"
  | "agent.config_updated"
  | "repo.attached"
  | "repo.detached"
  | "workspace.provisioning"
  | "workspace.ready"
  | "workspace.stale"
  | "workspace.archived"
  | "worktree.created"
  | "worktree.ready"
  | "worktree.dirty"
  | "worktree.merged"
  | "worktree.retired"
  | "pty.control_changed"
  // approval_flow (8) — Spec-006 §Approval Flow (incl. the Tier-6
  // `moderation.review_flagged` registration).
  | "approval.requested"
  | "approval.approved"
  | "approval.rejected"
  | "approval.expired"
  | "approval.canceled"
  | "approval.remembered"
  | "approval.rule_revoked"
  | "moderation.review_flagged"
  // usage_telemetry (8) — Spec-006 §Usage Telemetry: three metered updates
  // + budget warning + account-plane rate-limit snapshot + the three B18
  // rows (T1.10).
  | "usage.token_count"
  | "usage.cost_update"
  | "usage.context_window_update"
  | "usage.budget_warning"
  | "usage.rate_limit_update"
  | "usage.api_retry"
  | "usage.context_compacted"
  | "usage.model_rerouted"
  // runtime_node_lifecycle (9) — Spec-006 §Runtime Node Lifecycle: seven
  // `runtime_node.*` + the two name-preserved `session.clock_*` events.
  | "runtime_node.registered"
  | "runtime_node.online"
  | "runtime_node.degraded"
  | "runtime_node.offline"
  | "runtime_node.revoked"
  | "runtime_node.capability_declared"
  | "runtime_node.capability_updated"
  | "session.clock_unsynced"
  | "session.clock_corrected"
  // recovery_events (3) — Spec-006 §Recovery Events.
  | "recovery.attempted"
  | "recovery.succeeded"
  | "recovery.failed"
  // participant_lifecycle (5) — Spec-006 §Participant Lifecycle.
  | "participant.exported"
  | "participant.purge_requested"
  | "participant.purged"
  | "participant.tokens_revoked_all"
  | "participant.device_reset"
  // audit_integrity (3) — Spec-006 §Audit Integrity. Flat underscore
  // names (no dot namespace), verbatim from the spec.
  | "audit_integrity_verified"
  | "audit_integrity_failed"
  | "key_reuse_detected"
  // security_events (4) — Spec-006 §Security Events (two-dot `security.*`
  // names verbatim from Spec-027; `daemon.*` from Plan-022 D-022-5).
  | "security.default.override"
  | "security.update.available"
  | "daemon.master_key_source"
  | "daemon.pii_split_ambiguous"
  // event_maintenance (3) — Spec-006 §Event Maintenance.
  | "schema.migrated"
  | "event.compacted"
  | "event.shredded"
  // policy_events (2) — Spec-006 §Policy Events.
  | "policy_bundle.loaded"
  | "policy_bundle.rejected"
  // channel_arbitration (3) — Spec-006 §Channel Arbitration.
  | "arbitration.paused"
  | "arbitration.resumed"
  | "orchestration.rejected"
  // onboarding_lifecycle (2) — Spec-006 §Onboarding Lifecycle.
  | "onboarding.choice_made"
  | "onboarding.choice_reset"
  // cross_node_dispatch (13) — Spec-006 §Cross-Node Dispatch.
  | "dispatch.sent"
  | "dispatch.received"
  | "dispatch.rejected"
  | "dispatch.approval_requested"
  | "dispatch.approved"
  | "dispatch.denied"
  | "dispatch.executed"
  | "dispatch.completed"
  | "dispatch.failed"
  | "dispatch.expired"
  | "dispatch.result_buffered"
  | "dispatch.approval_observed"
  | "dispatch.result_observed"
  // mcp_governance (5) — Spec-006 §MCP Governance, the B18 category minted
  // 2026-07-22 as the audit surface of V1 feature #18. Emission, payload
  // semantics, and authorization are Spec-028/Plan-028's; this census owns
  // registration only.
  | "mcp.server_status_changed"
  | "mcp.server_config_changed"
  | "mcp.server_trust_changed"
  | "mcp.tool_override_changed"
  | "mcp.server_oauth_completed";

// The SCHEMA-registered V1 subset — the three types whose payload variants
// are registered in `SessionEventSchema` above — NOT the taxonomy census
// (that is `SESSION_EVENT_CATEGORY_BY_TYPE`, whose keys iterate all 156
// registered types). The `SessionEvent["type"]` element annotation binds
// membership to the schema union at COMPILE time: a census literal without
// a registered payload variant is rejected here (a plain
// `SessionEventType` annotation would admit any of the 156), and the
// admissible set widens automatically as emitting plans land variants
// through the union-registration seam. Exposed as a const tuple so
// consumers can iterate the registered payload variants without re-parsing
// the schemas.
export const SESSION_EVENT_TYPES: readonly SessionEvent["type"][] = [
  "session.created",
  "membership.created",
  "channel.created",
] as const;

// --------------------------------------------------------------------------
// Per-category event-type arrays — the census partitioned by category.
// --------------------------------------------------------------------------
//
// One exported const per `EventCategory` value, named
// `<CATEGORY_IN_SCREAMING_SNAKE>_EVENT_TYPES` so the const name is
// mechanically derivable from the category string (which is why the
// `*_events` categories read `..._EVENTS_EVENT_TYPES`). Each array's member
// set MUST equal `SESSION_EVENT_CATEGORY_BY_TYPE`'s keys filtered to that
// category, and the 20 arrays partition the 156-type census (I-006-1-01) —
// both asserted per-category in __tests__/session-event.test.ts. Explicit
// `readonly SessionEventType[]` annotations keep the exported surface
// `--isolatedDeclarations`-clean, matching `SESSION_EVENT_TYPES` above.

export const RUN_LIFECYCLE_EVENT_TYPES: readonly SessionEventType[] = [
  "run.queued",
  "run.starting",
  "run.running",
  "run.waiting_for_approval",
  "run.waiting_for_input",
  "run.paused",
  "run.completed",
  "run.interrupted",
  "run.failed",
  "run.rolled_back",
  "run.provider_initialized",
  "run.turn_started",
  "run.worker_shutdown",
] as const;

export const ASSISTANT_OUTPUT_EVENT_TYPES: readonly SessionEventType[] = [
  "assistant.message",
  "assistant.thinking_update",
] as const;

export const TOOL_ACTIVITY_EVENT_TYPES: readonly SessionEventType[] = [
  "tool.invoked",
  "tool.result",
  "tool.error",
  "tool.replayed",
  "tool.skipped_during_recovery",
  "subagent.started",
  "subagent.completed",
] as const;

export const INTERACTIVE_REQUEST_EVENT_TYPES: readonly SessionEventType[] = [
  "queue_item.created",
  "queue_item.admitted",
  "queue_item.superseded",
  "queue_item.canceled",
  "queue_item.expired",
  "intervention.requested",
  "intervention.accepted",
  "intervention.applied",
  "intervention.rejected",
  "intervention.degraded",
  "intervention.expired",
  "driver_ask.requested",
  "driver_ask.responded",
  "driver_ask.expired",
  "driver_ask.canceled",
  "user.message",
] as const;

export const ARTIFACT_PUBLICATION_EVENT_TYPES: readonly SessionEventType[] = [
  "artifact.published",
  "artifact.visibility_updated",
  "artifact.superseded",
  "diff.created",
  "pr.prepared",
  "pr.submitted",
] as const;

export const MEMBERSHIP_CHANGE_EVENT_TYPES: readonly SessionEventType[] = [
  "invite.created",
  "invite.accepted",
  "invite.revoked",
  "invite.expired",
  "membership.created",
  "membership.role_changed",
  "membership.suspended",
  "membership.revoked",
  "membership.reactivated",
  "presence.online",
  "presence.idle",
  "presence.reconnecting",
  "presence.offline",
] as const;

// Four Spec-006 subsections flattened in spec order: session (12, incl. the
// three B18 rows), channel/agent (7), repo/workspace/worktree (11), pty (1).
export const SESSION_LIFECYCLE_EVENT_TYPES: readonly SessionEventType[] = [
  "session.created",
  "session.activated",
  "session.archived",
  "session.reactivated",
  "session.closed",
  "session.purge_requested",
  "session.purged",
  "session.goal_updated",
  "session.goal_cleared",
  "session.provider_status",
  "session.notice",
  "session.renamed",
  "channel.created",
  "channel.muted",
  "channel.unmuted",
  "channel.archived",
  "agent.attached",
  "agent.detached",
  "agent.config_updated",
  "repo.attached",
  "repo.detached",
  "workspace.provisioning",
  "workspace.ready",
  "workspace.stale",
  "workspace.archived",
  "worktree.created",
  "worktree.ready",
  "worktree.dirty",
  "worktree.merged",
  "worktree.retired",
  "pty.control_changed",
] as const;

export const APPROVAL_FLOW_EVENT_TYPES: readonly SessionEventType[] = [
  "approval.requested",
  "approval.approved",
  "approval.rejected",
  "approval.expired",
  "approval.canceled",
  "approval.remembered",
  "approval.rule_revoked",
  "moderation.review_flagged",
] as const;

export const USAGE_TELEMETRY_EVENT_TYPES: readonly SessionEventType[] = [
  "usage.token_count",
  "usage.cost_update",
  "usage.context_window_update",
  "usage.budget_warning",
  "usage.rate_limit_update",
  "usage.api_retry",
  "usage.context_compacted",
  "usage.model_rerouted",
] as const;

// Includes the two name-preserved `session.clock_*` events — category
// authority is the registry, not the namespace prefix (see the census
// comment above).
export const RUNTIME_NODE_LIFECYCLE_EVENT_TYPES: readonly SessionEventType[] = [
  "runtime_node.registered",
  "runtime_node.online",
  "runtime_node.degraded",
  "runtime_node.offline",
  "runtime_node.revoked",
  "runtime_node.capability_declared",
  "runtime_node.capability_updated",
  "session.clock_unsynced",
  "session.clock_corrected",
] as const;

export const RECOVERY_EVENTS_EVENT_TYPES: readonly SessionEventType[] = [
  "recovery.attempted",
  "recovery.succeeded",
  "recovery.failed",
] as const;

export const PARTICIPANT_LIFECYCLE_EVENT_TYPES: readonly SessionEventType[] = [
  "participant.exported",
  "participant.purge_requested",
  "participant.purged",
  "participant.tokens_revoked_all",
  "participant.device_reset",
] as const;

export const AUDIT_INTEGRITY_EVENT_TYPES: readonly SessionEventType[] = [
  "audit_integrity_verified",
  "audit_integrity_failed",
  "key_reuse_detected",
] as const;

export const SECURITY_EVENTS_EVENT_TYPES: readonly SessionEventType[] = [
  "security.default.override",
  "security.update.available",
  "daemon.master_key_source",
  "daemon.pii_split_ambiguous",
] as const;

export const EVENT_MAINTENANCE_EVENT_TYPES: readonly SessionEventType[] = [
  "schema.migrated",
  "event.compacted",
  "event.shredded",
] as const;

export const POLICY_EVENTS_EVENT_TYPES: readonly SessionEventType[] = [
  "policy_bundle.loaded",
  "policy_bundle.rejected",
] as const;

export const CHANNEL_ARBITRATION_EVENT_TYPES: readonly SessionEventType[] = [
  "arbitration.paused",
  "arbitration.resumed",
  "orchestration.rejected",
] as const;

export const ONBOARDING_LIFECYCLE_EVENT_TYPES: readonly SessionEventType[] = [
  "onboarding.choice_made",
  "onboarding.choice_reset",
] as const;

export const CROSS_NODE_DISPATCH_EVENT_TYPES: readonly SessionEventType[] = [
  "dispatch.sent",
  "dispatch.received",
  "dispatch.rejected",
  "dispatch.approval_requested",
  "dispatch.approved",
  "dispatch.denied",
  "dispatch.executed",
  "dispatch.completed",
  "dispatch.failed",
  "dispatch.expired",
  "dispatch.result_buffered",
  "dispatch.approval_observed",
  "dispatch.result_observed",
] as const;

// The B18 category (Spec-006 §MCP Governance). Four of the five bind to the
// daemon-scope sentinel; `mcp.server_status_changed` binds per-event — see
// Spec-006 §Daemon-Scope Event Binding And Node-Scope Anchoring.
export const MCP_GOVERNANCE_EVENT_TYPES: readonly SessionEventType[] = [
  "mcp.server_status_changed",
  "mcp.server_config_changed",
  "mcp.server_trust_changed",
  "mcp.tool_override_changed",
  "mcp.server_oauth_completed",
] as const;

// --------------------------------------------------------------------------
// SESSION_EVENT_CATEGORY_BY_TYPE — canonical type → category registry.
// --------------------------------------------------------------------------
//
// Internal Record backing the exported ReadonlyMap. The
// `satisfies Record<SessionEventType, EventCategory>` check is I-006-1-01's
// compile-time totality leg: a union member missing here, an unregistered
// key, or a duplicate key is a compile error, so the registry can never
// silently drift from `SessionEventType`. Entries mirror the union's
// category-block order (same reconciliation affordance; order is not
// load-bearing).
const SESSION_EVENT_CATEGORY_RECORD = {
  // run_lifecycle (13)
  "run.queued": "run_lifecycle",
  "run.starting": "run_lifecycle",
  "run.running": "run_lifecycle",
  "run.waiting_for_approval": "run_lifecycle",
  "run.waiting_for_input": "run_lifecycle",
  "run.paused": "run_lifecycle",
  "run.completed": "run_lifecycle",
  "run.interrupted": "run_lifecycle",
  "run.failed": "run_lifecycle",
  "run.rolled_back": "run_lifecycle",
  "run.provider_initialized": "run_lifecycle",
  "run.turn_started": "run_lifecycle",
  "run.worker_shutdown": "run_lifecycle",
  // assistant_output (2)
  "assistant.message": "assistant_output",
  "assistant.thinking_update": "assistant_output",
  // tool_activity (7)
  "tool.invoked": "tool_activity",
  "tool.result": "tool_activity",
  "tool.error": "tool_activity",
  "tool.replayed": "tool_activity",
  "tool.skipped_during_recovery": "tool_activity",
  "subagent.started": "tool_activity",
  "subagent.completed": "tool_activity",
  // interactive_request (16)
  "queue_item.created": "interactive_request",
  "queue_item.admitted": "interactive_request",
  "queue_item.superseded": "interactive_request",
  "queue_item.canceled": "interactive_request",
  "queue_item.expired": "interactive_request",
  "intervention.requested": "interactive_request",
  "intervention.accepted": "interactive_request",
  "intervention.applied": "interactive_request",
  "intervention.rejected": "interactive_request",
  "intervention.degraded": "interactive_request",
  "intervention.expired": "interactive_request",
  "driver_ask.requested": "interactive_request",
  "driver_ask.responded": "interactive_request",
  "driver_ask.expired": "interactive_request",
  "driver_ask.canceled": "interactive_request",
  "user.message": "interactive_request",
  // artifact_publication (6)
  "artifact.published": "artifact_publication",
  "artifact.visibility_updated": "artifact_publication",
  "artifact.superseded": "artifact_publication",
  "diff.created": "artifact_publication",
  "pr.prepared": "artifact_publication",
  "pr.submitted": "artifact_publication",
  // membership_change (13)
  "invite.created": "membership_change",
  "invite.accepted": "membership_change",
  "invite.revoked": "membership_change",
  "invite.expired": "membership_change",
  "membership.created": "membership_change",
  "membership.role_changed": "membership_change",
  "membership.suspended": "membership_change",
  "membership.revoked": "membership_change",
  "membership.reactivated": "membership_change",
  "presence.online": "membership_change",
  "presence.idle": "membership_change",
  "presence.reconnecting": "membership_change",
  "presence.offline": "membership_change",
  // session_lifecycle (31)
  "session.created": "session_lifecycle",
  "session.activated": "session_lifecycle",
  "session.archived": "session_lifecycle",
  "session.reactivated": "session_lifecycle",
  "session.closed": "session_lifecycle",
  "session.purge_requested": "session_lifecycle",
  "session.purged": "session_lifecycle",
  "session.goal_updated": "session_lifecycle",
  "session.goal_cleared": "session_lifecycle",
  "session.provider_status": "session_lifecycle",
  "session.notice": "session_lifecycle",
  "session.renamed": "session_lifecycle",
  "channel.created": "session_lifecycle",
  "channel.muted": "session_lifecycle",
  "channel.unmuted": "session_lifecycle",
  "channel.archived": "session_lifecycle",
  "agent.attached": "session_lifecycle",
  "agent.detached": "session_lifecycle",
  "agent.config_updated": "session_lifecycle",
  "repo.attached": "session_lifecycle",
  "repo.detached": "session_lifecycle",
  "workspace.provisioning": "session_lifecycle",
  "workspace.ready": "session_lifecycle",
  "workspace.stale": "session_lifecycle",
  "workspace.archived": "session_lifecycle",
  "worktree.created": "session_lifecycle",
  "worktree.ready": "session_lifecycle",
  "worktree.dirty": "session_lifecycle",
  "worktree.merged": "session_lifecycle",
  "worktree.retired": "session_lifecycle",
  "pty.control_changed": "session_lifecycle",
  // approval_flow (8)
  "approval.requested": "approval_flow",
  "approval.approved": "approval_flow",
  "approval.rejected": "approval_flow",
  "approval.expired": "approval_flow",
  "approval.canceled": "approval_flow",
  "approval.remembered": "approval_flow",
  "approval.rule_revoked": "approval_flow",
  "moderation.review_flagged": "approval_flow",
  // usage_telemetry (8)
  "usage.token_count": "usage_telemetry",
  "usage.cost_update": "usage_telemetry",
  "usage.context_window_update": "usage_telemetry",
  "usage.budget_warning": "usage_telemetry",
  "usage.rate_limit_update": "usage_telemetry",
  "usage.api_retry": "usage_telemetry",
  "usage.context_compacted": "usage_telemetry",
  "usage.model_rerouted": "usage_telemetry",
  // runtime_node_lifecycle (9)
  "runtime_node.registered": "runtime_node_lifecycle",
  "runtime_node.online": "runtime_node_lifecycle",
  "runtime_node.degraded": "runtime_node_lifecycle",
  "runtime_node.offline": "runtime_node_lifecycle",
  "runtime_node.revoked": "runtime_node_lifecycle",
  "runtime_node.capability_declared": "runtime_node_lifecycle",
  "runtime_node.capability_updated": "runtime_node_lifecycle",
  "session.clock_unsynced": "runtime_node_lifecycle",
  "session.clock_corrected": "runtime_node_lifecycle",
  // recovery_events (3)
  "recovery.attempted": "recovery_events",
  "recovery.succeeded": "recovery_events",
  "recovery.failed": "recovery_events",
  // participant_lifecycle (5)
  "participant.exported": "participant_lifecycle",
  "participant.purge_requested": "participant_lifecycle",
  "participant.purged": "participant_lifecycle",
  "participant.tokens_revoked_all": "participant_lifecycle",
  "participant.device_reset": "participant_lifecycle",
  // audit_integrity (3)
  audit_integrity_verified: "audit_integrity",
  audit_integrity_failed: "audit_integrity",
  key_reuse_detected: "audit_integrity",
  // security_events (4)
  "security.default.override": "security_events",
  "security.update.available": "security_events",
  "daemon.master_key_source": "security_events",
  "daemon.pii_split_ambiguous": "security_events",
  // event_maintenance (3)
  "schema.migrated": "event_maintenance",
  "event.compacted": "event_maintenance",
  "event.shredded": "event_maintenance",
  // policy_events (2)
  "policy_bundle.loaded": "policy_events",
  "policy_bundle.rejected": "policy_events",
  // channel_arbitration (3)
  "arbitration.paused": "channel_arbitration",
  "arbitration.resumed": "channel_arbitration",
  "orchestration.rejected": "channel_arbitration",
  // onboarding_lifecycle (2)
  "onboarding.choice_made": "onboarding_lifecycle",
  "onboarding.choice_reset": "onboarding_lifecycle",
  // cross_node_dispatch (13)
  "dispatch.sent": "cross_node_dispatch",
  "dispatch.received": "cross_node_dispatch",
  "dispatch.rejected": "cross_node_dispatch",
  "dispatch.approval_requested": "cross_node_dispatch",
  "dispatch.approved": "cross_node_dispatch",
  "dispatch.denied": "cross_node_dispatch",
  "dispatch.executed": "cross_node_dispatch",
  "dispatch.completed": "cross_node_dispatch",
  "dispatch.failed": "cross_node_dispatch",
  "dispatch.expired": "cross_node_dispatch",
  "dispatch.result_buffered": "cross_node_dispatch",
  "dispatch.approval_observed": "cross_node_dispatch",
  "dispatch.result_observed": "cross_node_dispatch",
  // mcp_governance (5)
  "mcp.server_status_changed": "mcp_governance",
  "mcp.server_config_changed": "mcp_governance",
  "mcp.server_trust_changed": "mcp_governance",
  "mcp.tool_override_changed": "mcp_governance",
  "mcp.server_oauth_completed": "mcp_governance",
} satisfies Record<SessionEventType, EventCategory>;

// Map from each registered wire type to its canonical category. Exposed so
// consumers (projectors, replay machinery, integrity verifiers in Plan-006)
// can assert category/type consistency without re-parsing the schema.
//
// `ReadonlyMap` (NOT a plain object literal) so that a downstream caller
// who passes an untrusted string into `.get(evt.type)` cannot accidentally
// resolve a prototype-chain walk:
//   • Object literal: `lookup['__proto__']` returns `[Object: null prototype] {}`
//     and `lookup['constructor']` returns `[Function: Object]` — both
//     truthy, both non-EventCategory values that break downstream string
//     operations.
//   • Map: `lookup.get('__proto__')` and `lookup.get('constructor')` both
//     return `undefined` — the only truthy results are the explicit entries.
// Plan-006 integrity verifiers walk this lookup BEFORE re-parsing through
// `SessionEventSchema`, so the prototype-chain immunity is load-bearing.
// (The backing Record above is module-internal and never looked up — it
// exists solely for the compile-time totality check.)
export const SESSION_EVENT_CATEGORY_BY_TYPE: ReadonlyMap<SessionEventType, EventCategory> = new Map(
  // Cast justified by the `satisfies` check above: the record's own
  // enumerable keys are exactly the 156 SessionEventType literals (totality
  // + excess-property checks), so `Object.entries` narrowing from
  // `[string, ...]` is sound.
  Object.entries(SESSION_EVENT_CATEGORY_RECORD) as ReadonlyArray<[SessionEventType, EventCategory]>,
);

// --------------------------------------------------------------------------
// NormalizedEventKind — surveyed-runtime normalized census + disposition
// registry (Plan-006 T1.8).
// --------------------------------------------------------------------------
//
// The provider drivers (Plan-005) normalize both provider wires into a
// 35-kind normalized event vocabulary BEFORE the taxonomy maps each kind
// onto the `SessionEventType` census. `EVENT_DISPOSITION_BY_KIND` below is
// the machine-readable form of the Plan-006 §Event-Kind Disposition Table
// census rows — the single source of disposition truth the Plan-005
// T3.5/T3.10 normalizers (the B10 bundle) consume. Every kind resolves to
// exactly one disposition under the no-silent-capability-loss default:
// `adopt`/`rename` is the default, and every `correlate`/`discard` carries
// a stated reason, so a capability-bearing kind is never dropped silently.
//
// Registry scope is the 35 CENSUS kinds only. The nine wire-level Claude
// system-channel discards and the current-wire delta families in the same
// plan table are the Plan-005 normalizer's wire layer, NOT registry keys —
// the `worker_shutting_down` delta orphan foremost (the ninth B18 target;
// its literal `run.worker_shutdown` was closed by T1.10's union widening
// alone, with no registry entry). The unknown residual — a wire kind
// outside this census — is backstopped at runtime by the Plan-005
// normalizer's structured default-branch diagnostic (B10), never by this
// registry.
//
// B18 closure (T1.10). Eight census kinds' exact `SessionEventType`
// literals were minted by the 2026-07-22 Spec-006 B18 census amendment
// ahead of their registration in this file, so their entries carried
// `typePending: "B18"` in place of `eventType`. T1.10 registered all
// fifteen B18 literals in the census above and flipped each of the eight
// to its `eventType`, so the two-file shrink-only ratchet that guarded the
// gap is CONSUMED: the pinned pending set is empty and no registry entry
// uses the `typePending` arm.
//
// The arm itself is RETAINED, not removed — it is the reusable mechanism
// for a future census amendment that mints a literal ahead of its
// registration, and __tests__/event-disposition.test.ts keeps compile pins
// on its shape that fire at zero registry instances. What guards
// registry/census agreement from here is the standing bijection pair: the
// `satisfies Record<SessionEventType, EventCategory>` totality check above
// (a census literal cannot go unregistered) plus the both-direction
// set-equality assertions in __tests__/session-event.test.ts, with every
// `eventType` cross-checked against `SESSION_EVENT_CATEGORY_BY_TYPE` in
// the disposition suite (a flip to a category the census disagrees with
// fails there). Registration is not emission license, and all fifteen B18
// literals are variantless today, so the Plan-005 normalizers keep routing
// every flipped kind to the B10 diagnostic until its payload variant is
// registered in `SessionEventSchema` by its owning surface — emission turns
// on variant-by-variant, never on the registry flip alone. Should the arm
// ever be used again, a pending kind routes to that same diagnostic rather
// than constructing an envelope against a missing type — no envelope, no
// silent drop.

// The closed 35-kind normalized census, named per the `EventCategory` /
// `SessionEventType` convention above. Blocks mirror the plan table's
// Group column (14 + 3 + 1 + 6 + 4 + 2 + 1 + 4 = 35); within a block,
// kinds follow table row order. Order is not load-bearing — the grouping
// exists so reviewers can reconcile each block against its table rows.
export type NormalizedEventKind =
  // Inline timeline (14) — rows 1–14.
  | "init"
  | "text_delta"
  | "tool_start"
  | "tool_complete"
  | "turn_start"
  | "turn_complete"
  | "approval_request"
  | "approval_resolved"
  | "user_input_request"
  | "user_input_resolved"
  | "session_status"
  | "token_usage"
  | "error"
  | "todo_update"
  // Task mirror (3) — rows 15–17.
  | "task_create"
  | "task_update"
  | "notification"
  // Transient retry (1) — row 18.
  | "api_retry"
  // System, no timeline row (6) — rows 19–24.
  | "compact_boundary"
  | "rate_limits"
  | "model_rerouted"
  | "thread_renamed"
  | "content_block_start"
  | "content_block_stop"
  // Background/subagent (4) — rows 25–28.
  | "background_task_terminal"
  | "background_task_notification"
  | "subagent_notification"
  | "subagent_status"
  // Codex process/terminal (2) — rows 29–30.
  | "codex_exec_result"
  | "terminal_interaction"
  // Wire echo (1) — row 31.
  | "user_text"
  // Heavy, persisted (4) — rows 32–35.
  | "diff"
  | "command_output"
  | "thinking"
  | "proposed_plan";

// The census as an iterable const tuple (same affordance as the
// per-category `*_EVENT_TYPES` arrays above; same isolatedDeclarations-
// clean annotation). The union keying of `EVENT_DISPOSITION_RECORD` below
// already makes a MISSING kind a compile error; the runtime both-direction
// set-equality check in __tests__/event-disposition.test.ts additionally
// catches a tuple/union drift (this annotation admits any subset of the
// union, so the tuple alone cannot prove completeness at compile time).
export const NORMALIZED_EVENT_KINDS: readonly NormalizedEventKind[] = [
  "init",
  "text_delta",
  "tool_start",
  "tool_complete",
  "turn_start",
  "turn_complete",
  "approval_request",
  "approval_resolved",
  "user_input_request",
  "user_input_resolved",
  "session_status",
  "token_usage",
  "error",
  "todo_update",
  "task_create",
  "task_update",
  "notification",
  "api_retry",
  "compact_boundary",
  "rate_limits",
  "model_rerouted",
  "thread_renamed",
  "content_block_start",
  "content_block_stop",
  "background_task_terminal",
  "background_task_notification",
  "subagent_notification",
  "subagent_status",
  "codex_exec_result",
  "terminal_interaction",
  "user_text",
  "diff",
  "command_output",
  "thinking",
  "proposed_plan",
] as const;

/**
 * One row of the normalized-kind disposition registry — the
 * machine-readable form of a Plan-006 §Event-Kind Disposition Table census
 * row.
 *
 * A discriminated union whose arms make illegal states unrepresentable at
 * the type level (the compiler enforces SHAPE; the Vitest suite verifies
 * census CONTENT):
 *   • `adopt`/`rename` entries name a canonical {@link EventCategory} and
 *     carry EXACTLY ONE of `eventType` — a registered
 *     {@link SessionEventType} census literal — or `typePending: "B18"`
 *     (a literal minted by a census amendment ahead of its registration
 *     here). T1.10 flipped the last eight `typePending` rows, so the
 *     pending arm currently has ZERO registry instances; it is retained as
 *     the mechanism for the next such amendment. The `?: never` keys
 *     forbid both-present; the arm split forbids neither-present.
 *     `eventType` names the row's PRIMARY target only — outcome-dependent
 *     fan-out (`tool.error`, `approval.rejected` / `.expired` /
 *     `.canceled`, `driver_ask.expired` / `.canceled`,
 *     `subagent.completed`) is Plan-005 normalizer detail, not registry
 *     data.
 *   • `correlate`/`discard` entries carry only the non-empty `reason` —
 *     the no-silent-capability-loss justification — and NO taxonomy
 *     target: a correlate folds into an existing row via `correlation_id`
 *     and a discard is consumed transiently, so neither maps onto the
 *     census. `reason` is likewise forbidden on `adopt`/`rename` arms:
 *     its contract role is justifying the two lossy dispositions, and a
 *     taxonomy target needs no justification beyond itself.
 *
 * Every property on every arm is `readonly`: {@link EVENT_DISPOSITION_BY_KIND}
 * hands out module-level shared singletons, and `ReadonlyMap` blocks `.set()`
 * but not property writes on an entry it returned — so without this, one
 * consumer's `entry.category = …` would corrupt disposition truth
 * process-wide.
 */
export type EventKindDisposition =
  | {
      readonly disposition: "adopt" | "rename";
      readonly category: EventCategory;
      readonly eventType: SessionEventType;
      readonly typePending?: never;
      readonly reason?: never;
    }
  | {
      readonly disposition: "adopt" | "rename";
      readonly category: EventCategory;
      readonly typePending: "B18";
      readonly eventType?: never;
      readonly reason?: never;
    }
  | {
      readonly disposition: "correlate";
      readonly reason: string;
      readonly category?: never;
      readonly eventType?: never;
      readonly typePending?: never;
    }
  | {
      readonly disposition: "discard";
      readonly reason: string;
      readonly category?: never;
      readonly eventType?: never;
      readonly typePending?: never;
    };

// Internal Record backing the exported ReadonlyMap — same idiom as
// `SESSION_EVENT_CATEGORY_RECORD` above. The
// `satisfies Record<NormalizedEventKind, EventKindDisposition>` check is
// the compile-time totality leg: a census kind missing here, an
// unregistered key, or a duplicate key is a compile error — and the
// `EventKindDisposition` union arms reject an entry carrying both
// `eventType` and `typePending`, either alongside a `reason`, or a
// correlate/discard smuggling a taxonomy target. Entries mirror the plan
// table's row order (blocks per its Group column; order is not
// load-bearing). Fan-out notes ("fans to …") are Plan-005 T3.5/T3.10
// normalizer detail — the registry names each row's PRIMARY target.
const EVENT_DISPOSITION_RECORD = {
  // Inline timeline (rows 1–14).
  // Run-start marker: records the provider's OWN init report; the daemon's
  // `run.*` state transitions stay daemon-emitted, never provider-init-
  // mapped.
  init: {
    disposition: "adopt",
    category: "run_lifecycle",
    eventType: "run.provider_initialized",
  },
  text_delta: {
    disposition: "adopt",
    category: "assistant_output",
    eventType: "assistant.message",
  },
  tool_start: { disposition: "adopt", category: "tool_activity", eventType: "tool.invoked" },
  // Tool-lifecycle completion; a failure outcome fans to `tool.error`.
  tool_complete: { disposition: "adopt", category: "tool_activity", eventType: "tool.result" },
  // Turn boundary.
  turn_start: { disposition: "adopt", category: "run_lifecycle", eventType: "run.turn_started" },
  // Turn complete; `completionKind` turn-vs-task carve per the B1 taxonomy.
  turn_complete: { disposition: "adopt", category: "run_lifecycle", eventType: "run.completed" },
  // Permission ask.
  approval_request: {
    disposition: "adopt",
    category: "interactive_request",
    eventType: "driver_ask.requested",
  },
  // Approval resolution; fans by outcome to `approval.rejected` /
  // `approval.expired` / `approval.canceled`.
  approval_resolved: {
    disposition: "adopt",
    category: "approval_flow",
    eventType: "approval.approved",
  },
  // Input ask (same driver-ask family as approval_request).
  user_input_request: {
    disposition: "adopt",
    category: "interactive_request",
    eventType: "driver_ask.requested",
  },
  // Driver-ask resolution; fans to `driver_ask.expired` /
  // `driver_ask.canceled`.
  user_input_resolved: {
    disposition: "adopt",
    category: "interactive_request",
    eventType: "driver_ask.responded",
  },
  // Coarse provider status under the B18-pinned no-fabricated-transition
  // rule: provider status observations never drive the nine `session.*`
  // state transitions.
  session_status: {
    disposition: "adopt",
    category: "session_lifecycle",
    eventType: "session.provider_status",
  },
  token_usage: {
    disposition: "adopt",
    category: "usage_telemetry",
    eventType: "usage.token_count",
  },
  // Run-failure envelope.
  error: { disposition: "adopt", category: "run_lifecycle", eventType: "run.failed" },
  // Todo-snapshot projection (TodoWrite-family result row).
  todo_update: { disposition: "adopt", category: "tool_activity", eventType: "tool.result" },
  // Task mirror (rows 15–17): per-task CRUD → per-thread task mirror →
  // `todo_update` snapshots.
  task_create: { disposition: "adopt", category: "tool_activity", eventType: "tool.result" },
  task_update: { disposition: "adopt", category: "tool_activity", eventType: "tool.result" },
  // Generic user-facing notice — the CODEX-FED census kind; the discarded
  // Claude system-channel `notification` subtype is wire-layer, not a
  // registry key.
  notification: {
    disposition: "adopt",
    category: "session_lifecycle",
    eventType: "session.notice",
  },
  // Transient retry (row 18): transient-retry record; the Claude
  // `system.api_retry` typed-error enum (C-5) enriches this same kind —
  // capability-bearing, never dropped.
  api_retry: { disposition: "adopt", category: "usage_telemetry", eventType: "usage.api_retry" },
  // System, no timeline row (rows 19–24).
  // Provider context-window compaction — distinct from the daemon
  // `event.compacted` retention pass.
  compact_boundary: {
    disposition: "adopt",
    category: "usage_telemetry",
    eventType: "usage.context_compacted",
  },
  // The Claude wire string `rate_limit_event` RENAMES onto `rate_limits`:
  // an account-plane quota snapshot, never context-window telemetry.
  rate_limits: {
    disposition: "rename",
    category: "usage_telemetry",
    eventType: "usage.rate_limit_update",
  },
  // Mid-run model-reroute telemetry — capability-bearing.
  model_rerouted: {
    disposition: "adopt",
    category: "usage_telemetry",
    eventType: "usage.model_rerouted",
  },
  // Session/thread rename.
  thread_renamed: {
    disposition: "adopt",
    category: "session_lifecycle",
    eventType: "session.renamed",
  },
  content_block_start: {
    disposition: "discard",
    reason:
      "streaming-structural envelope boundary; the wrapped text_delta kind carries the durable content — no separate timeline or persistence capability",
  },
  content_block_stop: {
    disposition: "discard",
    reason:
      "paired streaming envelope boundary; same streaming-structural reason as content_block_start — the wrapped text_delta kind carries the durable content",
  },
  // Background/subagent (rows 25–28).
  // Richer sibling completion; never replaces the tool-lifecycle
  // completion row.
  background_task_terminal: {
    disposition: "adopt",
    category: "tool_activity",
    eventType: "subagent.completed",
  },
  // Non-lifecycle task notice; may carry a durable output-file path.
  background_task_notification: {
    disposition: "adopt",
    category: "tool_activity",
    eventType: "tool.result",
  },
  // Codex detached-child terminal injected into the parent's next turn.
  subagent_notification: {
    disposition: "adopt",
    category: "tool_activity",
    eventType: "subagent.completed",
  },
  // Subagent-lifecycle row / internal child-thread status; fans to
  // `subagent.completed`.
  subagent_status: {
    disposition: "adopt",
    category: "tool_activity",
    eventType: "subagent.started",
  },
  // Codex process/terminal (rows 29–30).
  // Raw exec-output signal — exited-during-wait vs
  // yielded-with-resumable-session.
  codex_exec_result: { disposition: "adopt", category: "tool_activity", eventType: "tool.result" },
  // Stdin writes to a backgrounded PTY; non-empty stdin redacted from
  // durable metadata.
  terminal_interaction: {
    disposition: "adopt",
    category: "tool_activity",
    eventType: "tool.invoked",
  },
  // Wire echo (row 31).
  user_text: {
    disposition: "correlate",
    reason:
      "correlation-only wire echo — folds into the originating app-sent user-message row via correlation_id (delivery confirmation of the pending send; no new persisted type); correlate target user.message (B18-minted 2026-07-22, registered in this census by T1.10, so the target literal resolves; the echo keeps routing to the Plan-005 normalizer default-branch diagnostic until the Plan-004 T2.9 user.message payload variant joins the union)",
  },
  // Heavy, persisted (rows 32–35): payload persisted to SQLite; light
  // meta to the client.
  diff: { disposition: "adopt", category: "tool_activity", eventType: "tool.result" },
  command_output: { disposition: "adopt", category: "tool_activity", eventType: "tool.result" },
  thinking: {
    disposition: "adopt",
    category: "assistant_output",
    eventType: "assistant.thinking_update",
  },
  // Plan proposal.
  proposed_plan: {
    disposition: "adopt",
    category: "assistant_output",
    eventType: "assistant.message",
  },
} satisfies Record<NormalizedEventKind, EventKindDisposition>;

/**
 * Machine-readable disposition registry over the 35 normalized census
 * kinds — the Plan-006 §Event-Kind Disposition Table as data. The Plan-005
 * T3.5/T3.10 normalizers (the B10 bundle) consume it as the single source
 * of disposition truth; see the section comment above for scope (census
 * kinds only, wire-layer discards and delta families excluded) and the
 * closed-out B18 `typePending` ratchet.
 *
 * `ReadonlyMap` (NOT a plain object) for the same `.get()`-safety as
 * {@link SESSION_EVENT_CATEGORY_BY_TYPE}: a normalizer passing an
 * untrusted wire kind into `.get(kind)` resolves prototype-chain keys
 * (`__proto__`, `constructor`, …) to `undefined`, never a truthy
 * non-disposition value. (The backing Record above is module-internal and
 * never looked up — it exists solely for the compile-time totality check.)
 */
export const EVENT_DISPOSITION_BY_KIND: ReadonlyMap<NormalizedEventKind, EventKindDisposition> =
  new Map(
    // Cast justified by the `satisfies` check above: the record's own
    // enumerable keys are exactly the 35 NormalizedEventKind literals
    // (totality + excess-property checks), so `Object.entries` narrowing
    // from `[string, ...]` is sound.
    Object.entries(EVENT_DISPOSITION_RECORD) as ReadonlyArray<
      [NormalizedEventKind, EventKindDisposition]
    >,
  );

// --------------------------------------------------------------------------
// CapabilityDetails — canonical capability snapshot (Plan-006 T1.4).
// --------------------------------------------------------------------------
//
// The canonical typed shape of the capability snapshot carried on the
// `runtime_node.capability_declared` / `runtime_node.capability_updated`
// event payloads — the two capability rows of
// `Spec-006 §Runtime Node Lifecycle (runtime_node_lifecycle)`; wire authority
// `docs/architecture/contracts/api-payload-contracts.md §Plan-006 — Session Event Taxonomy`.
// Authoring it here closes Plan-005 CP-005-5 via CP-006-5: the Plan-003-
// authored payload schemas in runtime-node.ts EXTEND their interim-opaque
// `capabilityDetails` / `previousState` / `newState` fields with this schema
// as the canonical-first arm of a tolerant union (see the binding notes
// there) — this file owns only the canonical shape, not the payload wrappers.
//
// NON-NORMALIZING end to end — parse output is structurally identical to
// accepted input: no `.default()`, no `.transform()`, no unknown-key
// stripping (`.strict()` at both levels). Load-bearing because the daemon
// emitter persists the PARSED output of the payload schemas
// (node-event-emitter.ts): a default-filling or stripping arm here would
// silently rewrite stored payloads relative to the wire bytes — the same
// no-collapse stance as the envelope's I-006-1-03 notes above.

// Per-field cap for the free-form `contractVersion` string — house
// convention: each free-form wire field owns its own cap. 64 mirrors the
// sibling version-string precedent `RUNTIME_NODE_VERSION_MAX_LEN`
// (runtime-node.ts): generous headroom for any plausible driver-contract
// version string while bounding pathological input at the wire/replay trust
// boundary. Deliberately NOT `EVENT_ENVELOPE_VERSION_MAX_LEN` — that caps
// the strict MAJOR.MINOR protocol version, whereas `contractVersion` is a
// free-form provider-declared value (its semver bound lives at the Plan-005
// Phase-2 write seam, not at this wire layer).
export const CAPABILITY_CONTRACT_VERSION_MAX_LEN = 64;

// Module-LOCAL strict tool schema — single consumer, so it fails the export
// hoist bar (2+ surfaces). Mirrors `NormalizedProviderToolMetadata`
// (provider-driver.ts) EXACTLY, including `description?: string | undefined`
// optionality under `exactOptionalPropertyTypes`. Deliberately NOT
// `ProviderToolMetadataSchema`: that schema is the INGRESS normalizer — it
// default-fills `idempotency_class` and strips unknown keys, so routing
// event payloads through it would make parse output diverge from accepted
// input. Here `idempotency_class` is REQUIRED with no `.default()`: only the
// NORMALIZED tool shape crosses the persistence / event boundary
// (provider-driver.ts), and an un-normalized entry in an event snapshot is a
// producer bug that must fail loud, never be silently repaired.
const capabilityToolMetadataSchema = z
  .object({
    name: wireFreeFormString(DRIVER_TOOL_NAME_MAX_LEN, "CapabilityDetails.tools.name"),
    idempotency_class: IdempotencyClassSchema,
    description: wireFreeFormString(
      DRIVER_TOOL_DESCRIPTION_MAX_LEN,
      "CapabilityDetails.tools.description",
    ).optional(),
  })
  .strict();

// COMPILE-TIME PIN (tool element) — `CapabilityDetailsSchema` rides as the
// canonical arm of the tolerant union in runtime-node.ts, and that union
// never REJECTS a mismatch: a value the canonical arm stops matching silently
// parses on the permissive record arm instead. So schema↔interface drift here
// would de-canonicalize every capability parse without a single test failing
// on shape. The three directions below pin the TOOL-ELEMENT schema (the outer
// `CapabilityDetails` object has its own pin block after its schema, below):
// (1) everything the element schema emits is a
// `NormalizedProviderToolMetadata`; (2) every `NormalizedProviderToolMetadata`
// is an acceptable schema INPUT (a schema that grows a required field breaks
// this); (3) the schema repairs nothing — its input demands no less than the
// normalized shape (a `.default()`/laxer-optionality regression breaks this,
// per the no-silent-repair rule in the schema comment above). Honest residual:
// assignability cannot see `.strict()`'s unknown-key REJECTION, so a dropped
// schema field with `.strict()` retained is runtime-covered by the event.ts
// test suite, not by these pins.
type _AssertExtends<A extends B, B> = A;
type _ToolSchemaOutputIsNormalized = _AssertExtends<
  z.output<typeof capabilityToolMetadataSchema>,
  NormalizedProviderToolMetadata
>;
type _NormalizedIsToolSchemaInput = _AssertExtends<
  NormalizedProviderToolMetadata,
  z.input<typeof capabilityToolMetadataSchema>
>;
type _ToolSchemaInputIsNormalized = _AssertExtends<
  z.input<typeof capabilityToolMetadataSchema>,
  NormalizedProviderToolMetadata
>;

/**
 * Canonical capability snapshot for `runtime_node.capability_*` payloads
 * (`docs/architecture/contracts/api-payload-contracts.md §Plan-006 — Session Event Taxonomy`;
 * `Spec-006 §Runtime Node Lifecycle (runtime_node_lifecycle)`; CP-006-5 —
 * closes Plan-005 CP-005-5). `tools` is `readonly` per the Plan-006 T1.4
 * task row (the governing spelling over the wire doc's mutable gloss — a
 * mutable schema output stays assignable under covariance) and carries the
 * NORMALIZED tool shape: `CapabilityDetails` crosses the persistence /
 * event boundary, which the ingress `ProviderToolMetadata` never does.
 */
export interface CapabilityDetails {
  flags: Record<DriverCapabilityFlag, boolean>;
  contractVersion: string;
  tools: readonly NormalizedProviderToolMetadata[];
}
// Unannotated module-local twin: the exported const below carries an explicit
// `z.ZodType<CapabilityDetails>` annotation (isolatedDeclarations), and that
// annotation REPLACES the inferred object type — `z.input`/`z.output` of the
// export would just echo the annotation, telling the outer-object pins
// nothing. The pins therefore bind this twin, and the export aliases it.
const capabilityDetailsObjectSchema = z
  .object({
    // Enum-keyed record = EXHAUSTIVE keys in Zod 4: every member of the live
    // `DRIVER_CAPABILITY_FLAGS` const must be present, and a missing member,
    // an unknown key, or a non-boolean value all reject — matching the
    // non-partial `Record<DriverCapabilityFlag, boolean>` type and the
    // write-seam exactly-all-flags cardinality guard (I-005-2: capabilities
    // are explicit, never inferred from absence). Keyed off the const — not
    // a copied literal list — so Plan-005 T1.7's scheduled flag widening
    // flows through with zero edits here.
    flags: z.record(z.enum(DRIVER_CAPABILITY_FLAGS), z.boolean()),
    contractVersion: wireFreeFormString(
      CAPABILITY_CONTRACT_VERSION_MAX_LEN,
      "CapabilityDetails.contractVersion",
    ),
    tools: z.array(capabilityToolMetadataSchema),
  })
  .strict();
export const CapabilityDetailsSchema: z.ZodType<CapabilityDetails> = capabilityDetailsObjectSchema;

// COMPILE-TIME PIN (outer object) — same de-canonicalization hazard as the
// tool-element pins above, one level up: the `z.ZodType<CapabilityDetails>`
// annotation does NOT catch a grown required schema field (extra properties
// pass covariant assignability), so without these pins the outer object could
// drift while every parse silently falls to the permissive union arm.
// Directions: (1) everything the schema emits satisfies `CapabilityDetails`
// (a loosened/dropped/mistyped output field breaks this); (2) every
// `CapabilityDetails` is an acceptable schema INPUT (a grown or narrowed
// required field breaks this) — compared with `tools` rebuilt from the
// interface's own readonly array type, because Zod types array inputs as
// mutable and `readonly T[]` never structurally extends `T[]`, while
// PASSING a readonly array is semantically safe (parse copies; it never
// mutates its input); (3) the `tools` key itself stays REQUIRED with the
// pinned element type — this covers the optionality drift that direction
// (2)'s `Omit`-and-rebuild deliberately masks. Honest residual: unchanged
// from the element pins — `.strict()`'s unknown-key rejection is invisible
// to assignability and stays runtime-covered.
type _CapabilityDetailsOutputIsCanonical = _AssertExtends<
  z.output<typeof capabilityDetailsObjectSchema>,
  CapabilityDetails
>;
type _CanonicalIsCapabilityDetailsInput = _AssertExtends<
  CapabilityDetails,
  Omit<z.input<typeof capabilityDetailsObjectSchema>, "tools"> & {
    tools: CapabilityDetails["tools"];
  }
>;
type _CapabilityDetailsInputKeepsRequiredTools = _AssertExtends<
  z.input<typeof capabilityDetailsObjectSchema>["tools"],
  readonly NormalizedProviderToolMetadata[]
>;

// Note: cross-file ID types (`SessionId`, `MembershipId`, …) are not re-
// exported here — they are surfaced from `session.ts` and reach the public
// API via `index.ts`'s `export * from "./session.js"`. Re-exporting them
// from this file too would create a duplicate-export conflict at the
// package barrel.

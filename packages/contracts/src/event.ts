// Session event contracts — the canonical event-type census (Plan-006 T1.2)
// plus the V1 subset of payload variants of the canonical EventEnvelope shape
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
// from Spec-006 §Event Type Enumeration is registered below at the pre-B18
// baseline (Plan-006 T1.2): `SessionEventType` (141 literals), the
// per-category `*_EVENT_TYPES` arrays, and `SESSION_EVENT_CATEGORY_BY_TYPE`
// (19 categories). Payload variants remain intentionally a strict subset —
// each is owned by its emitting plan and joins `SessionEventSchema` through
// the union-registration seam (CP-009-4 / CP-010-5 / CP-012-2 / CP-016-3
// class) — so census membership is type registration, not payload support.
//
// All three V1 wire strings are registered in Spec-006 § Event Type
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
// (20 categories per Spec-006 §Event Type Summary post-B18). Code ships 19:
// the 16-category V1 set plus `channel_arbitration`, `onboarding_lifecycle`,
// `cross_node_dispatch` (Plan-006 T1.1); `mcp_governance` lands in T1.10 (B18).
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
// still a contract bump per ADR-018 §Decision #1: removals are MAJOR,
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
  | "cross_node_dispatch";
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
// contract bump per ADR-018 §Decision #1 (MINOR widening is acceptable —
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
// Common envelope fields shared by every SessionEvent variant.
// --------------------------------------------------------------------------
//
// Defined as a shape factory (not a schema) so each variant can spread it
// while supplying its own `type` literal, its own literal `category`, and
// its own `payload`. Per Spec-001 § Data And Storage Changes the daemon
// assigns the persisted event id (UUID v7 in current daemon code, but the
// wire contract per `docs/architecture/contracts/api-payload-contracts.md §Plan-006 — Session Event Taxonomy` is opaque `id: string`
// — no UUID-format invariant is asserted at the wire layer); `sequence` is
// the canonical replay key per ADR-017.
//
// Note that `category` is NOT in `buildCommonShape()` — it must be a
// literal-typed field per variant so the parser rejects category/type
// mismatches (see Spec-006 §Canonical Serialization Rules).
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

interface SessionEventCommonFields {
  id: string;
  sessionId: SessionId;
  sequence: number;
  occurredAt: string;
  // `actor` is `string | null` per
  // `docs/architecture/contracts/api-payload-contracts.md §Plan-006 — Session Event Taxonomy`
  // (the `EventEnvelope` shape); the zod schema also makes it optional (key may be absent),
  // so we match the inferred output: `actor?: string | null | undefined`.
  // Empty string is rejected — a present-but-empty actor is a producer bug
  // (a system event should send `null` or omit the key, not an empty string).
  actor?: string | null | undefined;
  correlationId?: string | undefined;
  causationId?: string | undefined;
  version: EventEnvelopeVersion;
}

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

export interface SessionCreatedEvent extends SessionEventCommonFields {
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

export interface MembershipCreatedEvent extends SessionEventCommonFields {
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

export interface ChannelCreatedEvent extends SessionEventCommonFields {
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
// All 141 wire `type` strings from Spec-006 §Event Type Enumeration at the
// pre-B18 baseline. `Spec-006 §Event Type Summary` counts 156 types across
// 20 categories post-B18; the fifteen 2026-07-22 B18 literals — three
// provider-surface `session.*`, three forward `run.*`, three `usage.*`,
// `user.message`, and the five `mcp.*` under the `mcp_governance` category
// — land with Plan-006 T1.10, not here.
//
// Two Plan-006 §Invariants govern this block:
//   • I-006-1-01 — category/type bijection: every type belongs to exactly
//     one category, `SESSION_EVENT_CATEGORY_BY_TYPE` covers all 141 types,
//     and its values span all 19 shipped categories. The type-level leg is
//     the `satisfies Record<SessionEventType, EventCategory>` totality
//     check below (missing, unknown, or duplicate keys are compile
//     errors); the runtime leg (size === 141, 19 distinct categories,
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
  // run_lifecycle (10) — Spec-006 §Run Lifecycle: the nine Run State
  // Machine states + the B1 forward, non-terminal rollback event.
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
  // interactive_request (15) — Spec-006 §Queue and Intervention: queue (5)
  // + intervention (6) + B1 driver-ask (4) subfamilies.
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
  // session_lifecycle (28) — Spec-006 §Session Lifecycle (9, pre-B18) +
  // §Channel and Agent Lifecycle (7) + §Repo, Workspace, and Worktree
  // Lifecycle (11) + §PTY Control (1).
  | "session.created"
  | "session.activated"
  | "session.archived"
  | "session.reactivated"
  | "session.closed"
  | "session.purge_requested"
  | "session.purged"
  | "session.goal_updated"
  | "session.goal_cleared"
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
  // usage_telemetry (5) — Spec-006 §Usage Telemetry (pre-B18: three
  // metered updates + budget warning + account-plane rate-limit snapshot).
  | "usage.token_count"
  | "usage.cost_update"
  | "usage.context_window_update"
  | "usage.budget_warning"
  | "usage.rate_limit_update"
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
  | "dispatch.result_observed";

// The SCHEMA-registered V1 subset — the three types whose payload variants
// are registered in `SessionEventSchema` above — NOT the taxonomy census
// (that is `SESSION_EVENT_CATEGORY_BY_TYPE`, whose keys iterate all 141
// registered types). The `SessionEvent["type"]` element annotation binds
// membership to the schema union at COMPILE time: a census literal without
// a registered payload variant is rejected here (a plain
// `SessionEventType` annotation would admit any of the 141), and the
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
// category, and the 19 arrays partition the 141-type census (I-006-1-01) —
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

// Four Spec-006 subsections flattened in spec order: session (9, pre-B18),
// channel/agent (7), repo/workspace/worktree (11), pty (1).
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
  // run_lifecycle (10)
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
  // interactive_request (15)
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
  // session_lifecycle (28)
  "session.created": "session_lifecycle",
  "session.activated": "session_lifecycle",
  "session.archived": "session_lifecycle",
  "session.reactivated": "session_lifecycle",
  "session.closed": "session_lifecycle",
  "session.purge_requested": "session_lifecycle",
  "session.purged": "session_lifecycle",
  "session.goal_updated": "session_lifecycle",
  "session.goal_cleared": "session_lifecycle",
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
  // usage_telemetry (5)
  "usage.token_count": "usage_telemetry",
  "usage.cost_update": "usage_telemetry",
  "usage.context_window_update": "usage_telemetry",
  "usage.budget_warning": "usage_telemetry",
  "usage.rate_limit_update": "usage_telemetry",
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
  // enumerable keys are exactly the 141 SessionEventType literals (totality
  // + excess-property checks), so `Object.entries` narrowing from
  // `[string, ...]` is sound.
  Object.entries(SESSION_EVENT_CATEGORY_RECORD) as ReadonlyArray<[SessionEventType, EventCategory]>,
);

// Note: cross-file ID types (`SessionId`, `MembershipId`, …) are not re-
// exported here — they are surfaced from `session.ts` and reach the public
// API via `index.ts`'s `export * from "./session.js"`. Re-exporting them
// from this file too would create a duplicate-export conflict at the
// package barrel.

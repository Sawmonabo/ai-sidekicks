// Session event contracts — V1 subset of the canonical EventEnvelope shape
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
// lives in Spec-006 §Event Type Enumeration; this file is intentionally a
// strict subset.
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
// the regex from api-payload-contracts.md line 468.
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
// Mirrors api-payload-contracts.md lines 485–502 verbatim (15 categories).
// Spec-006 §523 specifies that `category` participates in the canonical-bytes
// computation that backs the integrity protocol's BLAKE3 hash chain and
// Ed25519 signature; producers MUST emit the category that matches the type's
// namespace, and consumers MUST NOT silently coerce mismatches. The literal
// `category` per variant in the discriminatedUnion below enforces this on
// the wire — a `{type: "session.created", category: "membership_change"}`
// payload is rejected at parse time, BEFORE it can be hashed under the
// wrong category string and break replay.
//
// ORDER IS NOT LOAD-BEARING — Spec-006 §520 specifies RFC 8785 JCS
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
  | "event_maintenance"
  | "policy_events";
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
  "event_maintenance",
  "policy_events",
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

export type EventEnvelopeVersion = string & {
  readonly __brand: "EventEnvelopeVersion";
};
export const EventEnvelopeVersionSchema: z.ZodType<EventEnvelopeVersion> = z
  .string()
  .regex(EVENT_ENVELOPE_VERSION_PATTERN, {
    message:
      'EventEnvelopeVersion must be a "MAJOR.MINOR" semver string per ADR-018 §Decision #1 (e.g. "1.0", "2.5"; not numeric, not three-segment, no leading zeros).',
  })
  .brand<"EventEnvelopeVersion">() as unknown as z.ZodType<EventEnvelopeVersion>;

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
// wire contract per api-payload-contracts.md line 472 is opaque `id: string`
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
  // `actor` is `string | null` per api-payload-contracts.md §EventEnvelope
  // (line 478); the zod schema also makes it optional (key may be absent),
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
  // wire contract per api-payload-contracts.md line 472 is `id: string`. A
  // future spec edit may tighten this to `z.uuid()`; until then, accepting
  // any non-empty bounded string (length cap + whitespace + NUL guards)
  // matches the documented contract.
  id: wireFreeFormString(EVENT_FIELD_MAX_LEN, "EventEnvelope.id"),
  sessionId: SessionIdSchema,
  // `sequence` is a non-negative integer. The daemon assigns a strictly
  // monotonic per-session sequence on append; gaps are an integrity bug.
  sequence: z.number().int().nonnegative(),
  // `occurredAt` is ISO 8601 per api-payload-contracts.md line 475.
  // `{ offset: true }` widens default Z-only acceptance to include numeric
  // RFC 3339 §5.6 offsets ("+00:00", "-05:00"). The narrower CANONICAL form
  // for the integrity protocol (Spec-006 §523-525 — Z-suffixed UTC, ms
  // precision) is enforced at hashing time by Plan-006's normalization
  // step, NOT at the wire layer here.
  occurredAt: z.iso.datetime({ offset: true }),
  // `actor` is a participant_id, agent_id, or null/absent for system-emitted
  // events (api-payload-contracts.md line 478 — "or null for system").
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

// Re-export the wire-type literals as a const tuple so consumers can iterate
// the registered V1 subset without re-parsing the schemas. Matches the
// pattern other contract packages will use as the union grows in later PRs.
export type SessionEventType = "session.created" | "membership.created" | "channel.created";
export const SESSION_EVENT_TYPES: readonly SessionEventType[] = [
  "session.created",
  "membership.created",
  "channel.created",
] as const;

// Map from each registered V1 wire type to its canonical category. Exposed
// so consumers (projectors, replay machinery, integrity verifiers in
// Plan-006) can assert category/type consistency without re-parsing the
// schema.
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
export const SESSION_EVENT_CATEGORY_BY_TYPE: ReadonlyMap<SessionEventType, EventCategory> = new Map(
  [
    ["session.created", "session_lifecycle"],
    ["membership.created", "membership_change"],
    ["channel.created", "session_lifecycle"],
  ],
);

// Note: cross-file ID types (`SessionId`, `MembershipId`, …) are not re-
// exported here — they are surfaced from `session.ts` and reach the public
// API via `index.ts`'s `export * from "./session.js"`. Re-exporting them
// from this file too would create a duplicate-export conflict at the
// package barrel.

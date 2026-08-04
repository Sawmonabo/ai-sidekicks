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
// Plan-009 T1.1 adds six more through the union-registration seam (CP-009-4):
// `repo.attached`, `repo.detached`, and the four `workspace.*` lifecycle
// types, all sharing one payload schema imported from repo.ts.
//
// Plan-010 T1.1 adds the five `worktree.*` lifecycle types through the same
// seam (CP-010-5), carrying the family payload instantiated over Plan-010's
// own `WorktreeStateSchema` and imported from worktree.ts. No
// `worktree.failed` and no ephemeral-clone variants — the Spec-006 registry
// stays closed (Plan-010 D-010-11).
//
// Plan-006 T1.11 adds the six variants Plan-006 emits ITSELF — the three
// `audit_integrity` types and the three `event_maintenance` types. Unlike the
// eleven above they import no payload schema: emitter-authors-payload puts
// them in the emitting plan's file, and Plan-006 owns this one, so their
// payload schemas are declared and exported here.
//
// Plan-006 T1.12 adds the five daemon-reachable `runtime_node.*` variants —
// `registered`, `online`, `offline`, `capability_declared`,
// `capability_updated` — discharging leg (a) of Plan-003 CP-003-1: Plan-003
// authors the payload SHAPES (runtime-node.ts), Plan-006 owns the union
// REGISTRATION. `degraded` / `revoked` stay unregistered — V1.1-gated on the
// node-identity trust anchor (ADR-017 §Server-Derived Runtime-Node Lifecycle
// Events), so the registered set is five of the seven `runtime_node.*` census
// names.
//
// The discriminated-union `SessionEvent` discriminates on the wire `type`
// string. Adding a new variant later is additive per ADR-018 §Decision #8
// (new event types allowed under a MINOR version bump). The full taxonomy
// from Spec-006 §Event Type Enumeration is registered below at the post-B18
// census (Plan-006 T1.2, closed by T1.10): `SessionEventType` (156 literals),
// the per-category `*_EVENT_TYPES` arrays, and `SESSION_EVENT_CATEGORY_BY_TYPE`
// (20 categories). Payload variants remain intentionally a strict subset, and
// each is owned by its EMITTING plan: sixteen reach `SessionEventSchema` from
// another plan's file through the cross-plan union-registration seam (CP-009-4
// / CP-010-5 / CP-003-1, the CP-012-2 / CP-016-3 class), six are authored in
// this file because Plan-006 emits them and owns it (T1.11), and the three
// Plan-001 originals below (`session.created`, `membership.created`,
// `channel.created`) have been authored here since PR #2. In all three cases
// census membership is type registration, not payload support.
//
// All three Plan-001 wire strings are registered in Spec-006 §Event Type
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
// reader parses MAJOR/MINOR as integers). The format check lives on
// `EventEnvelopeVersionSchema` — declared in `./event-core.js`, re-exported
// through the hoist seam below — and enforces the regex from `docs/architecture/contracts/api-payload-contracts.md §Plan-006 — Session Event Taxonomy`.
//
// Refs: Spec-001 §Interfaces, Spec-006 §Event Type Enumeration + §Canonical
// Serialization Rules, ADR-017 (event sourcing), ADR-018 (cross-version
// compatibility).
import { z } from "zod";

// The three symbols this file still CONSUMES from its own hoisted leaf. The
// leaf's other exports reach the public API through the re-export seam below,
// which is a separate statement pair by design (`export … from` introduces no
// local binding, so the two forms never collide — the same shape
// `runtime-node.ts` uses over `./node-id.js`).
import {
  EVENT_FIELD_MAX_LEN,
  EventEnvelopeVersionSchema,
  type EventEnvelopeVersion,
} from "./event-core.js";
// DIRECT import from the `./node-id.js` leaf, never from `./runtime-node.js`
// — the same eager-Zod-cycle discipline repo.ts's header records: the leaf is
// dependency-free, so importing it can never close a module-scope cycle.
import { NodeIdSchema, type NodeId } from "./node-id.js";
import { RepoWorkspaceLifecyclePayloadSchema, type RepoWorkspaceLifecyclePayload } from "./repo.js";
// One-way import (CP-003-1 leg (a), T1.12): the five `runtime_node.*` payload
// schemas Plan-003 authors, registered as union arms below. runtime-node.ts
// imports NOTHING from this file — its three former value imports now come from
// `./event-core.js`, which is what keeps this edge acyclic (see that file's
// header).
import {
  RuntimeNodeCapabilityDeclaredPayloadSchema,
  RuntimeNodeCapabilityUpdatedPayloadSchema,
  RuntimeNodeOfflinePayloadSchema,
  RuntimeNodeOnlinePayloadSchema,
  RuntimeNodeRegisteredPayloadSchema,
  type RuntimeNodeCapabilityDeclaredPayload,
  type RuntimeNodeCapabilityUpdatedPayload,
  type RuntimeNodeOfflinePayload,
  type RuntimeNodeOnlinePayload,
  type RuntimeNodeRegisteredPayload,
} from "./runtime-node.js";
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
// Dependency-free leaf (imports nothing at all), so this edge can close no
// cycle — the `./node-id.js` discipline above. Used for ONE set key; see the
// `key_reuse_detected.observedIdentities` note.
import { canonicalizeUuid } from "./uuid-canonical.js";
// One-way import (CP-010-5): worktree.ts imports nothing from this file —
// same eager-Zod-cycle discipline as the repo.js import above.
import { WorktreeLifecyclePayloadSchema, type WorktreeLifecyclePayload } from "./worktree.js";

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
// HOISTED CLUSTER — RE-EXPORT SEAM (declarations moved to `./event-core.js`).
// --------------------------------------------------------------------------
//
// `EVENT_ENVELOPE_VERSION_PATTERN` / `EVENT_ENVELOPE_VERSION_MAX_LEN` /
// `EventEnvelopeVersion` / `EventEnvelopeVersionSchema`, `EVENT_FIELD_MAX_LEN`,
// `CAPABILITY_CONTRACT_VERSION_MAX_LEN`, and the `CapabilityDetails` pair
// (interface + schema) are declared VERBATIM in `./event-core.js` — a module
// that can reach `zod`, `./session.js` and `./provider-driver.js` and nothing
// else — and re-exported here, so this file's public API is exactly what it was
// before the hoist: the barrel's `export * from "./event.js"` carries all eight
// onward (six values + two types — the two re-export statements below), and
// every in-tree importer (runtime-node.ts's three value imports aside, which
// now bind the leaf directly) keeps importing them from here unchanged.
//
// Plan-006 still OWNS every shape; only their physical home moved. The hoist
// exists because T1.12 registers the five `runtime_node.*` payload variants
// below, which adds a VALUE edge from this file to `runtime-node.ts` — and
// `runtime-node.ts` already read three values back out of this one, closing the
// eager cycle `event.ts` → `runtime-node.ts` → `event.ts` that throws
// `ReferenceError` at import time from every entry point (full rationale, with
// the per-edge evidence, in `./event-core.js`'s header). Amending any of these
// eight is still a Plan-006 edit — make it in `./event-core.js`.
//
// Type-only re-exports MUST use `export type { ... }` (the `isolatedModules` +
// `verbatimModuleSyntax` posture from tsconfig.base.json forbids erased
// re-exports on the runtime form) — the same two-statement shape
// `runtime-node.ts` uses for its `./node-id.js` re-exports.
export type { CapabilityDetails, EventEnvelopeVersion } from "./event-core.js";
export {
  CAPABILITY_CONTRACT_VERSION_MAX_LEN,
  CapabilityDetailsSchema,
  EVENT_ENVELOPE_VERSION_MAX_LEN,
  EVENT_ENVELOPE_VERSION_PATTERN,
  EVENT_FIELD_MAX_LEN,
  EventEnvelopeVersionSchema,
} from "./event-core.js";

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
//     composite identifier scheme without enabling DoS. Declared in
//     event-core.ts — `runtime-node.ts` reads it at module scope, so it rides
//     the hoisted leaf; the seam above re-exports it from this file.
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

// --------------------------------------------------------------------------
// Sequence ceiling — a hash-collision guard, NOT a policy knob.
// --------------------------------------------------------------------------
//
// The largest `sequence` an envelope may carry: accepted at exactly this
// value, refused one above it.
//
// WHY THE BOUND EXISTS — it is an INJECTIVITY requirement of the integrity
// protocol, not a capacity estimate. `sequence` is contracted as an integer
// but travels as an IEEE-754 binary64 double, which represents integers
// faithfully only up to 2^53 − 1. Above that, DISTINCT integers collapse onto
// the SAME double — `9007199254740992 === 9007199254740993` evaluates to
// `true` in ECMAScript. Two genuinely different events would then canonicalize
// to IDENTICAL RFC 8785 bytes, produce an identical `row_hash`, and collide in
// the tamper-evidence chain `Spec-006 §Integrity Protocol` builds. Nothing
// downstream can detect that: by the time the canonicalizer sees the value,
// the two inputs ARE the same number, and RFC 8785 faithfully serializes the
// collapsed one. Faithful representation of `sequence` is therefore a
// PRECONDITION of the hash chain being injective — which is the entire
// property the chain exists to provide.
//
// WHY IT IS NAMED rather than left implicit: Zod's `.int()` already bounds the
// safe-integer range, so the parse boundary rejected out-of-range values
// before this const existed — but only as an INCIDENTAL side effect of the
// integer check, reported as a bare "too big", and invisible to anyone reading
// the schema. An intentional bound produces an intentional error and documents
// itself. Enforcement outside the parse boundary is the canonicalizer's, in
// `packages/runtime-daemon/src/events/canonicalizer.ts` — an in-process caller
// that constructs an envelope without parsing reaches the hash chain without
// ever meeting this schema.
//
// NOT A TUNABLE — and this is the one thing a future reader must not get
// wrong. Every other cap this file surfaces (`EVENT_FIELD_MAX_LEN`,
// `EVENT_ENVELOPE_VERSION_MAX_LEN` — both declared on the `./event-core.js`
// leaf and re-exported through the seam above) is a policy knob chosen for
// headroom, raisable as a MINOR widening. This one is not raisable at all: it
// is pinned to a property of the number REPRESENTATION, `.int()` enforces the
// identical ceiling independently so raising this const alone would change
// nothing, and past it the canonical bytes stop being injective. A reader who
// finds the limit inconvenient needs a WIDER WIRE TYPE — a string-encoded
// bigint, the same remedy `pty-host-protocol.ts`'s `DataFrame.seq` note
// reserves against the same hazard — never a larger number here.
//
// Headroom is not the binding constraint regardless: at a sustained one
// million events per second, one session needs ~285 years to reach this
// ceiling.
export const EVENT_ENVELOPE_SEQUENCE_MAX: number = Number.MAX_SAFE_INTEGER;

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
  // key per ADR-017. Bounded above by {@link EVENT_ENVELOPE_SEQUENCE_MAX}:
  // past that value distinct sequences collapse onto one IEEE-754 double and
  // the canonical bytes stop being injective, so two different events could
  // share a `row_hash`. See that const's section comment — the ceiling is a
  // hash-collision guard, not an arbitrary limit, and is not raisable.
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
  //
  // The `.max()` is REDUNDANT with the safe-integer ceiling `.int()` already
  // applies, and that redundancy is the point. It shifts NO accept/reject
  // decision — every value admitted before is admitted now, every value
  // refused before is still refused — so it is not an ADR-018 contract
  // narrowing and needs no MINOR bump. What it changes is the DIAGNOSIS: an
  // over-range `sequence` now reports why the ceiling exists instead of a bare
  // "too big" that reads like an arbitrary limit. See
  // {@link EVENT_ENVELOPE_SEQUENCE_MAX}. (`.int({ error })` would have carried
  // the same message on one check, but Zod applies a check-level `error` to
  // every issue that check raises — including the `invalid_type` a
  // non-integer like `1.5` triggers — so a fractional sequence would be
  // misreported as an overflow. Two checks, two honest messages.)
  sequence: z
    .number()
    .int()
    .nonnegative()
    .max(EVENT_ENVELOPE_SEQUENCE_MAX, {
      message: `sequence must be at most ${EVENT_ENVELOPE_SEQUENCE_MAX} (Number.MAX_SAFE_INTEGER): above it distinct sequences collapse onto the same IEEE-754 double, so two different events would canonicalize to identical RFC 8785 bytes and collide in the row_hash chain.`,
    }),
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
// The wrap set is still EMPTY BY CONSTRUCTION — now on two grounds, not one.
// `SessionEventSchema` carries the three Plan-001 variants
// (`session.created`, `membership.created`, `channel.created`), the six
// Plan-009 `repo.*` / `workspace.*` variants (CP-009-4), the five Plan-010
// `worktree.*` variants (CP-010-5), the six Plan-006 `audit_integrity` /
// `event_maintenance` variants (T1.11), and the five Plan-003 `runtime_node.*`
// variants (T1.12 — CP-003-1 leg (a)). The first fourteen are LIFECYCLE
// rows; the six T1.11 registrants are DAEMON-SCOPE infrastructure rows fired
// at process scope across every hosted session
// (`Spec-006 §Daemon-Scope Event Binding And Node-Scope Anchoring`); the five
// T1.12 registrants are NODE-scoped attachment-lifecycle rows, keyed on
// `nodeId` and bound to the session of the attachment they describe. No group
// is run-scoped — no payload among the twenty-five carries `runId` — so no
// branch here composes the helper yet. Later registrants of the five families
// arriving through the union-registration seam (the CP-009-4 / CP-010-5 /
// CP-012-2 / CP-016-3 class) inherit the admission requirement from
// `Spec-006 §Event Type Enumeration` — a strict payload schema that skipped
// the wrap would REJECT a stamped row at every site that parses through the
// STRICT layer. Scoped honestly: the tolerant `EventEnvelopeSchema` carrier
// accepts a stamped row either way (its `payload` is an open record that
// preserves unknown keys verbatim), so what an unwrapped branch costs is
// INTERPRETATION at the strict layer, not transport, append, or the canonical
// bytes. __tests__/event-source-epoch.test.ts walks the live union and fails
// when a run-scoped branch of an admitting family lands unwrapped, or when
// any other branch lands wrapped.
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
// repo.* / workspace.* — the six Plan-009 lifecycle variants (CP-009-4).
// --------------------------------------------------------------------------
//
// Additive-MINOR registration (`ADR-018 §Decision` #8) of the six
// Plan-009-emitted members of
// `Spec-006 §Repo, Workspace, and Worktree Lifecycle (session_lifecycle)`.
// All six type strings were ALREADY in the census (`SessionEventType` +
// `SESSION_EVENT_CATEGORY_BY_TYPE`, Plan-006 T1.2); what lands here is their
// PAYLOAD VARIANTS, which is what moves a type from a registered name the
// tolerant carrier accepts to one the strict layer can interpret. The census
// is untouched — still 156 types across 20 categories.
//
// ONE SHARED PAYLOAD SCHEMA. Spec-006 gives the whole eleven-member family a
// single payload shape, so all six compose the same
// `RepoWorkspaceLifecyclePayloadSchema` (authored in repo.ts per
// emitter-authors-payload — CP-009-4, the Plan-003 precedent carried forward
// in Plan-006 CP-006-5) rather than six copies of one contract. The five
// `worktree.*` members are registered in the block below through CP-010-5,
// carrying the SAME FAMILY SHAPE instantiated over Plan-010's own
// `WorktreeStateSchema` (the factory path, PR #250 round 4) rather than this
// two-vocabulary instantiation.
// Import direction is one-way: repo.ts imports nothing from this file.
//
// NO EPOCH STAMP. These are `session_lifecycle`, not run-scoped — their
// payload carries no `runId`, so the cross-cutting `sourceEpoch` /
// `sourcePosition` pair would be unattributable and the WRAP ADMISSION note
// above excludes them. __tests__/event-source-epoch.test.ts walks the live
// union and fails a non-admitting branch that lands wrapped.

// Emitted when `repo.attach` admits a local path as a durable repo mount
// (`Spec-009 §Required Behavior`).
export interface RepoAttachedEvent extends EventEnvelope {
  type: "repo.attached";
  category: "session_lifecycle";
  payload: RepoWorkspaceLifecyclePayload;
}
export const RepoAttachedEventSchema: z.ZodType<RepoAttachedEvent> = z
  .object({
    ...buildCommonShape(),
    type: z.literal("repo.attached"),
    category: z.literal("session_lifecycle"),
    payload: RepoWorkspaceLifecyclePayloadSchema,
  })
  .strict();

// Emitted when a mount transitions to the terminal `detached` state
// (`Spec-009 §Detach Semantics (V1 Definition)`, Plan-009 D-009-6).
export interface RepoDetachedEvent extends EventEnvelope {
  type: "repo.detached";
  category: "session_lifecycle";
  payload: RepoWorkspaceLifecyclePayload;
}
export const RepoDetachedEventSchema: z.ZodType<RepoDetachedEvent> = z
  .object({
    ...buildCommonShape(),
    type: z.literal("repo.detached"),
    category: z.literal("session_lifecycle"),
    payload: RepoWorkspaceLifecyclePayloadSchema,
  })
  .strict();

// Emitted at the head of a (re)provisioning transition — Plan-009's
// `WorkspaceService.beginReprovision` (CP-009-2).
export interface WorkspaceProvisioningEvent extends EventEnvelope {
  type: "workspace.provisioning";
  category: "session_lifecycle";
  payload: RepoWorkspaceLifecyclePayload;
}
export const WorkspaceProvisioningEventSchema: z.ZodType<WorkspaceProvisioningEvent> = z
  .object({
    ...buildCommonShape(),
    type: z.literal("workspace.provisioning"),
    category: z.literal("session_lifecycle"),
    payload: RepoWorkspaceLifecyclePayloadSchema,
  })
  .strict();

// Emitted when provisioning completes and the execution root is bound —
// `WorkspaceService.completeReprovision` (CP-009-2).
export interface WorkspaceReadyEvent extends EventEnvelope {
  type: "workspace.ready";
  category: "session_lifecycle";
  payload: RepoWorkspaceLifecyclePayload;
}
export const WorkspaceReadyEventSchema: z.ZodType<WorkspaceReadyEvent> = z
  .object({
    ...buildCommonShape(),
    type: z.literal("workspace.ready"),
    category: z.literal("session_lifecycle"),
    payload: RepoWorkspaceLifecyclePayloadSchema,
  })
  .strict();

// Emitted on the availability-loss transition — a failed reprovision
// (`WorkspaceService.failReprovision`, CP-009-2) or a workspace path that
// became unavailable after binding, after which write runs are blocked until
// repair (`Spec-009 §Fallback Behavior`).
export interface WorkspaceStaleEvent extends EventEnvelope {
  type: "workspace.stale";
  category: "session_lifecycle";
  payload: RepoWorkspaceLifecyclePayload;
}
export const WorkspaceStaleEventSchema: z.ZodType<WorkspaceStaleEvent> = z
  .object({
    ...buildCommonShape(),
    type: z.literal("workspace.stale"),
    category: z.literal("session_lifecycle"),
    payload: RepoWorkspaceLifecyclePayloadSchema,
  })
  .strict();

// Emitted once per dependent workspace archived by the detach cascade
// (`Spec-009 §Detach Semantics (V1 Definition)`, Plan-009 D-009-6).
export interface WorkspaceArchivedEvent extends EventEnvelope {
  type: "workspace.archived";
  category: "session_lifecycle";
  payload: RepoWorkspaceLifecyclePayload;
}
export const WorkspaceArchivedEventSchema: z.ZodType<WorkspaceArchivedEvent> = z
  .object({
    ...buildCommonShape(),
    type: z.literal("workspace.archived"),
    category: z.literal("session_lifecycle"),
    payload: RepoWorkspaceLifecyclePayloadSchema,
  })
  .strict();

// --------------------------------------------------------------------------
// worktree.* — the five Plan-010 lifecycle variants (CP-010-5).
// --------------------------------------------------------------------------
//
// Additive-MINOR registration (`ADR-018 §Decision` #8) of the five
// Plan-010-emitted members of
// `Spec-006 §Repo, Workspace, and Worktree Lifecycle (session_lifecycle)`.
// All five type strings were ALREADY in the census (`SessionEventType` +
// `SESSION_EVENT_CATEGORY_BY_TYPE`, Plan-006 T1.2); what lands here is their
// PAYLOAD VARIANTS. The census is untouched — still 156 types across 20
// categories.
//
// SAME FAMILY, OWN VOCABULARY. These five complete the eleven-member family
// the CP-009-4 block above began, but they do NOT compose
// `RepoWorkspaceLifecyclePayloadSchema`: their payload is the family factory
// instantiated over Plan-010's `WorktreeStateSchema` —
// `WorktreeLifecyclePayloadSchema`, authored in worktree.ts per
// emitter-authors-payload — so a worktree event claiming a repo/workspace
// state, or a workspace event claiming `merged`, stays a parse error
// (PR #250 round 4). Import direction is one-way: worktree.ts imports
// nothing from this file.
//
// THE REGISTRY STAYS CLOSED (Plan-010 D-010-11). Five arms, not six: the
// worktree ROW vocabulary has six states, but the `-> failed` transition
// emits no worktree event (Plan-010 I-010-13 — the failure incident is
// already evented as `workspace.stale` by the coupled `failReprovision`),
// and ephemeral-clone transitions emit none at all. `worktree.failed` is not
// a census member and MUST stay rejected by `SessionEventSchema`
// (pinned in __tests__/worktree.test.ts).
//
// NO EPOCH STAMP. `session_lifecycle`, not run-scoped — the same WRAP
// ADMISSION exclusion as the six above; __tests__/event-source-epoch.test.ts
// walks the live union and fails a non-admitting branch that lands wrapped.

// Emitted transactionally with worktree row creation (Plan-010 D-010-12;
// `Spec-010 §State And Data Implications`).
export interface WorktreeCreatedEvent extends EventEnvelope {
  type: "worktree.created";
  category: "session_lifecycle";
  payload: WorktreeLifecyclePayload;
}
export const WorktreeCreatedEventSchema: z.ZodType<WorktreeCreatedEvent> = z
  .object({
    ...buildCommonShape(),
    type: z.literal("worktree.created"),
    category: z.literal("session_lifecycle"),
    payload: WorktreeLifecyclePayloadSchema,
  })
  .strict();

// Emitted on the `creating -> ready` transition — the provisioned checkout is
// materialized and bound as an execution root (Plan-010 D-010-12).
export interface WorktreeReadyEvent extends EventEnvelope {
  type: "worktree.ready";
  category: "session_lifecycle";
  payload: WorktreeLifecyclePayload;
}
export const WorktreeReadyEventSchema: z.ZodType<WorktreeReadyEvent> = z
  .object({
    ...buildCommonShape(),
    type: z.literal("worktree.ready"),
    category: z.literal("session_lifecycle"),
    payload: WorktreeLifecyclePayloadSchema,
  })
  .strict();

// Emitted on the `-> dirty` transition — uncommitted work observed in the
// checkout (Plan-010 D-010-12; `Spec-010 §Required Behavior`).
export interface WorktreeDirtyEvent extends EventEnvelope {
  type: "worktree.dirty";
  category: "session_lifecycle";
  payload: WorktreeLifecyclePayload;
}
export const WorktreeDirtyEventSchema: z.ZodType<WorktreeDirtyEvent> = z
  .object({
    ...buildCommonShape(),
    type: z.literal("worktree.dirty"),
    category: z.literal("session_lifecycle"),
    payload: WorktreeLifecyclePayloadSchema,
  })
  .strict();

// Emitted on the `-> merged` transition — the worktree's branch has merged
// back (Plan-010 D-010-12).
export interface WorktreeMergedEvent extends EventEnvelope {
  type: "worktree.merged";
  category: "session_lifecycle";
  payload: WorktreeLifecyclePayload;
}
export const WorktreeMergedEventSchema: z.ZodType<WorktreeMergedEvent> = z
  .object({
    ...buildCommonShape(),
    type: z.literal("worktree.merged"),
    category: z.literal("session_lifecycle"),
    payload: WorktreeLifecyclePayloadSchema,
  })
  .strict();

// Emitted on the `-> retired` transition — recorded and evented BEFORE any
// disk mutation; cleanup is asynchronous and idempotent (Plan-010 I-010-9,
// D-010-12).
export interface WorktreeRetiredEvent extends EventEnvelope {
  type: "worktree.retired";
  category: "session_lifecycle";
  payload: WorktreeLifecyclePayload;
}
export const WorktreeRetiredEventSchema: z.ZodType<WorktreeRetiredEvent> = z
  .object({
    ...buildCommonShape(),
    type: z.literal("worktree.retired"),
    category: z.literal("session_lifecycle"),
    payload: WorktreeLifecyclePayloadSchema,
  })
  .strict();

// --------------------------------------------------------------------------
// audit_integrity + event_maintenance — the six Plan-006 variants (T1.11).
// --------------------------------------------------------------------------
//
// Additive-MINOR registration (`ADR-018 §Decision` #8) of the six
// Plan-006-emitted members of `Spec-006 §Audit Integrity (audit_integrity)`
// and `Spec-006 §Event Maintenance (event_maintenance)`. All six type strings
// were ALREADY in the census (`SessionEventType` +
// `SESSION_EVENT_CATEGORY_BY_TYPE`, Plan-006 T1.2); what lands here is their
// PAYLOAD VARIANTS. The census is untouched — still 156 types across 20
// categories.
//
// SELF-AUTHORED, NOT IMPORTED. The eleven registrants above import their
// payload schema from the EMITTING plan's module (CP-009-4 / CP-010-5). These
// six are emitted by Plan-006 itself, which owns this file, so the same
// emitter-authors-payload rule puts their schemas HERE — exported for the six
// emission seams to `.parse()` through: T3.1's `registerShredCallback` handler
// (`event.shredded`; Plan-022's Path 1 orchestrator invokes it after the
// `participant_keys` DELETE commits, so Plan-022 is the TRIGGER and T3.1 the
// parse site), T3.2 (`event.compacted`), T3.4 (`schema.migrated`), T4.1
// (`audit_integrity_verified`, plus the fifteen-mode verifier arm of
// `audit_integrity_failed` it derives via `.exclude()`), T4.2
// (`key_reuse_detected`), and T4.10 (that same variant's
// `signing_key_slot_conflict` registrar arm).
//
// FLAT UNDERSCORE NAMES. `audit_integrity_verified`, `audit_integrity_failed`,
// and `key_reuse_detected` carry NO dot namespace — verbatim from
// `Spec-006 §Audit Integrity (audit_integrity)`, and immutable wire
// identifiers under I-006-1-02 however they read beside the
// `<resource>.<verb>` majority.
//
// ENVELOPE-REDUNDANT MEMBERS ARE KEPT. The spec's payload cells re-spell
// `sessionId` (`audit_integrity`) and `occurredAt` (`event_maintenance`)
// alongside the envelope's own. They are transcribed verbatim rather than
// deduplicated: the payload shapes are the spec's, and both members sit in the
// RFC 8785 canonical bytes, so dropping either would change what the hash
// chain commits to (`session.created`'s payload re-spells `sessionId` on the
// same reasoning).
//
// DAEMON-SCOPE SESSION BINDING IS AN EMITTER OBLIGATION. Four of the six —
// `key_reuse_detected` plus all three `event_maintenance` types — are
// node-level observations bound to the reserved RFC 9562 §5.10 Max UUID
// sentinel `session_id` per
// `Spec-006 §Daemon-Scope Event Binding And Node-Scope Anchoring`. The
// envelope's `sessionId` is `SessionIdSchema` (`z.uuid()`), which already
// admits that sentinel, and no schema-level narrowing to it is taken here:
// the spec grants real-id carve-outs the narrowing would reject (an
// `event.compacted` scoped to ONE session MAY carry that session's id;
// `audit_integrity_*` carry the verified range's real id, the sentinel only
// when verifying the node-scope chain; the `signing_key_slot_conflict` arm
// carries the refused registration's real id and NEVER the sentinel).
//
// NO EPOCH STAMP. None of the six is run-scoped — no payload carries `runId`
// — so the WRAP ADMISSION note above excludes all six;
// __tests__/event-source-epoch.test.ts walks the live union and fails any of
// them that lands wrapped.

/**
 * A `session_events.sequence` value carried INSIDE a payload — a range
 * endpoint or an implicated row pointer.
 *
 * Takes the same ceiling as the envelope's own `sequence` (see the
 * {@link EVENT_ENVELOPE_SEQUENCE_MAX} note above): a payload endpoint that
 * cannot be represented faithfully cannot name the row it points at, and the
 * two would disagree about which rows a range covers.
 */
const payloadSequenceSchema = z
  .number()
  .int()
  .nonnegative()
  .max(EVENT_ENVELOPE_SEQUENCE_MAX, {
    message: `A payload sequence value must be at most ${EVENT_ENVELOPE_SEQUENCE_MAX} (Number.MAX_SAFE_INTEGER), the same injectivity ceiling EventEnvelope.sequence takes.`,
  });

/**
 * Length ceiling for the `audit_integrity_failed` payload's `detail` — the
 * operator-facing failure description (the refused registration's
 * `(session_id, node_id)` pair on the registrar arm, the verifier's finding on
 * the fifteen verifier failure modes).
 *
 * 512 is the package's short human-reason class (`RuntimeNodeDetachReason`,
 * `InviteRevokeReason`), not the 8192 error-detail class: `detail` is a
 * one-line operator signal on a row that is never compacted and never
 * shredded, so it is retained forever.
 */
export const AUDIT_INTEGRITY_DETAIL_MAX_LEN = 512;

/**
 * Length ceiling for the `schema.migrated` payload's `description` — the
 * migration's human label, Flyway's `description` column by precedent
 * (`Spec-006 §Event Maintenance (event_maintenance)`). Same short-reason class
 * as {@link AUDIT_INTEGRITY_DETAIL_MAX_LEN}.
 */
export const SCHEMA_MIGRATION_DESCRIPTION_MAX_LEN = 512;

/**
 * The sixteen `audit_integrity_failed` failure modes of
 * `Spec-006 §Audit Integrity (audit_integrity)` — fifteen read-side verifier
 * verdicts plus the daemon-side registrar's `signing_key_slot_conflict`
 * (2026-08-01 amendment).
 *
 * Named for the verifier because fifteen of sixteen are its verdicts and
 * because the plan (T4.1) names the schema `VerifierFailureModeSchema`; the
 * sixteenth is emitted by the registrar's conflict handler, which is exactly
 * why the payload below is DISCRIMINATED on this field rather than flat.
 */
export type VerifierFailureMode =
  | "hash_mismatch"
  | "signature_mismatch"
  | "anchor_mismatch"
  | "inclusion_proof_failed"
  | "consistency_proof_failed"
  | "log_file_missing"
  | "log_file_moved"
  | "anchor_missing_for_compacted_range"
  | "anchor_signature_invalid"
  | "stub_signature_invalid"
  | "stub_scalar_mismatch"
  | "signature_placeholder"
  | "occurred_at_not_canonical"
  | "pii_ciphertext_digest_unbound"
  | "pii_owner_stamp_unbound"
  | "signing_key_slot_conflict";

// Exported ENUM-typed rather than as `z.ZodType<VerifierFailureMode>`, and the
// difference is load-bearing: `.exclude()` lives on Zod's `ZodEnum` surface,
// which the `z.ZodType` annotation ERASES. `Plan-006 §Invariants` T4.1
// documents its consumer derivation as
// `VerifierFailureModeSchema.exclude(['signing_key_slot_conflict'])`. Under the
// erasing annotation that expression still compiled HERE — this file kept an
// unannotated module-local twin to derive from — while failing at T4.1's own
// module boundary: the worst shape of type error, invisible to the file that
// ships the symbol. The twin is retired for exactly that reason.
//
// The annotation is spelled out because `isolatedDeclarations` is repo-wide.
// `{ [K in VerifierFailureMode]: K }` is structurally what `z.enum([...])`
// infers for a string-array input — `util.ToEnum<T> = Flatten<{[k in T]: k}>`
// and `util.Flatten` is `Identity` (zod@4 `v4/core/util.d.ts`) — so this is an
// annotation, never a widening and never a cast.
//
// `VerifierFailurePathSchema` below deliberately keeps the `z.ZodType`
// annotation: no documented consumer derives from its enum surface, and the
// narrower annotation is the conservative default. The asymmetry is the
// consumer requirement, not a style drift.
//
// The verifier arm derives its fifteen-mode discriminator from THIS exported
// symbol, so the sixteen-mode vocabulary is single-sourced AND this file
// exercises exactly the surface T4.1 will. The compile-time binding to the
// type union stays the `Exclude<VerifierFailureMode, "signing_key_slot_conflict">`
// on the payload type alias, which is a real check rather than a comment.
export const VerifierFailureModeSchema: z.ZodEnum<{ [K in VerifierFailureMode]: K }> = z.enum([
  "hash_mismatch",
  "signature_mismatch",
  "anchor_mismatch",
  "inclusion_proof_failed",
  "consistency_proof_failed",
  "log_file_missing",
  "log_file_moved",
  "anchor_missing_for_compacted_range",
  "anchor_signature_invalid",
  "stub_signature_invalid",
  "stub_scalar_mismatch",
  "signature_placeholder",
  "occurred_at_not_canonical",
  "pii_ciphertext_digest_unbound",
  "pii_owner_stamp_unbound",
  "signing_key_slot_conflict",
]);

/**
 * The verification GUARANTEE that failed, per
 * `Spec-006 §Audit Integrity (audit_integrity)` — not the column the defect
 * occupies. `inclusion` is the chain path, `consistency` the anchor path, and
 * `signature` the signature-binding path (which is why the three
 * signature-survives-but-binding-broke modes —
 * `occurred_at_not_canonical`, `pii_ciphertext_digest_unbound`,
 * `pii_owner_stamp_unbound` — all pair with it). No fourth value is minted:
 * each of the three routes to one tamper-response owner.
 */
export type VerifierFailurePath = "inclusion" | "consistency" | "signature";
export const VerifierFailurePathSchema: z.ZodType<VerifierFailurePath> = z.enum([
  "inclusion",
  "consistency",
  "signature",
]);

// The `audit_integrity` payload base — `{sessionId, anchorId?,
// verifierNodeId}` verbatim from `Spec-006 §Audit Integrity
// (audit_integrity)`. A builder, not a shared const, for the same reason
// `buildCommonShape()` is one: each caller spreads a FRESH shape rather than
// aliasing one Zod object across schemas.
//
// Not every consumer takes the full base. The `audit_integrity_failed`
// REGISTRAR arm takes the REDUCED `{sessionId, verifierNodeId}` — it spreads
// this builder and DROPS `anchorId` (see that arm below), so a later base-shape
// change still propagates there instead of stopping at a hand-copied pair.
//
// `key_reuse_detected` deliberately does NOT compose it — its spec cell is a
// standalone shape with no `base +` prefix, and it names `detectorNodeId`
// rather than `verifierNodeId` because the emitter is an observer/monitor,
// not a verifier.
const buildAuditIntegrityBaseShape = () => ({
  sessionId: SessionIdSchema,
  // Opaque on the wire, deliberately NOT a branded/UUID-narrowed id: the
  // control-plane `event_log_anchors.id` is a UUID while the local
  // `pending_anchor_uploads.id` is `TEXT`, and no `AnchorId` vocabulary is
  // declared anywhere in the corpus. Minting one here would pre-commit every
  // importer to a shape no authority has fixed. Bounded free-form is the
  // conservative admission (length cap + whitespace-only + NUL guards); a
  // later narrowing is the owning plan's to take.
  anchorId: wireFreeFormString(EVENT_FIELD_MAX_LEN, "audit_integrity.anchorId").optional(),
  verifierNodeId: NodeIdSchema,
});

/**
 * `audit_integrity_verified` — a read-side verifier completed hash,
 * signature, and anchor checks over a range successfully
 * (`Spec-006 §Audit Integrity (audit_integrity)`).
 *
 * `rootHash` is bounded free-form, not a 64-hex pin: the house digest form is
 * 64-char lowercase hex (`daemon_signing_public_keys`' fingerprint,
 * `pii_ciphertext_digest`), but no authority pins THIS member's wire
 * spelling, and a pin here would be a narrowing nothing could relax
 * (`ADR-018 §Decision` #8 makes removals/narrowings MAJOR). The hex form is
 * the emitter's obligation, not the parser's. Same for
 * `signatureAlgorithm` — the spec enumerates no algorithm vocabulary, so no
 * enum is invented for it.
 */
export type AuditIntegrityVerifiedPayload = {
  sessionId: SessionId;
  anchorId?: string | undefined;
  verifierNodeId: NodeId;
  treeSize: number;
  rootHash: string;
  fromSeq: number;
  toSeq: number;
  verifiedAt: string;
  signatureAlgorithm: string;
};
export const AuditIntegrityVerifiedPayloadSchema: z.ZodType<AuditIntegrityVerifiedPayload> = z
  .object({
    ...buildAuditIntegrityBaseShape(),
    // Leaf count of the verified Merkle tree (RFC 9162 `tree_size`).
    treeSize: z.number().int().nonnegative(),
    rootHash: wireFreeFormString(EVENT_FIELD_MAX_LEN, "audit_integrity_verified.rootHash"),
    fromSeq: payloadSequenceSchema,
    toSeq: payloadSequenceSchema,
    verifiedAt: z.iso.datetime({ offset: true }),
    signatureAlgorithm: wireFreeFormString(
      EVENT_FIELD_MAX_LEN,
      "audit_integrity_verified.signatureAlgorithm",
    ),
  })
  .strict();

// The two arms of the payload below. Module-local: a consumer that needs one
// of them narrows through `Extract<AuditIntegrityFailedPayload, …>` on the
// `failureMode` discriminator, so exporting them would add surface no caller
// needs. The verifier arm's mode set is bound to the sixteen-mode vocabulary
// by `Exclude<…>` rather than re-typed, so the two cannot drift.
type AuditIntegrityFailedVerifierPayload = {
  sessionId: SessionId;
  anchorId?: string | undefined;
  verifierNodeId: NodeId;
  treeSize: number;
  expectedRootHash: string;
  observedRootHash: string;
  fromSeq: number;
  toSeq: number;
  // The `failureMode` × `failurePath` PRODUCT, deliberately — nine of the
  // fifteen pairings are fixed by authority and enforced at parse (see the
  // arm schema's mode/path check), but the TYPE stays the product the spec
  // cell describes. A distributive-narrowed annotation (a fifteen-member
  // union pairing each mode with its own path) cannot be satisfied by the
  // object schema's inference without a cast, and buying compile-time
  // narrowing with an `as unknown as` bridge on a signed-payload schema is a
  // bad trade: the cast would assert exactly what the runtime check proves.
  failureMode: Exclude<VerifierFailureMode, "signing_key_slot_conflict">;
  failurePath: VerifierFailurePath;
  offendingSeq?: number | undefined;
  detail: string;
};
// REDUCED base — `{sessionId, verifierNodeId}`, no `anchorId`
// (`Spec-006 §Audit Integrity (audit_integrity)`, 2026-08-03 amendment). The
// member is not merely unset on this arm, it is refused: the row is never
// compacted, never shredded, and never rewritten, so an anchor association
// written here would be permanently false. The two `runtime_node.capability_*`
// rows are the spec's reduced-base precedent.
type AuditIntegrityFailedRegistrarPayload = {
  sessionId: SessionId;
  verifierNodeId: NodeId;
  failureMode: "signing_key_slot_conflict";
  failurePath: "signature";
  detail: string;
};
/**
 * `audit_integrity_failed` — DISCRIMINATED on `failureMode`, not flat
 * (`Spec-006 §Audit Integrity (audit_integrity)`, 2026-08-01 amendment).
 *
 * The Merkle triple (`treeSize`, `expectedRootHash`, `observedRootHash`)
 * describes a VERIFIED RANGE. The fifteen read-side verifier modes walked one
 * and REQUIRE it; the registrar's `signing_key_slot_conflict` walked none, so
 * a flat sixteen-mode object would force its emitter to fabricate roots for a
 * tree it never touched. One event type, one wire schema, two arms: the
 * verifier can never silently omit its roots and the registrar can never
 * invent them. The verified RANGE splits the same way and for the same reason
 * — `fromSeq` / `toSeq` are required on the verifier arm (the dedupe key
 * `Plan-006 §Invariants` I-006-4-01 specifies) and absent from the registrar's,
 * which walked no range — and the verifier arm additionally enforces the nine
 * authority-fixed `failureMode` → `failurePath` pairings at parse. `anchorId`
 * splits the same way once more (2026-08-03): optional on the verifier arm,
 * whose range an anchor can cover, and EXCLUDED from the registrar's, which
 * has no range to be covered — refused there rather than left unset, because
 * the row is never rewritten and a false anchor association would be permanent.
 */
export type AuditIntegrityFailedPayload =
  | AuditIntegrityFailedVerifierPayload
  | AuditIntegrityFailedRegistrarPayload;

// Of the FIFTEEN verifier modes, the NINE `failureMode` → `failurePath`
// pairings the corpus FIXES and the SIX it deliberately leaves free (`null`);
// the registrar's sixteenth is carried at the end for totality only, its own
// arm pinning it. Authority, rule by rule, from
// `Security Architecture §Verification Rules`: rule 1 pins `hash_mismatch` →
// `inclusion`; rule 2 pins `signature_mismatch`, `signature_placeholder`,
// `occurred_at_not_canonical`, `pii_ciphertext_digest_unbound` and
// `pii_owner_stamp_unbound` → `signature`; rule 3 pins `anchor_mismatch` →
// `consistency`; rule 4 pins `stub_signature_invalid` and
// `stub_scalar_mismatch` → `signature`.
// `Spec-006 §Audit Integrity (audit_integrity)` independently ratifies the
// placeholder / `occurred_at` / PII trio ("ratified 2026-07-26 so
// implementations mirror this assignment rather than infer one") — a mandate
// to ENFORCE the assignment, which a three-value enum alone does not.
//
// The six `null` modes have NO corpus-fixed path: rule 3 names
// `anchor_missing_for_compacted_range` / `anchor_signature_invalid` and the
// four substrate modes WITHOUT a `failurePath`, so pinning one here would mint
// an authority that does not exist and be a narrowing nothing could relax
// (`ADR-018 §Decision` #8 makes narrowings MAJOR) — the same restraint the
// `rootHash` note above takes.
//
// The map is TOTAL over the wire enum (`null` is a value, not an omission), so
// `satisfies` breaks loudly in both directions: a mode added to the vocabulary
// leaves a missing key, a mode renamed or retired leaves an excess one.
// Totality over all SIXTEEN rather than the verifier's fifteen is deliberate on
// two counts: the lookup below is then index-safe however `.exclude()` infers
// its narrowed key type, and the registrar's own pin is a fact worth recording
// beside its siblings. Its arm pins the identical value with `z.literal`, so
// the two agree by construction and the verifier arm never reads that row.
const VERIFIER_FAILURE_PATH_BY_MODE = {
  hash_mismatch: "inclusion",
  signature_mismatch: "signature",
  anchor_mismatch: "consistency",
  inclusion_proof_failed: null,
  consistency_proof_failed: null,
  log_file_missing: null,
  log_file_moved: null,
  anchor_missing_for_compacted_range: null,
  anchor_signature_invalid: null,
  stub_signature_invalid: "signature",
  stub_scalar_mismatch: "signature",
  signature_placeholder: "signature",
  occurred_at_not_canonical: "signature",
  pii_ciphertext_digest_unbound: "signature",
  pii_owner_stamp_unbound: "signature",
  // The registrar's sixteenth mode — pinned by `Spec-006 §Audit Integrity
  // (audit_integrity)` ("It pairs with `failurePath: 'signature'`") and by its
  // own arm's `z.literal` below; present here only to keep the map total.
  signing_key_slot_conflict: "signature",
} satisfies Record<VerifierFailureMode, VerifierFailurePath | null>;

const auditIntegrityFailedVerifierArmSchema = z
  .object({
    ...buildAuditIntegrityBaseShape(),
    treeSize: z.number().int().nonnegative(),
    expectedRootHash: wireFreeFormString(
      EVENT_FIELD_MAX_LEN,
      "audit_integrity_failed.expectedRootHash",
    ),
    observedRootHash: wireFreeFormString(
      EVENT_FIELD_MAX_LEN,
      "audit_integrity_failed.observedRootHash",
    ),
    // REQUIRED, both — the verified range endpoints the dedupe key needs
    // (`Plan-006 §Invariants` I-006-4-01: consumers dedupe on
    // `(verifierNodeId, fromSeq, toSeq, verifiedAt)`; T4.1's IdempotencyClass
    // on the first three). The FOURTH member is deliberately not added here:
    // `verifiedAt` describes a COMPLETED verification and stays an
    // `audit_integrity_verified` member, so on this arm three of the four key
    // members are payload-resident and the fourth is the envelope's own
    // `occurredAt`. Every verifier invocation HAS a request range, the
    // whole-range modes included — which is exactly why they may omit
    // `offendingSeq` and still name the range they were asked to walk. NO
    // `fromSeq <= toSeq` cross-field refinement: the shipped
    // `audit_integrity_verified` sibling carries none, and minting one here
    // would be a new invariant with no authority behind it.
    fromSeq: payloadSequenceSchema,
    toSeq: payloadSequenceSchema,
    // Derived from the EXPORTED sixteen-mode schema so the two arms cannot
    // drift apart — and so this file exercises the exact `.exclude()` call
    // `Plan-006 §Invariants` T4.1 documents for its own consumer derivation.
    failureMode: VerifierFailureModeSchema.exclude(["signing_key_slot_conflict"]),
    failurePath: VerifierFailurePathSchema,
    // OPTIONAL — several modes implicate no single row (`log_file_missing`,
    // `anchor_missing_for_compacted_range`).
    offendingSeq: payloadSequenceSchema.optional(),
    detail: wireFreeFormString(AUDIT_INTEGRITY_DETAIL_MAX_LEN, "audit_integrity_failed.detail"),
  })
  .strict()
  // The nine fixed pairings, enforced rather than narrated. The enum pair
  // alone admits all 45 combinations, so a `signature_placeholder` row could
  // claim `failurePath: 'inclusion'` and parse green — routing a never-signed
  // row to the chain-tamper responder on a row that is never compacted and
  // never shredded, so the misrouting is permanent. The six unfixed modes keep
  // the full three-value latitude. `.superRefine()` returns `this`, so this
  // stays a ZodObject and remains a valid `z.discriminatedUnion` option (the
  // `withEpochStamp` note above records the same Zod-4 property).
  .superRefine((payload, ctx) => {
    const fixedPath = VERIFIER_FAILURE_PATH_BY_MODE[payload.failureMode];
    if (fixedPath !== null && payload.failurePath !== fixedPath) {
      ctx.addIssue({
        code: "custom",
        path: ["failurePath"],
        message: `audit_integrity_failed.failureMode '${payload.failureMode}' is fixed to failurePath '${fixedPath}' by Security Architecture §Verification Rules; this payload offers '${payload.failurePath}'.`,
      });
    }
  });

// Destructure-and-drop rather than a hand-copied `{sessionId, verifierNodeId}`
// pair: a later change to the shared base still reaches this arm, and only the
// ONE excluded member is spelled out here. `_anchorIdExcluded` is unread by
// construction and rides the `varsIgnorePattern: "^_"` the `_AssertExtends`
// pins use — no suppression comment is needed.
//
// The exclusion is ENFORCED, not conventional: `.strict()` below turns an
// unrecognized key into a parse failure, so a registrar payload offering
// `anchorId` is REFUSED. Dropping the member without `.strict()` would only
// have made it ignored — the value would still be accepted at the seam and
// could still be persisted by a caller reading the raw input.
const { anchorId: _anchorIdExcluded, ...auditIntegrityRegistrarBaseShape } =
  buildAuditIntegrityBaseShape();

const auditIntegrityFailedRegistrarArmSchema = z
  .object({
    ...auditIntegrityRegistrarBaseShape,
    failureMode: z.literal("signing_key_slot_conflict"),
    // Pinned, not the three-value enum: the spec fixes this arm's path at
    // `signature` — the guarantee broken is the roster's binding of this
    // node's signing key.
    failurePath: z.literal("signature"),
    detail: wireFreeFormString(AUDIT_INTEGRITY_DETAIL_MAX_LEN, "audit_integrity_failed.detail"),
  })
  .strict();

export const AuditIntegrityFailedPayloadSchema: z.ZodType<AuditIntegrityFailedPayload> =
  z.discriminatedUnion("failureMode", [
    auditIntegrityFailedVerifierArmSchema,
    auditIntegrityFailedRegistrarArmSchema,
  ]);

/**
 * `key_reuse_detected` — one Ed25519 public key observed under MORE THAN ONE
 * identity (`Spec-006 §Audit Integrity (audit_integrity)`).
 *
 * NO `base +` PREFIX in the spec cell, and the omission is load-bearing: this
 * is an observer's node-level finding, so it carries `detectorNodeId` and no
 * `sessionId` / `anchorId` / `verifierNodeId` at payload level. The envelope's
 * `sessionId` is the daemon-scope sentinel.
 */
export type KeyReuseDetectedPayload = {
  offendingKeyFingerprint: string;
  observedIdentities: Array<{ sessionId: SessionId; nodeId: NodeId }>;
  firstSeenAt: string;
  rotationInvariantViolated: "refuse_on_rotation";
  detectorNodeId: NodeId;
};
export const KeyReuseDetectedPayloadSchema: z.ZodType<KeyReuseDetectedPayload> = z
  .object({
    // Bounded free-form: V1 pins no fingerprint grammar (see the `rootHash`
    // note above).
    offendingKeyFingerprint: wireFreeFormString(
      EVENT_FIELD_MAX_LEN,
      "key_reuse_detected.offendingKeyFingerprint",
    ),
    // AT LEAST TWO, AND PAIRWISE DISTINCT — both halves are the spec's own
    // words rather than a local narrowing: the detected condition is a key
    // "registered under MORE THAN ONE identity — the same key material under
    // two distinct `(session_id, node_id)` pairs". A one-entry list describes a
    // key held by the identity that minted it, and a two-entry list that names
    // ONE identity twice describes that same compliant state redundantly —
    // neither is a collision. `.min(2)` counts HOW MANY, the refinement counts
    // HOW MANY DIFFERENT; cardinality alone would let a duplicated pair mint a
    // false reuse alarm on a row that is never compacted and never shredded,
    // so it is retained forever. The set key is built with `JSON.stringify`
    // over a two-string array — that serialization is injective, so no
    // separator character has to be assumed absent from either id.
    //
    // `sessionId` is CANONICALIZED into the key, `nodeId` is not, and the
    // asymmetry is the authority difference. UUID hex is case-INSENSITIVE
    // (RFC 9562 §4), the branded schemas normalize nothing, and
    // `uuid-canonical.ts` requires canonicalizing at every Map-key / hash-input
    // boundary — this set key is one. Without it, one logical identity spelled
    // two ways reads as two distinct identities and mints a permanent FALSE
    // `key_reuse_detected` alarm on a row that is never compacted and never
    // shredded. `NodeId` (node-id.ts) is a bounded free-form brand, NOT a UUID:
    // no authority makes it case-insensitive, so lowercasing it would INVENT
    // one and could collapse two genuinely distinct nodes into one key —
    // failing open on the alarm this event exists to raise. Key construction
    // only: the stored wire values pass through as emitted (no `.transform()`),
    // so the canonical bytes are untouched.
    observedIdentities: z
      .array(z.object({ sessionId: SessionIdSchema, nodeId: NodeIdSchema }).strict())
      .min(2, {
        message:
          "key_reuse_detected.observedIdentities must name at least two distinct (sessionId, nodeId) identities — one identity holding its own key is the register-once posture, not a collision.",
      })
      .refine(
        (identities) =>
          new Set(
            identities.map((identity) =>
              JSON.stringify([canonicalizeUuid(identity.sessionId), identity.nodeId]),
            ),
          ).size === identities.length,
        {
          message:
            "key_reuse_detected.observedIdentities must not name one (sessionId, nodeId) identity twice — a repeated pair is one identity holding its own key, which is the register-once posture, not a collision.",
        },
      ),
    firstSeenAt: z.iso.datetime({ offset: true }),
    // The single violated invariant name, pinned as a literal: V1 specifies
    // exactly one rotation posture (`refuse_on_rotation`), so an open string
    // would admit a vocabulary that does not exist.
    rotationInvariantViolated: z.literal("refuse_on_rotation"),
    detectorNodeId: NodeIdSchema,
  })
  .strict();

// The `event_maintenance` payload base — `{nodeId, operationId, occurredAt}`
// verbatim from `Spec-006 §Event Maintenance (event_maintenance)`. All three
// members are shared by all three types; `occurredAt` re-spells the envelope's
// own (see the envelope-redundant-members note above).
const buildEventMaintenanceBaseShape = () => ({
  nodeId: NodeIdSchema,
  // The batch/pass correlation id — Liquibase's `DEPLOYMENT_ID` by precedent.
  // Opaque and bounded free-form; the corpus fixes no format for it.
  operationId: wireFreeFormString(EVENT_FIELD_MAX_LEN, "event_maintenance.operationId"),
  occurredAt: z.iso.datetime({ offset: true }),
});

/**
 * `schema.migrated` — one migration BATCH completed (Flyway's
 * `AFTER_MIGRATE_OPERATION_FINISH` granularity, not per-statement) per
 * `Spec-006 §Event Maintenance (event_maintenance)`.
 *
 * `success` stays a plain boolean: the spec's field set carries it, so a
 * `z.literal(true)` narrowing would make the failed-migration row —
 * the one worth auditing — unrepresentable.
 */
export type SchemaMigratedPayload = {
  nodeId: NodeId;
  operationId: string;
  occurredAt: string;
  fromVersion: string;
  toVersion: string;
  migrationId: string;
  description: string;
  checksum: string;
  appliedBy: string;
  executionMs: number;
  success: boolean;
};
export const SchemaMigratedPayloadSchema: z.ZodType<SchemaMigratedPayload> = z
  .object({
    ...buildEventMaintenanceBaseShape(),
    // Schema versions, NOT `EventEnvelopeVersion`: these name migration
    // revisions of the local store (Flyway's `version` column), which take no
    // "MAJOR.MINOR" protocol grammar. Coupling them to the envelope's version
    // schema would be a false binding.
    fromVersion: wireFreeFormString(EVENT_FIELD_MAX_LEN, "schema.migrated.fromVersion"),
    toVersion: wireFreeFormString(EVENT_FIELD_MAX_LEN, "schema.migrated.toVersion"),
    migrationId: wireFreeFormString(EVENT_FIELD_MAX_LEN, "schema.migrated.migrationId"),
    description: wireFreeFormString(
      SCHEMA_MIGRATION_DESCRIPTION_MAX_LEN,
      "schema.migrated.description",
    ),
    // BLAKE3 over the concatenated migration file contents (Plan-006 T3.4) —
    // bounded free-form on the same reasoning as `rootHash` above.
    checksum: wireFreeFormString(EVENT_FIELD_MAX_LEN, "schema.migrated.checksum"),
    appliedBy: wireFreeFormString(EVENT_FIELD_MAX_LEN, "schema.migrated.appliedBy"),
    executionMs: z.number().int().nonnegative(),
    success: z.boolean(),
  })
  .strict();

/**
 * `event.compacted` — a compaction pass replaced full payloads in a range with
 * audit stubs (`Spec-006 §Event Maintenance (event_maintenance)`).
 *
 * `sessionId` is OPTIONAL here and required nowhere else in the family: the
 * spec grants a single-session pass the option of carrying that session's real
 * id while the daemon-scope row binds the sentinel at the ENVELOPE.
 */
export type EventCompactedPayload = {
  nodeId: NodeId;
  operationId: string;
  occurredAt: string;
  sessionId?: SessionId | undefined;
  fromSeq: number;
  toSeq: number;
  eventsBefore: number;
  eventsAfter: number;
  bytesReclaimed: number;
  tombstoneCount: number;
  compactionReason: "age_threshold" | "count_threshold" | "storage_threshold";
};
export const EventCompactedPayloadSchema: z.ZodType<EventCompactedPayload> = z
  .object({
    ...buildEventMaintenanceBaseShape(),
    sessionId: SessionIdSchema.optional(),
    fromSeq: payloadSequenceSchema,
    toSeq: payloadSequenceSchema,
    eventsBefore: z.number().int().nonnegative(),
    eventsAfter: z.number().int().nonnegative(),
    bytesReclaimed: z.number().int().nonnegative(),
    tombstoneCount: z.number().int().nonnegative(),
    // Closed vocabulary — the three `Spec-006 §Event Compaction Policy`
    // triggers.
    compactionReason: z.enum(["age_threshold", "count_threshold", "storage_threshold"]),
  })
  .strict();

/**
 * `event.shredded` — a crypto-shred cleared a participant's PII across the
 * affected sessions (`Spec-006 §Event Maintenance (event_maintenance)`;
 * Spec-022 owns the fan-out mechanism).
 *
 * `affectedSessionIds` takes NO cardinality floor: an idempotent re-run, or a
 * purge of a participant whose rows carried no PII, legitimately affects zero
 * sessions, and the row is still the audit record of the operation. (Contrast
 * `key_reuse_detected.observedIdentities` above, whose floor the spec's own
 * "more than one identity" wording entails.)
 */
export type EventShreddedPayload = {
  nodeId: NodeId;
  operationId: string;
  occurredAt: string;
  participantId: ParticipantId;
  affectedSessionIds: SessionId[];
  piiPayloadsCleared: number;
  shredReason: "gdpr_article_17" | "retention_policy" | "admin_action";
};
export const EventShreddedPayloadSchema: z.ZodType<EventShreddedPayload> = z
  .object({
    ...buildEventMaintenanceBaseShape(),
    participantId: ParticipantIdSchema,
    affectedSessionIds: z.array(SessionIdSchema),
    piiPayloadsCleared: z.number().int().nonnegative(),
    shredReason: z.enum(["gdpr_article_17", "retention_policy", "admin_action"]),
  })
  .strict();

// Emitted when a read-side verifier completes hash, signature, and anchor
// checks over a range successfully (Plan-006 T4.1).
export interface AuditIntegrityVerifiedEvent extends EventEnvelope {
  type: "audit_integrity_verified";
  category: "audit_integrity";
  payload: AuditIntegrityVerifiedPayload;
}
export const AuditIntegrityVerifiedEventSchema: z.ZodType<AuditIntegrityVerifiedEvent> = z
  .object({
    ...buildCommonShape(),
    type: z.literal("audit_integrity_verified"),
    category: z.literal("audit_integrity"),
    payload: AuditIntegrityVerifiedPayloadSchema,
  })
  .strict();

// Emitted when a verifier detects a chain break, signature failure, or anchor
// mismatch (Plan-006 T4.1), and when the daemon-side registrar's conflict
// handler observes a usurped signing-key slot (T4.10).
export interface AuditIntegrityFailedEvent extends EventEnvelope {
  type: "audit_integrity_failed";
  category: "audit_integrity";
  payload: AuditIntegrityFailedPayload;
}
export const AuditIntegrityFailedEventSchema: z.ZodType<AuditIntegrityFailedEvent> = z
  .object({
    ...buildCommonShape(),
    type: z.literal("audit_integrity_failed"),
    category: z.literal("audit_integrity"),
    payload: AuditIntegrityFailedPayloadSchema,
  })
  .strict();

// Emitted when the key-reuse monitor observes one public key under two
// identities (Plan-006 T4.2).
export interface KeyReuseDetectedEvent extends EventEnvelope {
  type: "key_reuse_detected";
  category: "audit_integrity";
  payload: KeyReuseDetectedPayload;
}
export const KeyReuseDetectedEventSchema: z.ZodType<KeyReuseDetectedEvent> = z
  .object({
    ...buildCommonShape(),
    type: z.literal("key_reuse_detected"),
    category: z.literal("audit_integrity"),
    payload: KeyReuseDetectedPayloadSchema,
  })
  .strict();

// Emitted once per completed migration batch (Plan-006 T3.4).
export interface SchemaMigratedEvent extends EventEnvelope {
  type: "schema.migrated";
  category: "event_maintenance";
  payload: SchemaMigratedPayload;
}
export const SchemaMigratedEventSchema: z.ZodType<SchemaMigratedEvent> = z
  .object({
    ...buildCommonShape(),
    type: z.literal("schema.migrated"),
    category: z.literal("event_maintenance"),
    payload: SchemaMigratedPayloadSchema,
  })
  .strict();

// Emitted once per compaction pass (Plan-006 T3.2).
export interface EventCompactedEvent extends EventEnvelope {
  type: "event.compacted";
  category: "event_maintenance";
  payload: EventCompactedPayload;
}
export const EventCompactedEventSchema: z.ZodType<EventCompactedEvent> = z
  .object({
    ...buildCommonShape(),
    type: z.literal("event.compacted"),
    category: z.literal("event_maintenance"),
    payload: EventCompactedPayloadSchema,
  })
  .strict();

// Emitted once per crypto-shred fan-out (Spec-022 §Shred Fan-Out).
export interface EventShreddedEvent extends EventEnvelope {
  type: "event.shredded";
  category: "event_maintenance";
  payload: EventShreddedPayload;
}
export const EventShreddedEventSchema: z.ZodType<EventShreddedEvent> = z
  .object({
    ...buildCommonShape(),
    type: z.literal("event.shredded"),
    category: z.literal("event_maintenance"),
    payload: EventShreddedPayloadSchema,
  })
  .strict();

// --------------------------------------------------------------------------
// runtime_node.* — the five Plan-003 lifecycle variants (T1.12, CP-003-1).
// --------------------------------------------------------------------------
//
// Additive-MINOR registration (`ADR-018 §Decision` #8) of the five
// DAEMON-REACHABLE members of
// `Spec-006 §Runtime Node Lifecycle (runtime_node_lifecycle)`. All five type
// strings were ALREADY in the census (`SessionEventType` +
// `SESSION_EVENT_CATEGORY_BY_TYPE`, Plan-006 T1.2); what lands here is their
// PAYLOAD VARIANTS. The census is untouched — still 156 types across 20
// categories.
//
// CP-003-1 LEG (a), discharged. Plan-003 authors the payload SHAPES in
// runtime-node.ts per emitter-authors-payload (its Phase-2 node-registry and
// capability-service producers `.parse()` through the very same consts);
// Plan-006 owns the discriminated-union REGISTRATION. So each arm below
// IMPORTS its `*PayloadSchema` rather than restating it, and no Plan-003 shape
// is edited here — the same split as the CP-009-4 / CP-010-5 blocks above.
//
// FIVE OF SEVEN, deliberately. `runtime_node.degraded` and
// `runtime_node.revoked` stay census members with NO payload variant: both are
// server-derived rows with no sound V1 author, V1.1-gated on the node-identity
// trust anchor (ADR-017 §Server-Derived Runtime-Node Lifecycle Events), so
// Plan-003 ships no payload shape for them and the strict layer keeps
// REJECTING them until it does. The `session.clock_*` pair sits in the same
// EventCategory but keeps its `session.` prefix by name preservation and is
// likewise unregistered here.
//
// SESSION BINDING — a `runtime_node.*` row carries the REAL `sessionId` of the
// attachment it describes (`Spec-006 §Runtime Node Lifecycle
// (runtime_node_lifecycle)`), NOT the daemon-scope sentinel the T1.11
// infrastructure rows anchor on. The PAYLOAD's `sessionId` is `.optional()`
// because Spec-006's base spells it `sessionId?`; the ENVELOPE's `sessionId`
// member stays required, as on every other arm.
//
// NO EPOCH STAMP. Node-scoped, not run-scoped — these payloads carry `nodeId`
// and no `runId`, so the cross-cutting `sourceEpoch` / `sourcePosition` pair
// would be unattributable and the WRAP ADMISSION note above excludes them.
// __tests__/event-source-epoch.test.ts walks the live union and fails a
// non-admitting branch that lands wrapped.

// Emitted by the T2.1 node-registry when a node is accepted into the roster
// (`Spec-003 §Required Behavior`, attach admission).
export interface RuntimeNodeRegisteredEvent extends EventEnvelope {
  type: "runtime_node.registered";
  category: "runtime_node_lifecycle";
  payload: RuntimeNodeRegisteredPayload;
}
export const RuntimeNodeRegisteredEventSchema: z.ZodType<RuntimeNodeRegisteredEvent> = z
  .object({
    ...buildCommonShape(),
    type: z.literal("runtime_node.registered"),
    category: z.literal("runtime_node_lifecycle"),
    payload: RuntimeNodeRegisteredPayloadSchema,
  })
  .strict();

// Emitted only AFTER `runtime_node.capability_declared` succeeds (Plan-003
// I-003-2 ordering).
export interface RuntimeNodeOnlineEvent extends EventEnvelope {
  type: "runtime_node.online";
  category: "runtime_node_lifecycle";
  payload: RuntimeNodeOnlinePayload;
}
export const RuntimeNodeOnlineEventSchema: z.ZodType<RuntimeNodeOnlineEvent> = z
  .object({
    ...buildCommonShape(),
    type: z.literal("runtime_node.online"),
    category: z.literal("runtime_node_lifecycle"),
    payload: RuntimeNodeOnlinePayloadSchema,
  })
  .strict();

// Emitted on detach (`explicit_shutdown` in V1); the payload's `reason` enum
// also carries the two V1.1 server-derived reasons, shape-stable ahead of
// their producers.
export interface RuntimeNodeOfflineEvent extends EventEnvelope {
  type: "runtime_node.offline";
  category: "runtime_node_lifecycle";
  payload: RuntimeNodeOfflinePayload;
}
export const RuntimeNodeOfflineEventSchema: z.ZodType<RuntimeNodeOfflineEvent> = z
  .object({
    ...buildCommonShape(),
    type: z.literal("runtime_node.offline"),
    category: z.literal("runtime_node_lifecycle"),
    payload: RuntimeNodeOfflinePayloadSchema,
  })
  .strict();

// Emitted by the T2.2 capability-service when a node declares a capability
// after registration. `capabilityDetails` is the canonical-first TOLERANT
// UNION (`CapabilityDetailsSchema` first, an open record behind it) bound in
// runtime-node.ts by Plan-006 T1.4 / CP-006-5 — registration composes it
// EXACTLY as shipped: tightening the arm to canonical-only here would reject
// previously-valid wire payloads, a MAJOR narrowing under
// `ADR-018 §Decision` #8.
export interface RuntimeNodeCapabilityDeclaredEvent extends EventEnvelope {
  type: "runtime_node.capability_declared";
  category: "runtime_node_lifecycle";
  payload: RuntimeNodeCapabilityDeclaredPayload;
}
export const RuntimeNodeCapabilityDeclaredEventSchema: z.ZodType<RuntimeNodeCapabilityDeclaredEvent> =
  z
    .object({
      ...buildCommonShape(),
      type: z.literal("runtime_node.capability_declared"),
      category: z.literal("runtime_node_lifecycle"),
      payload: RuntimeNodeCapabilityDeclaredPayloadSchema,
    })
    .strict();

// Emitted on a capability health/config change. `previousState` / `newState`
// are CapabilityDetails SNAPSHOTS, not `NodeState` values, and carry the same
// canonical-first tolerant union as `capability_declared` above (T1.4).
export interface RuntimeNodeCapabilityUpdatedEvent extends EventEnvelope {
  type: "runtime_node.capability_updated";
  category: "runtime_node_lifecycle";
  payload: RuntimeNodeCapabilityUpdatedPayload;
}
export const RuntimeNodeCapabilityUpdatedEventSchema: z.ZodType<RuntimeNodeCapabilityUpdatedEvent> =
  z
    .object({
      ...buildCommonShape(),
      type: z.literal("runtime_node.capability_updated"),
      category: z.literal("runtime_node_lifecycle"),
      payload: RuntimeNodeCapabilityUpdatedPayloadSchema,
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

export type SessionEvent =
  | SessionCreatedEvent
  | MembershipCreatedEvent
  | ChannelCreatedEvent
  | RepoAttachedEvent
  | RepoDetachedEvent
  | WorkspaceProvisioningEvent
  | WorkspaceReadyEvent
  | WorkspaceStaleEvent
  | WorkspaceArchivedEvent
  | WorktreeCreatedEvent
  | WorktreeReadyEvent
  | WorktreeDirtyEvent
  | WorktreeMergedEvent
  | WorktreeRetiredEvent
  | AuditIntegrityVerifiedEvent
  | AuditIntegrityFailedEvent
  | KeyReuseDetectedEvent
  | SchemaMigratedEvent
  | EventCompactedEvent
  | EventShreddedEvent
  | RuntimeNodeRegisteredEvent
  | RuntimeNodeOnlineEvent
  | RuntimeNodeOfflineEvent
  | RuntimeNodeCapabilityDeclaredEvent
  | RuntimeNodeCapabilityUpdatedEvent;
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
  // The six Plan-009 repo/workspace arms (CP-009-4). Each shares the single
  // family payload schema imported from repo.ts, so these branch schemas and
  // the `*EventSchema` exports above cannot drift on payload shape — the same
  // single-sourcing the local `*PayloadSchema` consts give the three Plan-001
  // arms. None is wrapped with `withEpochStamp`; see the no-epoch-stamp note
  // on their declarations above.
  z
    .object({
      ...buildCommonShape(),
      type: z.literal("repo.attached"),
      category: z.literal("session_lifecycle"),
      payload: RepoWorkspaceLifecyclePayloadSchema,
    })
    .strict(),
  z
    .object({
      ...buildCommonShape(),
      type: z.literal("repo.detached"),
      category: z.literal("session_lifecycle"),
      payload: RepoWorkspaceLifecyclePayloadSchema,
    })
    .strict(),
  z
    .object({
      ...buildCommonShape(),
      type: z.literal("workspace.provisioning"),
      category: z.literal("session_lifecycle"),
      payload: RepoWorkspaceLifecyclePayloadSchema,
    })
    .strict(),
  z
    .object({
      ...buildCommonShape(),
      type: z.literal("workspace.ready"),
      category: z.literal("session_lifecycle"),
      payload: RepoWorkspaceLifecyclePayloadSchema,
    })
    .strict(),
  z
    .object({
      ...buildCommonShape(),
      type: z.literal("workspace.stale"),
      category: z.literal("session_lifecycle"),
      payload: RepoWorkspaceLifecyclePayloadSchema,
    })
    .strict(),
  z
    .object({
      ...buildCommonShape(),
      type: z.literal("workspace.archived"),
      category: z.literal("session_lifecycle"),
      payload: RepoWorkspaceLifecyclePayloadSchema,
    })
    .strict(),
  // The five Plan-010 worktree arms (CP-010-5). Each shares
  // `WorktreeLifecyclePayloadSchema` imported from worktree.ts — the family
  // factory instantiated over `WorktreeStateSchema` — so these branch schemas
  // and the `*EventSchema` exports above cannot drift on payload shape. No
  // `worktree.failed` arm exists (Plan-010 D-010-11), and none is wrapped
  // with `withEpochStamp` (`session_lifecycle`, not run-scoped; see the
  // no-epoch-stamp note on their declarations above).
  z
    .object({
      ...buildCommonShape(),
      type: z.literal("worktree.created"),
      category: z.literal("session_lifecycle"),
      payload: WorktreeLifecyclePayloadSchema,
    })
    .strict(),
  z
    .object({
      ...buildCommonShape(),
      type: z.literal("worktree.ready"),
      category: z.literal("session_lifecycle"),
      payload: WorktreeLifecyclePayloadSchema,
    })
    .strict(),
  z
    .object({
      ...buildCommonShape(),
      type: z.literal("worktree.dirty"),
      category: z.literal("session_lifecycle"),
      payload: WorktreeLifecyclePayloadSchema,
    })
    .strict(),
  z
    .object({
      ...buildCommonShape(),
      type: z.literal("worktree.merged"),
      category: z.literal("session_lifecycle"),
      payload: WorktreeLifecyclePayloadSchema,
    })
    .strict(),
  z
    .object({
      ...buildCommonShape(),
      type: z.literal("worktree.retired"),
      category: z.literal("session_lifecycle"),
      payload: WorktreeLifecyclePayloadSchema,
    })
    .strict(),
  // The six Plan-006 `audit_integrity` / `event_maintenance` arms (T1.11).
  // Each shares the payload const declared above — authored in THIS file
  // rather than imported, because Plan-006 both owns the file and emits the
  // rows — so these branch schemas and the `*EventSchema` exports above
  // cannot drift on payload shape. `audit_integrity_failed` carries the
  // `failureMode`-discriminated payload union, a nested discriminator the
  // outer `type` dispatch is indifferent to. None is wrapped with
  // `withEpochStamp` (daemon-scope, not run-scoped; see the no-epoch-stamp
  // note on their declarations above).
  z
    .object({
      ...buildCommonShape(),
      type: z.literal("audit_integrity_verified"),
      category: z.literal("audit_integrity"),
      payload: AuditIntegrityVerifiedPayloadSchema,
    })
    .strict(),
  z
    .object({
      ...buildCommonShape(),
      type: z.literal("audit_integrity_failed"),
      category: z.literal("audit_integrity"),
      payload: AuditIntegrityFailedPayloadSchema,
    })
    .strict(),
  z
    .object({
      ...buildCommonShape(),
      type: z.literal("key_reuse_detected"),
      category: z.literal("audit_integrity"),
      payload: KeyReuseDetectedPayloadSchema,
    })
    .strict(),
  z
    .object({
      ...buildCommonShape(),
      type: z.literal("schema.migrated"),
      category: z.literal("event_maintenance"),
      payload: SchemaMigratedPayloadSchema,
    })
    .strict(),
  z
    .object({
      ...buildCommonShape(),
      type: z.literal("event.compacted"),
      category: z.literal("event_maintenance"),
      payload: EventCompactedPayloadSchema,
    })
    .strict(),
  z
    .object({
      ...buildCommonShape(),
      type: z.literal("event.shredded"),
      category: z.literal("event_maintenance"),
      payload: EventShreddedPayloadSchema,
    })
    .strict(),
  // The five Plan-003 `runtime_node.*` arms (T1.12 — CP-003-1 leg (a)). Each
  // shares the `*PayloadSchema` imported from runtime-node.ts, so these branch
  // schemas and the `*EventSchema` exports above cannot drift on payload shape.
  // No `runtime_node.degraded` / `runtime_node.revoked` arm exists (V1.1-gated,
  // ADR-017 §Server-Derived Runtime-Node Lifecycle Events), the two capability
  // arms carry T1.4's canonical-first tolerant unions exactly as shipped, and
  // none is wrapped with `withEpochStamp` (node-scoped, not run-scoped; see the
  // no-epoch-stamp note on their declarations above).
  z
    .object({
      ...buildCommonShape(),
      type: z.literal("runtime_node.registered"),
      category: z.literal("runtime_node_lifecycle"),
      payload: RuntimeNodeRegisteredPayloadSchema,
    })
    .strict(),
  z
    .object({
      ...buildCommonShape(),
      type: z.literal("runtime_node.online"),
      category: z.literal("runtime_node_lifecycle"),
      payload: RuntimeNodeOnlinePayloadSchema,
    })
    .strict(),
  z
    .object({
      ...buildCommonShape(),
      type: z.literal("runtime_node.offline"),
      category: z.literal("runtime_node_lifecycle"),
      payload: RuntimeNodeOfflinePayloadSchema,
    })
    .strict(),
  z
    .object({
      ...buildCommonShape(),
      type: z.literal("runtime_node.capability_declared"),
      category: z.literal("runtime_node_lifecycle"),
      payload: RuntimeNodeCapabilityDeclaredPayloadSchema,
    })
    .strict(),
  z
    .object({
      ...buildCommonShape(),
      type: z.literal("runtime_node.capability_updated"),
      category: z.literal("runtime_node_lifecycle"),
      payload: RuntimeNodeCapabilityUpdatedPayloadSchema,
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

// The SCHEMA-registered subset — the types whose payload variants are
// registered in `SessionEventSchema` above — NOT the taxonomy census (that
// is `SESSION_EVENT_CATEGORY_BY_TYPE`, whose keys iterate all 156 registered
// types). The `SessionEvent["type"]` element annotation binds membership to
// the schema union at COMPILE time: a census literal without a registered
// payload variant is rejected here (a plain `SessionEventType` annotation
// would admit any of the 156), and the admissible set widens as emitting
// plans land variants through the union-registration seam. Exposed as a
// const tuple so consumers can iterate the registered payload variants
// without re-parsing the schemas.
//
// The ROSTER, unlike the admissible SET, does not widen on its own: it is a
// hand-written list, so a plan that registers a union arm MUST add its type
// here in the same diff. `__tests__/event-source-epoch.test.ts`'s
// non-vacuity guard asserts set-equality between this roster and the live
// union's branches, so a forgotten entry fails there rather than silently
// under-reporting the registered surface.
//
// Membership today (25): the three Plan-001 variants, the six Plan-009
// repo/workspace variants (CP-009-4), the five Plan-010 worktree variants
// (CP-010-5), the six Plan-006 audit-integrity / event-maintenance variants
// (T1.11), and the five Plan-003 runtime-node variants (T1.12 — CP-003-1
// leg (a)). Order mirrors the declaration order of the union arms above.
export const SESSION_EVENT_TYPES: readonly SessionEvent["type"][] = [
  "session.created",
  "membership.created",
  "channel.created",
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
  "audit_integrity_verified",
  "audit_integrity_failed",
  "key_reuse_detected",
  "schema.migrated",
  "event.compacted",
  "event.shredded",
  "runtime_node.registered",
  "runtime_node.online",
  "runtime_node.offline",
  "runtime_node.capability_declared",
  "runtime_node.capability_updated",
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
// CapabilityDetails — HOISTED (Plan-006 T1.4; declarations in event-core.ts).
// --------------------------------------------------------------------------
//
// `CAPABILITY_CONTRACT_VERSION_MAX_LEN`, the `CapabilityDetails` interface,
// `CapabilityDetailsSchema`, their module-local tool-element schema, and all
// six compile-time drift pins moved VERBATIM to `./event-core.js` (T1.12) and
// are re-exported from the hoist seam near the top of this file — Plan-006
// still owns the shape, and its full rationale (why it is non-normalizing, why
// the pins exist, why `tools` is readonly) travelled with the declarations.
// The move was forced by the cycle: `runtime-node.ts` reads
// `CapabilityDetailsSchema` at module scope for T1.4's canonical-first
// tolerant unions, and this file now reads runtime-node.ts's payload schemas
// at module scope for the T1.12 arms above.

// Note: cross-file ID types (`SessionId`, `MembershipId`, …) are not re-
// exported here — they are surfaced from `session.ts` and reach the public
// API via `index.ts`'s `export * from "./session.js"`. Re-exporting them
// from this file too would create a duplicate-export conflict at the
// package barrel.

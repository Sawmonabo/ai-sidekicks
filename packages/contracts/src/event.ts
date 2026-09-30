// Session event contracts — the canonical event-type census, the named
// canonical `EventEnvelopeSchema` carrier, plus the V1 subset of payload
// variants of the canonical EventEnvelope shape.
//
// The original event type the session vertical slice needs:
//   • session.created    — emitted on `SessionCreate` admit
//
// Adds six more through the union-registration seam: `repo.attached`,
// `repo.detached`, and the four `workspace.*` lifecycle types, all sharing
// one payload schema imported from repo.ts.
//
// Adds the five `worktree.*` lifecycle types through the same seam,
// carrying the family payload instantiated over its own
// `WorktreeStateSchema` and imported from worktree.ts. No `worktree.failed`
// variant — registry stays closed.
//
// Adds `event.compacted`, the variant the daemon emits ITSELF. Unlike the
// eleven above it imports no payload schema: its payload schema is declared and
// exported here, as are those of the five body-bearing assistant and tool
// variants.
//
// The remaining variants import their payload from the contract that owns the
// record: approvals, plans, questions, MCP governance, cloud tasks, undo,
// goals, notices, side questions, the reviewer's flag, commands, git
// settlements, the relay pin, the session verbs, a chat's conversion, a
// worktree sweep, a branch change, an agent's provider binding, the run's step
// bound, the terminal's holder, workflow runs, steps and gates,
// and backups. `usage.model_rerouted` is the exception:
// no other contract declares its payload, so it is declared here.
//
// The discriminated-union `SessionEvent` discriminates on the wire `type`
// string. Adding a new variant later is additive. The taxonomy is closed:
// `SessionEventType`, the per-category `*_EVENT_TYPES` arrays, and
// `SESSION_EVENT_CATEGORY_BY_TYPE` (19 categories). Payload variants remain
// intentionally a strict subset; census membership is type registration, not
// payload support.
//
// `session.created` registers under `session_lifecycle`. The
// `<category>.<verb>` namespace convention follows resource-lifecycle naming
// (`<resource>.created`).
//
// Versioning: `version` is an `EventEnvelopeVersion` — a semver `"MAJOR.MINOR"` STRING.
// It is NEVER numeric on the wire (lexical compare on strings like "1.10" vs "1.9" is
// unsafe; the reader parses MAJOR/MINOR as integers). The format check lives on
// `EventEnvelopeVersionSchema` — declared in `./event-core.js`, re-exported through the
// hoist seam below — and enforces the regex.
//
import { z } from "zod";

// The three symbols this file still CONSUMES from its own hoisted leaf. The
// leaf's other exports reach the public API through the re-export seam below,
// which is a separate statement pair by design (`export … from` introduces no
// local binding, so the two forms never collide).
import {
  EVENT_FIELD_MAX_LEN,
  EventEnvelopeVersionSchema,
  type EventEnvelopeVersion,
} from "./event-core.js";
// The payload schemas below are imported one way: none of their files imports
// anything from this file, directly or through another module, so no import
// here can close an eager-Zod module cycle.
import {
  AgentProviderBindingChangedPayloadSchema,
  AgentProviderBindingChangeFailedPayloadSchema,
  type AgentProviderBindingChangedPayload,
  type AgentProviderBindingChangeFailedPayload,
} from "./agent-provider-binding.js";
import {
  ApprovalCanceledPayloadSchema,
  ApprovalDenialOverriddenPayloadSchema,
  ApprovalRememberedPayloadSchema,
  ApprovalRequestedPayloadSchema,
  ApprovalResolvedPayloadSchema,
  ApprovalReviewerDeniedPayloadSchema,
  ApprovalRuleRevokedPayloadSchema,
  type ApprovalCanceledPayload,
  type ApprovalDenialOverriddenPayload,
  type ApprovalRememberedPayload,
  type ApprovalRequestedPayload,
  type ApprovalResolvedPayload,
  type ApprovalReviewerDeniedPayload,
  type ApprovalRuleRevokedPayload,
} from "./approval.js";
import { CloudTaskUpdatedPayloadSchema, type CloudTaskUpdatedPayload } from "./cloud.js";
import { CommandEndedPayloadSchema, type CommandEndedPayload } from "./command.js";
import {
  BackupCompletedPayloadSchema,
  BackupFailedPayloadSchema,
  BackupRestoredPayloadSchema,
  type BackupCompletedPayload,
  type BackupFailedPayload,
  type BackupRestoredPayload,
} from "./daemon-backup.js";
import { GitSettledPayloadSchema, type GitSettledPayload } from "./gitflow/local.js";
import {
  McpServerConfigChangedPayloadSchema,
  McpServerOauthCompletedPayloadSchema,
  McpServerStatusChangedPayloadSchema,
  McpServerTrustChangedPayloadSchema,
  McpToolOverrideChangedPayloadSchema,
  type McpServerConfigChangedPayload,
  type McpServerOauthCompletedPayload,
  type McpServerStatusChangedPayload,
  type McpServerTrustChangedPayload,
  type McpToolOverrideChangedPayload,
} from "./mcp-governance.js";
// DIRECT import from the `./node-id.js` leaf — the same eager-Zod-cycle
// discipline repo.ts's header records: the leaf is dependency-free, so
// importing it can never close a module-scope cycle.
import { uuidTextFormSchema } from "./internal/branded.js";
import { NodeIdSchema, type NodeId } from "./node-id.js";
import {
  PlanAcceptedPayloadSchema,
  PlanHandedOffPayloadSchema,
  PlanProposedPayloadSchema,
  type PlanAcceptedPayload,
  type PlanHandedOffPayload,
  type PlanProposedPayload,
} from "./plan.js";
import { DRIVER_FAILURE_DETAIL_MAX_LEN, RunIdSchema, type RunId } from "./provider-driver.js";
import { PtyControlChangedPayloadSchema, type PtyControlChangedPayload } from "./pty.js";
import { QuestionAskedPayloadSchema, type QuestionAskedPayload } from "./question.js";
import { RelayPinRefusedPayloadSchema, type RelayPinRefusedPayload } from "./relay.js";
import { RepoWorkspaceLifecyclePayloadSchema, type RepoWorkspaceLifecyclePayload } from "./repo.js";
import {
  RunRecoveryResolvedPayloadSchema,
  type RunRecoveryResolvedPayload,
} from "./run-control.js";
import {
  ModerationReviewFlaggedPayloadSchema,
  RunStepLimitReachedPayloadSchema,
  SessionNoticePayloadSchema,
  SessionSideQuestionAnsweredPayloadSchema,
  type ModerationReviewFlaggedPayload,
  type RunStepLimitReachedPayload,
  type SessionNoticePayload,
  type SessionSideQuestionAnsweredPayload,
} from "./session-controls.js";
import {
  SessionGoalClearedPayloadSchema,
  SessionGoalUpdatedPayloadSchema,
  type SessionGoalClearedPayload,
  type SessionGoalUpdatedPayload,
} from "./session-goal.js";
import {
  SessionRestoreFinishedPayloadSchema,
  type SessionRestoreFinishedPayload,
} from "./session-restore.js";
import { SessionConvertedPayloadSchema, type SessionConvertedPayload } from "./session-convert.js";
import { RunQueuedPayloadSchema, type RunQueuedPayload } from "./run-queued.js";
import { SessionCreatedPayloadSchema, type SessionCreatedPayload } from "./session-created.js";
import {
  SessionIdSchema,
  SessionLifecycleChangePayloadSchema,
  SessionMarkChangePayloadSchema,
  SessionRenamedPayloadSchema,
  wireFreeFormString,
  type SessionId,
  type SessionLifecycleChangePayload,
  type SessionMarkChangePayload,
  type SessionRenamedPayload,
} from "./session.js";
// One-way import: worktree.ts imports nothing from this file — same
// eager-Zod-cycle discipline as the repo.js import above.
import {
  SessionBranchChangedPayloadSchema,
  SessionSweptToRepoRootPayloadSchema,
  WorktreeCreatedPayloadSchema,
  WorktreeRetiredPayloadSchema,
  type SessionBranchChangedPayload,
  type SessionSweptToRepoRootPayload,
  type WorktreeCreatedPayload,
  type WorktreeRetiredPayload,
} from "./worktree-events.js";
import { WorktreeLifecyclePayloadSchema, type WorktreeLifecyclePayload } from "./worktree.js";
import {
  WorkflowCanceledPayloadSchema,
  WorkflowResultsPostedPayloadSchema,
  WorkflowResumedPayloadSchema,
  WorkflowStartedPayloadSchema,
  type WorkflowCanceledPayload,
  type WorkflowResultsPostedPayload,
  type WorkflowResumedPayload,
  type WorkflowStartedPayload,
} from "./workflow-run-control.js";
import {
  WorkflowGateResolvedPayloadSchema,
  WorkflowStepCanceledPayloadSchema,
  WorkflowStepFailedPayloadSchema,
  WorkflowStepFinishedPayloadSchema,
  WorkflowStepSkippedPayloadSchema,
  WorkflowStepStartedPayloadSchema,
  type WorkflowGateResolvedPayload,
  type WorkflowStepEventPayload,
  type WorkflowStepFailedPayload,
  type WorkflowStepFinishedPayload,
  type WorkflowStepSkippedPayload,
  type WorkflowStepStartedPayload,
} from "./workflow-run-step.js";

// --------------------------------------------------------------------------
// EventCategory — canonical taxonomy enum.
// --------------------------------------------------------------------------
//
// Mirrors the EventCategory registry: 19 categories. Producers MUST emit the category
// the registry assigns the type, and consumers MUST NOT silently coerce mismatches. The
// literal `category` per variant in the discriminatedUnion below enforces this on the
// wire — a `{type: "session.created", category: "approval_flow"}` payload is rejected
// at parse time, BEFORE it is stored under the wrong category string and breaks replay.
//
// ORDER IS NOT LOAD-BEARING — RFC 8785 JCS canonicalization serializes the LITERAL wire
// string ("session_lifecycle", "approval_flow", etc.), so the TypeScript enum's
// declaration order does not affect canonical bytes; reordering, inserting, or appending
// categories is byte-equivalent (it IS still a contract bump; additions are MINOR).

/** The family a session event belongs to; every event type maps to exactly one. */
export type EventCategory =
  | "run_lifecycle"
  | "assistant_output"
  | "tool_activity"
  | "interactive_request"
  | "artifact_publication"
  | "session_lifecycle"
  | "approval_flow"
  | "usage_telemetry"
  | "runtime_node_lifecycle"
  | "recovery_events"
  | "security_events"
  | "event_maintenance"
  | "policy_events"
  | "orchestration_admission"
  | "mcp_governance"
  | "workflow_lifecycle"
  | "workflow_phase_lifecycle"
  | "workflow_parallel_coordination"
  | "workflow_gate_resolution";
export const EventCategorySchema: z.ZodType<EventCategory> = z.enum([
  "run_lifecycle",
  "assistant_output",
  "tool_activity",
  "interactive_request",
  "artifact_publication",
  "session_lifecycle",
  "approval_flow",
  "usage_telemetry",
  "runtime_node_lifecycle",
  "recovery_events",
  "security_events",
  "event_maintenance",
  "policy_events",
  "orchestration_admission",
  "mcp_governance",
  "workflow_lifecycle",
  "workflow_phase_lifecycle",
  "workflow_parallel_coordination",
  "workflow_gate_resolution",
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
// every in-tree importer keeps importing them from here unchanged.
//
// A contract change to any of these eight is made in `./event-core.js`.
//
// Type-only re-exports MUST use `export type { ... }` (the `isolatedModules` +
// `verbatimModuleSyntax` posture from tsconfig.base.json forbids erased
// re-exports on the runtime form).
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
// contracts value type: the control-plane version-floor gate AND the daemon's
// envelope version negotiation both compare EventEnvelopeVersion values.
// Contracts is their only shared ancestor; a consumer-local helper would force
// the other consumer to depend upward or re-implement the comparison (the
// lexical "10" < "9" bug, twice).
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
// The HTTP/tRPC framework layer (005) is authoritative on total request-body
// size. These per-field caps live in the contracts package as a SECOND line
// of defense so a future non-HTTP caller (daemon-internal IPC, replay
// machinery, fixtures) can't smuggle a single pathological field past the
// parser. Values are conservative defaults; raising them is a contract bump.
//
// Rationale per cap:
//   • EVENT_FIELD_MAX_LEN (256)        — id / actor / correlationId /
//     causationId. UUIDs are 36 chars; 256 leaves plenty of headroom for any
//     composite identifier scheme without enabling DoS. Declared in
//     event-core.ts; the seam above re-exports it from this file.
//   • ERROR_MESSAGE_MAX_LEN (8192)     — top-level `message` field on error
//     envelopes. 8 KiB is well above any human-readable error string but
//     still bounded. Defined in error.ts (co-located with the error
//     envelope schema that consumes it).
//
// Free-form string fields (id / actor / correlationId / causationId / message
// / details.resource) all consume the
// `wireFreeFormString(maxLen, label)` helper from session.ts, which applies
// the length bounds AND a whitespace-only rejection AND a NUL-byte rejection.
// The trust boundary lives at the wire layer because the daemon accepts
// input from external (cross-node, future RPC) callers — producer trust is
// a weaker argument once a non-trusted process can synthesize a wire
// envelope. NUL bytes also corrupt OpenTelemetry trace lines that the
// observability layer emits from `correlationId` / `causationId`.

// --------------------------------------------------------------------------
// EventEnvelope — the canonical event message.
// --------------------------------------------------------------------------
//
// Two layers share this file, and the split is deliberate:
//
//   • ENVELOPE layer (`EventEnvelopeSchema`) — the version-TOLERANT carrier.
//     `type` is a bounded free-form string, NOT the `SessionEventType`
//     census union: MINOR envelope bumps may introduce new event types (#8,
//     additive-only), and a reader MUST persist an envelope whose `type` it
//     cannot interpret as a version stub — never drop or reject it (#5, #9
//     accept-and-stub). A census-typed envelope schema would reject exactly
//     the envelopes the stub path exists to preserve. `payload` is likewise
//     an open record: unknown payload fields from a higher-MINOR producer
//     are preserved verbatim for future upcasting, never stripped.
//   • STRICT layer (`SessionEventSchema` + `SESSION_EVENT_CATEGORY_BY_TYPE`
//     below) — the interpretation surface, where unknown types and
//     category/type mismatches fail loud at parse time.
//
// Bounds on the tolerance, both mirrored from the wire authority:
//   • `category` stays the closed canonical enum (`EventCategorySchema`):
//     the wire authority types it `EventCategory`, `category` participates
//     in the canonical bytes, and a reader with no registry rows for a
//     category cannot route under it — category additions are
//     code-accompanied MINOR contract bumps (see the EventCategory note
//     above), not runtime-tolerated strings.
//   • The TOP-LEVEL member set is CLOSED (`.strict()`): fixes membership at
//     exactly the eleven fields below, and `pii_payload` is a storage
//     column, deliberately NOT an envelope member. Default Zod stripping
//     would silently desync the parse output from the canonical bytes the
//     log stores; the additive channel for new data is `payload`, never a
//     new envelope member.

// --------------------------------------------------------------------------
// Sequence ceiling — a replay-key collision guard, NOT a policy knob.
// --------------------------------------------------------------------------
//
// The largest `sequence` an envelope may carry: accepted at exactly this
// value, refused one above it.
//
// WHY THE BOUND EXISTS — it is an INJECTIVITY requirement of the replay key,
// not a capacity estimate. `sequence` is contracted as an integer but travels
// as an IEEE-754 binary64 double, which represents integers faithfully only up
// to 2^53 − 1. Above that, DISTINCT integers collapse onto the SAME double —
// `9007199254740992 === 9007199254740993` evaluates to `true` in ECMAScript.
// Two genuinely different events would then carry the same replay key and
// canonicalize to IDENTICAL RFC 8785 bytes. Nothing downstream can detect
// that: by the time a reader sees the value, the two inputs ARE the same
// number. Faithful representation of `sequence` is therefore a PRECONDITION of
// the per-session order being total.
//
// WHY IT IS NAMED rather than left implicit: Zod's `.int()` already bounds the
// safe-integer range, so the parse boundary rejected out-of-range values
// before this const existed — but only as an INCIDENTAL side effect of the
// integer check, reported as a bare "too big", and invisible to anyone reading
// the schema. An intentional bound produces an intentional error and documents
// itself. Enforcement outside the parse boundary is the canonicalizer's, in
// `packages/runtime-daemon/src/events/canonicalizer.ts` — an in-process caller
// that constructs an envelope without parsing reaches the log without ever
// meeting this schema.
//
// NOT A TUNABLE — and this is the one thing a future reader must not get
// wrong. Every other cap this file surfaces (`EVENT_FIELD_MAX_LEN`,
// `EVENT_ENVELOPE_VERSION_MAX_LEN` — both declared on the `./event-core.js`
// leaf and re-exported through the seam above) is a policy knob chosen for
// headroom, raisable as a MINOR widening. This one is not raisable at all: it
// is pinned to a property of the number REPRESENTATION, `.int()` enforces the
// identical ceiling independently so raising this const alone would change
// nothing, and past it distinct sequences stop being distinct. A reader who
// finds the limit inconvenient needs a WIDER WIRE TYPE — a string-encoded
// bigint, the same remedy `pty-host-protocol.ts`'s `DataFrame.seq` note
// reserves against the same hazard — never a larger number here.
//
// Headroom is not the binding constraint regardless: at a sustained one
// million events per second, one session needs ~285 years to reach this
// ceiling.
export const EVENT_ENVELOPE_SEQUENCE_MAX: number = Number.MAX_SAFE_INTEGER;

// Append-time ceiling on `canonical_bytes(row)` — 32 KiB. A SERVICEABILITY
// bound, not hygiene: re-publishes canonical bytes base64-encoded inside a
// chunk riding ONE 64 KB relay frame with no fragmentation or reassembly
// protocol, so an unbounded canonical form would mint rows that can never
// legally travel that seam (32 KiB canonical → ≈43.7 KiB base64 plus origin,
// stub, chunk, and AEAD overhead — inside the frame with headroom). Enforced at
// the sole append path (`event-log-service.ts`, refusing with
// `daemon.event_canonical_bytes_exceeded`) and at the purge's stub construction
// (the projection replaces `payload` after the append check has passed).
// UNLIKE its neighbor above this IS a policy knob: the payload catalog is
// metadata-shaped by construction (content lengths and refs — never inline
// bulk content), so the value is headroom over
// every cataloged shape, and raising it is a coordinated corpus-first edit
// (then here, then both enforcement sites), never a lone constant bump.
export const EVENT_CANONICAL_BYTES_MAX: number = 32768;

/**
 * The daemon-scope sentinel `sessionId` — RFC 9562 section 5.10 Max UUID.
 *
 * NODE-scope events (the four `mcp_governance` types, and every daemon-scope
 * row that describes the machine rather than a conversation) have no owning
 * session, but `session_events` partitions its sequence BY `session_id` and
 * `EventEnvelope.sessionId` is non-nullable. This sentinel is the session
 * those rows bind to: it gives node-scope events a sequence of their own,
 * disjoint from every real session's, with the session-scoped INITIATOR living
 * in the payload (`initiatingSessionId`) rather than in the row's own
 * `sessionId`.
 *
 * Disjointness is structural, not conventional: real session ids are drawn
 * from the v4 space (`gen_random_uuid()`), and the all-ones Max UUID has no
 * valid version nibble, so no real session can ever collide with the sentinel.
 *
 * LOWERCASE IS LOAD-BEARING. Zod's unversioned uuid check reaches the Max UUID
 * only through a lowercase string-literal alternative carrying no `i` flag —
 * its general alternative demands a `[1-8]` version nibble that `f` fails — so
 * `FFFFFFFF-…` is REJECTED even though RFC 9562 section 4 makes UUID text
 * case-insensitive. Producers owe "emit the sentinel LOWERCASE", not merely
 * "emit the sentinel". Minting this constant THROUGH `SessionIdSchema` rather
 * than casting the literal is what keeps that obligation honest: if the check
 * ever stops admitting the Max UUID, this module throws at import — in every
 * consumer, in every test run — instead of the daemon silently emitting a
 * sentinel that no longer parses. The literal is handed to `parse` UNCAST:
 * `parse` takes `unknown`, so a cast here would suppress the very type error
 * that catches a wrong-typed input rather than enable anything.
 */
export const DAEMON_SCOPE_SENTINEL_SESSION_ID: SessionId = SessionIdSchema.parse(
  "ffffffff-ffff-ffff-ffff-ffffffffffff",
);

/**
 * The canonical event message — every session event travels in this
 * envelope ({@link EventEnvelopeSchema} is the runtime validator).
 *
 * Storage mirror: each canonical member maps to a `session_events` column whose
 * column comments mirror this envelope field-by-field (bijection; storage-only
 * columns are deliberately non-members).
 */
export interface EventEnvelope {
  // Opaque on the wire — see the `id` note in `buildCommonShape()`.
  id: string;
  sessionId: SessionId;
  // Daemon-assigned, strictly monotonic per session — the canonical replay
  // key. Bounded above by {@link EVENT_ENVELOPE_SEQUENCE_MAX}: past that
  // value distinct sequences collapse onto one IEEE-754 double, so two
  // different events could share a replay key.
  sequence: number;
  // ISO 8601. The narrower CANONICAL form (RFC 3339 UTC, ms precision) is
  // applied at append time by the event log's normalization, not here.
  occurredAt: string;
  category: EventCategory;
  /**
   * Deliberately `string`, NOT `SessionEventType` — the envelope is the
   * version-tolerant carrier (see the layering note above): a reader must
   * parse an envelope whose `type` it does not know yet in order to
   * persist it as a version stub. Do not "tighten" this member to the
   * census union.
   */
  type: string;
  /**
   * `actor` is `string | null` the zod schema also makes it optional (key may be
   * absent), so we match the inferred output: `actor?: string | null | undefined`. It is
   * the canonical set's only nullable member — present-null and absent are
   * wire-distinguishable. Empty string is rejected — a present-but-empty actor is a
   * producer bug (a system event should send `null` or omit the key, not an empty
   * string).
   */
  actor?: string | null | undefined;
  /**
   * Category-specific fields, open by design (higher-MINOR fields are
   * preserved verbatim) — with one carve-out: an own `__proto__` payload key
   * is rejected loud, because Zod's record parser cannot preserve it and
   * silent stripping is forbidden under the no-collapse rationale (see the
   * pre-guard on {@link EventEnvelopeSchema}). May carry the cross-cutting
   * sourceEpoch + sourcePosition pair; the typed stamp shapes are {@link
   * SourceEpochSchema} / {@link SourcePositionSchema} and the {@link
   * withEpochStamp} composition helper below.
   */
  payload: Record<string, unknown>;
  // Optional, NOT nullable (wire authority: `correlationId?: string`) —
  // absent is the correlation pair's only no-value wire state; `actor`
  // alone carries the null-for-system convention.
  correlationId?: string | undefined;
  causationId?: string | undefined;
  /**
   * Producer-set `"MAJOR.MINOR"` semver string, never numeric on the wire:
   * written by the emitting daemon at emit time, never copied from a
   * received event, and never rewritten on read — upcasters transform the
   * in-memory representation at dispatch time only, so the log row's
   * `.version` is part of the event's durable identity.
   * {@link EventEnvelopeVersion} brand keeps unvalidated strings out.
   */
  version: EventEnvelopeVersion;
}

// --------------------------------------------------------------------------
// Common envelope fields shared by EventEnvelopeSchema and every
// SessionEvent variant.
// --------------------------------------------------------------------------
//
// Defined as a shape factory (not a schema) so the envelope schema and each variant can
// spread it — the envelope supplying the tolerant `category`/`type`/`payload` trio, each
// variant supplying its own `type` literal, its own literal `category`, and its own
// `payload`. `sequence` is the canonical replay key.
//
// Note that `category` is NOT in `buildCommonShape()` — the variants need
// it literal-typed per variant so the parser rejects category/type
// mismatches, while the envelope binds it to the full canonical enum.
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
  // `id`: opaque on the wire (no UUID-format invariant). The daemon assigns UUID v7
  // internally but the wire contract is `id: string`. A future spec edit may tighten
  // this to the branded-id text form; until then, accepting any non-empty bounded string
  // (length cap + whitespace + NUL guards) matches the documented contract.
  id: wireFreeFormString(EVENT_FIELD_MAX_LEN, "EventEnvelope.id"),
  sessionId: SessionIdSchema,
  // `sequence` is a non-negative integer. The daemon assigns a strictly
  // monotonic per-session sequence on append; a gap is a defect.
  //
  // The `.max()` is REDUNDANT with the safe-integer ceiling `.int()` already
  // applies, and that redundancy is the point. It shifts NO accept/reject
  // decision — every value admitted before is admitted now, every value
  // refused before is still refused — so it is not an contract narrowing and
  // needs no MINOR bump. What it changes is the DIAGNOSIS: an over-range
  // `sequence` now reports why the ceiling exists instead of a bare "too big"
  // that reads like an arbitrary limit.
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
      message: `sequence must be at most ${EVENT_ENVELOPE_SEQUENCE_MAX} (Number.MAX_SAFE_INTEGER): above it distinct sequences collapse onto the same IEEE-754 double, so two different events would carry the same replay key.`,
    }),
  // `occurredAt` is ISO 8601. `{ offset: true }` widens default Z-only acceptance to
  // include numeric RFC 3339 section 5.6 offsets ("+00:00", "-05:00"). The narrower
  // CANONICAL form (Z-suffixed UTC, ms precision) is applied at append time by the
  // normalization step, NOT at the wire layer here.
  occurredAt: z.iso.datetime({ offset: true }),
  // `actor` is a user_id, agent_id, or null/absent for system-emitted events ("or
  // null for system"). The helper rejects empty/whitespace-only/NUL strings — a system
  // event must use `null` or omit the key, NOT send an empty string. `.nullable()` is
  // composed AFTER the helper so the inner string checks only run on string values (Zod
  // evaluates the wrapped schema only when the value is a string; `null` short-circuits
  // past the chain).
  actor: wireFreeFormString(EVENT_FIELD_MAX_LEN, "EventEnvelope.actor").nullable().optional(),
  correlationId: wireFreeFormString(EVENT_FIELD_MAX_LEN, "EventEnvelope.correlationId").optional(),
  causationId: wireFreeFormString(EVENT_FIELD_MAX_LEN, "EventEnvelope.causationId").optional(),
  version: EventEnvelopeVersionSchema,
});

/**
 * Runtime validator for the canonical {@link EventEnvelope} carrier — declares
 * exactly the canonical 11-field set serialized order is mandated by RFC 8785
 * section 3.2.3 UTF-16 code-unit lex-sort of member names per that section's
 * amendment (this schema fixes MEMBERSHIP; Phase 2's canonicalizer produces the
 * bytes). `version` remains the branded, producer-set {@link
 * EventEnvelopeVersion} — never rewritten on read.
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
              "EventEnvelope.payload MUST NOT carry an own __proto__ key — the record parser cannot preserve it, and silent stripping is forbidden.",
          });
        }
      })
      .pipe(z.record(z.string(), z.unknown())),
  })
  // Top-level membership is CLOSED even though the carrier is otherwise
  // tolerant — the canonical set is fixed, and stripping an unknown
  // member silently would desync parse output from the hashed canonical
  // bytes. `pii_payload` is the named non-member: a storage column,
  // never an envelope field.
  .strict();

// --------------------------------------------------------------------------
// Cross-cutting epoch-attribution carrier ().
// --------------------------------------------------------------------------
//
// `sourceEpoch` + `sourcePosition` are the ONE cross-cutting payload field
// pair in the taxonomy (registered 2026-07-20): a late-appended
// NON-LIFECYCLE row that the run engine attributes to a SUPERSEDED
// execution epoch carries the pair; a current-epoch row carries neither.
// Absence IS the current-epoch signal — the stamp is never fabricated at
// read time.
//
// PAYLOAD FIELD, NOT AN ENVELOPE FIELD. The pair rides inside `payload`, so it
// sits in the RFC 8785 canonical bytes (shred-safe like any payload field)
// while the canonical envelope member set stays the fixed
// eleven — is untouched and NO version bump is taken. That no-bump path holds
// because the point of no return is an EMISSION event, not a code merge: the
// project is pre-first-release with no production deployment, so no `"1.0"`
// envelope has been emitted in a non-test environment. The pair is therefore
// part of the v1.0 baseline payload contract from first emit. Once a `"1.0"`
// envelope has been emitted, a new optional payload field takes the MINOR
// envelope bump (`"1.1"`) instead.
//
// WRAP ADMISSION — which payload branches take the stamp. Admission is keyed
// on RUN-SCOPEDNESS (the variant's payload carries `runId`), NOT on family
// membership alone: the late-append window covers the four run-scoped
// body-bearing families (`assistant_output`, `tool_activity`,
// `usage_telemetry`, `artifact_publication`), and within them only the
// run-attributed variants admit the pair. A permission ask or a question from
// a superseded epoch is ABSORBED at the epoch check like a lifecycle
// straggler: nothing is appended and the daemon logs it, because such an ask
// never reaches a person. The account-plane
// `usage.rate_limit_update` (no `runId`) is the named exclusion: an epoch
// stamp on a row with no run identity is unattributable by construction.
// `run_lifecycle` branches never admit it either — a lifecycle straggler is
// ABSORBED, never late-appended.
//
// The wrap set holds exactly seven variants: the five body-bearing ones
// registered below — `assistant.message`, `assistant.thinking_update`,
// `tool.invoked`, `tool.result`, `tool.error` — `command.ended` and
// `usage.model_rerouted`, each with a required `runId`. Every other branch
// stays unwrapped: the lifecycle rows (`session.*`, `repo.*`, `workspace.*`,
// `worktree.*`, `cloud.*`), the `interactive_request`, `approval_flow`,
// `security_events` and `mcp_governance` rows, and the daemon-scope
// `event_maintenance` rows sit outside the late-append window; and
// `git.settled` names a run on only some of its causes, so it is not
// run-scoped. Later registrants of the
// families arriving through the union-registration
// seam (class) inherit the admission requirement — a strict payload schema
// that skipped the wrap would REJECT a stamped row at every site that parses
// through the STRICT layer. Scoped honestly: the tolerant
// `EventEnvelopeSchema` carrier accepts a stamped row either way (its
// `payload` is an open record that preserves unknown keys verbatim), so what
// an unwrapped branch costs is INTERPRETATION at the strict layer, not
// transport, append, or the canonical bytes.
// __tests__/event-source-epoch.test.ts walks the live union and fails when a
// run-scoped branch of an admitting family lands unwrapped, or when any other
// branch lands wrapped.
//
// OWNERSHIP BOUNDARY — this file owns the TYPED SHAPE only. Execution-epoch
// semantics (`0` is the pre-any-rollback epoch; the epoch advances with each
// ACCEPTED `run.rolled_back` rewind) belong to `Run State Machine `; the
// stamp's value source is the per-event operation association; the stamping
// and consumption invariants are the (late-event absorption supersede
// marking).

/**
 * The pre-rollback execution epoch a late-appended non-lifecycle row is
 * attributed to — a nonnegative integer, `0` being the pre-any-rollback
 * epoch (owns the advance semantics; see the ownership boundary above).
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
 * The normalized session position (the turn-boundary vocabulary of the
 * `targetPosition`) a stamped row occupies within its source epoch — a
 * nonnegative integer.
 *
 * Registered as the stamp's companion because no run-scoped family's payload
 * carries a native position key, and the supersede cutoff
 * (`turn > targetPosition`) cannot rank a late row against its epoch's
 * surviving prefix without one.
 */
export type SourcePosition = number;
export const SourcePositionSchema: z.ZodType<SourcePosition> = z.number().int().nonnegative();

// The two shared wire literals. Exported as consts — not inlined at each
// use site — because ingestion stamps the pair and the supersede projection
// reads it back, so a rename must move both sides at once. They are the
// registered payload-field names of the stamp.
//
// `as const` rather than a written literal annotation: the literal type stays
// syntactically evident (so `isolatedDeclarations` is satisfied) and the keys
// stay usable as computed property names in the composition helper below.
export const SOURCE_EPOCH_PAYLOAD_KEY = "sourceEpoch" as const;
export const SOURCE_POSITION_PAYLOAD_KEY = "sourcePosition" as const;

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
 *   • `.extend()` preserves the object's catchall config, so a composed
 *     payload rejects unknown keys exactly as it did before — composition
 *     never widens a payload into accepting arbitrary keys (the no-collapse
 *     stance of). Strictness is INHERITED, not imposed: the `$strict`
 *     parameter annotation states the precondition, but Zod's object-config
 *     type parameters are structurally interchangeable, so a caller CAN
 *     pass a non-strict payload and get a non-strict composition back.
 *     Wrapping a non-strict payload is a contract violation the admission
 *     ratchet in __tests__/event-source-epoch.test.ts rejects.
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

// --------------------------------------------------------------------------
// session.created — emitted on session admit.
// --------------------------------------------------------------------------
//
// The payload is session-created.ts's: the new session id (redundant with the
// envelope's `sessionId`, kept for projector convenience), its shape, its lead,
// and the fork parent or tried definition where there is one.

// Variant interfaces extend the canonical EventEnvelope, narrowing the
// tolerant `type` / `category` / `payload` members to the variant's
// literals + typed payload. The subtype relation is compile-checked, with
// scoped reach: ADDING or NARROWING an envelope member ripples into every
// variant schema annotation as a type error, while REMOVING one compiles
// clean (ZodType's output parameter is covariant, so a schema emitting an
// extra property stays assignable to the shrunken interface) — the remove
// direction is caught by the 11-key membership pin in the test suite
// instead. Together they are drift guard.
export interface SessionCreatedEvent extends EventEnvelope {
  type: "session.created";
  category: "session_lifecycle";
  payload: SessionCreatedPayload;
}
export const SessionCreatedEventSchema: z.ZodType<SessionCreatedEvent> = z
  .object({
    ...buildCommonShape(),
    type: z.literal("session.created"),
    category: z.literal("session_lifecycle"),
    payload: SessionCreatedPayloadSchema,
  })
  .strict();

// --------------------------------------------------------------------------
// repo.* / workspace.* — the six lifecycle variants.
// --------------------------------------------------------------------------
//
// All six type strings were ALREADY in the census (`SessionEventType` +
// `SESSION_EVENT_CATEGORY_BY_TYPE`); what lands here is their PAYLOAD
// VARIANTS, which is what moves a type from a registered name the tolerant
// carrier accepts to one the strict layer can interpret.
//
// ONE SHARED PAYLOAD SCHEMA. gives the whole eleven-member family a single
// payload shape, so all six compose the same
// `RepoWorkspaceLifecyclePayloadSchema` (authored in repo.ts per
// emitter-authors-payload — precedent carried forward) rather than six
// copies of one contract. The five `worktree.*` members are registered in
// the block below through carrying the SAME FAMILY SHAPE instantiated over
// its own `WorktreeStateSchema` (the factory path) rather
// than this two-vocabulary instantiation. Import direction is one-way:
// repo.ts imports nothing from this file.
//
// NO EPOCH STAMP. These are `session_lifecycle`, not run-scoped — their
// payload carries no `runId`, so the cross-cutting `sourceEpoch` /
// `sourcePosition` pair would be unattributable and the WRAP ADMISSION note
// above excludes them. __tests__/event-source-epoch.test.ts walks the live
// union and fails a non-admitting branch that lands wrapped.

// Emitted when `repo.attach` admits a local path as a durable repo
// mount.
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

// Emitted when a mount transitions to the terminal `detached`
// state.
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

// Emitted at the head of a (re)provisioning transition — the
// `WorkspaceService.beginRootPreparation`.
export interface WorkspacePreparingEvent extends EventEnvelope {
  type: "workspace.preparing";
  category: "session_lifecycle";
  payload: RepoWorkspaceLifecyclePayload;
}
export const WorkspacePreparingEventSchema: z.ZodType<WorkspacePreparingEvent> = z
  .object({
    ...buildCommonShape(),
    type: z.literal("workspace.preparing"),
    category: z.literal("session_lifecycle"),
    payload: RepoWorkspaceLifecyclePayloadSchema,
  })
  .strict();

// Emitted when provisioning completes and the execution root is bound —
// `WorkspaceService.completeRootPreparation`.
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
// (`WorkspaceService.failRootPreparation`) or a workspace path that became
// unavailable after binding, after which write runs are blocked until
// repair.
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

// Emitted once per dependent workspace archived by the detach
// cascade.
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
// worktree.* — the five lifecycle variants.
// --------------------------------------------------------------------------
//
// All five type strings were ALREADY in the census (`SessionEventType` +
// `SESSION_EVENT_CATEGORY_BY_TYPE`); what lands here is their PAYLOAD
// VARIANTS.
//
// SAME FAMILY, OWN VOCABULARY. These five complete the eleven-member family
// block above began, but they do NOT compose
// `RepoWorkspaceLifecyclePayloadSchema`: their payload is the family factory
// instantiated over the `WorktreeStateSchema` —
// `WorktreeLifecyclePayloadSchema`, authored in worktree.ts per
// emitter-authors-payload — so a worktree event claiming a repo/workspace
// state, or a workspace event claiming `merged`, stays a parse error.
// `worktree.created` and `worktree.retired` extend that payload with the
// members worktree-events.ts declares. Import direction is one-way: neither
// file imports anything from this one.
//
// THE REGISTRY STAYS CLOSED. Five arms, not six: the worktree ROW vocabulary
// has six states, but the `-> failed` transition emits no worktree event
// (the failure incident is already evented as `workspace.stale` by the
// coupled `failRootPreparation`). `worktree.failed` is not a census member and MUST stay
// rejected by `SessionEventSchema` (pinned in __tests__/worktree.test.ts).
//
// NO EPOCH STAMP. `session_lifecycle`, not run-scoped — the same WRAP
// ADMISSION exclusion as the six above; __tests__/event-source-epoch.test.ts
// walks the live union and fails a non-admitting branch that lands wrapped.

// `worktree.created` and `worktree.retired` carry the family payload plus one
// member each, declared in worktree-events.ts: the kept copy a put-back came
// from, and the kept copy a discard left behind.

// Emitted transactionally with worktree row creation.
export interface WorktreeCreatedEvent extends EventEnvelope {
  type: "worktree.created";
  category: "session_lifecycle";
  payload: WorktreeCreatedPayload;
}
export const WorktreeCreatedEventSchema: z.ZodType<WorktreeCreatedEvent> = z
  .object({
    ...buildCommonShape(),
    type: z.literal("worktree.created"),
    category: z.literal("session_lifecycle"),
    payload: WorktreeCreatedPayloadSchema,
  })
  .strict();

// Emitted on the `creating -> ready` transition — the provisioned checkout is
// materialized and bound as an execution root.
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
// checkout.
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
// back.
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
// disk mutation; cleanup is asynchronous and idempotent.
export interface WorktreeRetiredEvent extends EventEnvelope {
  type: "worktree.retired";
  category: "session_lifecycle";
  payload: WorktreeRetiredPayload;
}
export const WorktreeRetiredEventSchema: z.ZodType<WorktreeRetiredEvent> = z
  .object({
    ...buildCommonShape(),
    type: z.literal("worktree.retired"),
    category: z.literal("session_lifecycle"),
    payload: WorktreeRetiredPayloadSchema,
  })
  .strict();

// --------------------------------------------------------------------------
// event_maintenance — the purge receipt.
// --------------------------------------------------------------------------
//
// `event.compacted` was ALREADY in the census (`SessionEventType` +
// `SESSION_EVENT_CATEGORY_BY_TYPE`); what lands here is its PAYLOAD VARIANT,
// declared and exported here because the daemon emits it itself.
//
// ENVELOPE-REDUNDANT MEMBER KEPT. The payload re-spells `occurredAt` alongside
// the envelope's own, transcribed verbatim rather than deduplicated
// (`session.created`'s payload re-spells `sessionId` on the same reasoning).
//
// DAEMON-SCOPE SESSION BINDING IS AN EMITTER OBLIGATION. The receipt is a
// node-level record bound to the reserved RFC 9562 section 5.10 Max UUID
// sentinel `session_id`. The envelope's `sessionId` is `SessionIdSchema`, which
// already admits that sentinel, and no schema-level narrowing to it is taken
// here: an `event.compacted` scoped to ONE session MAY carry that session's id.
//
// NO EPOCH STAMP. It is not run-scoped — its payload carries no `runId` — so
// the WRAP ADMISSION note above excludes it;
// __tests__/event-source-epoch.test.ts walks the live union and fails it if it
// lands wrapped.

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

// The `event_maintenance` payload base — `{nodeId, operationId, occurredAt}`
// verbatim. `occurredAt`
// re-spells the envelope's own (see the envelope-redundant-members note
// above).
const buildEventMaintenanceBaseShape = () => ({
  nodeId: NodeIdSchema,
  // The batch/pass correlation id — Liquibase's `DEPLOYMENT_ID` by precedent.
  // Opaque and bounded free-form; the corpus fixes no format for it.
  operationId: wireFreeFormString(EVENT_FIELD_MAX_LEN, "event_maintenance.operationId"),
  occurredAt: z.iso.datetime({ offset: true }),
});

/** One session a deletion removed, with the range of its rows the deletion stubbed. */
export interface EventCompactedRemovedSession {
  sessionId: SessionId;
  fromSeq: number;
  toSeq: number;
}
const EventCompactedRemovedSessionSchema: z.ZodType<EventCompactedRemovedSession> = z
  .object({
    sessionId: SessionIdSchema,
    fromSeq: payloadSequenceSchema,
    toSeq: payloadSequenceSchema,
  })
  .strict()
  .refine((removed) => removed.fromSeq <= removed.toSeq, {
    message: "a stubbed range starts at or before its end",
    path: ["toSeq"],
  });

/**
 * `event.compacted` — the receipt of one session deletion (`Delete old data`):
 * every session it removed and the range of rows it replaced with audit stubs
 * in each. It is written only when a deletion stubbed rows, so it names at least
 * one session.
 */
export type EventCompactedPayload = {
  nodeId: NodeId;
  operationId: string;
  occurredAt: string;
  removedSessions: EventCompactedRemovedSession[];
};
export const EventCompactedPayloadSchema: z.ZodType<EventCompactedPayload> = z
  .object({
    ...buildEventMaintenanceBaseShape(),
    removedSessions: z.array(EventCompactedRemovedSessionSchema).min(1),
  })
  .strict();

// Emitted once per session deletion that stubbed rows.
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

// --------------------------------------------------------------------------
// Machine-authored content payload — the five body-bearing
// variants.
// --------------------------------------------------------------------------
//
// `assistant.message`, `assistant.thinking_update`, `tool.invoked`,
// `tool.result`, and `tool.error` are the types whose rows carry the prose the
// MACHINE side of a session produced. Until this registration the union
// carried no assistant and no tool variant at all, so both shipped provider
// normalizers resolved every one of these types as payload-variant-pending and
// refused envelope construction: the column that holds the body could be
// created, sealed, and cleared, but never written to.
//
// NO BODY MEMBER, DELIBERATELY. Each payload below declares the DESCRIPTIVE
// members only. The body itself lives in `session_events.content_payload`,
// sealed under the session-scoped content key and excluded from the canonical
// bytes exactly as `pii_payload` is; what rides inside `payload` is the body's
// length and whether it was cut. A reader that wants the prose pairs the event
// with the opened body ({@link HydratedSessionEvent} below). Splicing the body
// INTO `payload` is prohibited rather than merely discouraged: these schemas
// are `.strict()`, so a spliced member fails validation outright.
//
// TWO FAMILIES, NOT ONE SCHEMA. The assistant pair carries `contentType` (the
// body's media type) and no tool identity; the tool trio carries a REQUIRED
// `toolName` beside the optional `toolCallId` / `durationMs` and no
// `contentType`. Collapsing them into one shape would admit a `toolName` on an
// assistant row and a `contentType` on a tool row, neither of which or
// defines.
//
// MEMBER OWNERSHIP SPLITS AT THE SEALING CODEC, and the split is what makes
// the refusal arm below checkable. `contentType` is the PRODUCER's to set — it
// knows the media type of what it emitted. The two members of
// {@link MachineContentDescriptor} are the CODEC's and no one else's: they are
// facts about what it sealed, determined after the plaintext bound was
// applied. A producer that pre-carries either is refused at the write path
// rather than trusted.
//
// WRAPPED, BECAUSE RUN-SCOPED. All five sit in the `assistant_output` /
// `tool_activity` families and all five carry `runId`, so the WRAP ADMISSION
// rule above requires the epoch-stamp pair on every one of them. These are the
// first branches in this union to take it.

/**
 * The payload key carrying the body's PRE-TRUNCATION UTF-8 byte length. Kept
 * at the pre-truncation figure precisely so a truncated row still reports how
 * much was dropped; survives compaction in the audit stub, where it is the
 * whole remaining record of the destroyed body's size.
 */
export const CONTENT_LENGTH_PAYLOAD_KEY = "contentLength" as const;

/**
 * The payload key marking a body stored as a prefix. Present ONLY as `true`
 * and OMITTED when the stored body is complete — never written as `false`.
 * Absence is the completeness signal, and an omitted key keeps the canonical
 * JCS bytes of a complete row byte-identical to what they would be if the
 * bound had never existed.
 */
export const CONTENT_TRUNCATED_PAYLOAD_KEY = "contentTruncated" as const;

/**
 * The per-row plaintext ceiling for `session_events.content_payload` — 262144 bytes (256
 * KiB) of UTF-8.
 *
 * Unlike `pii_payload`, whose size is bounded in practice by human typing, this
 * column admits machine-scale text: a tool result is routinely a file dump or a
 * command's whole stdout. An over-bound body is TRUNCATED at a codepoint
 * boundary — never refused and never dropped — because refusing the append
 * would lose the turn entirely and dropping it would misreport that the turn
 * never happened.
 */
export const CONTENT_PAYLOAD_PLAINTEXT_MAX: number = 262_144;

/**
 * The two codec-owned descriptive members every body-bearing payload carries.
 * Each is OPTIONAL on the wire: a row of one of these five types that carries
 * no body at all (an `assistant.message` whose body the driver could not read,
 * a `tool.invoked` with no arguments) is a valid row, and requiring the members
 * would force its producer to fabricate a length for bytes that do not exist.
 */
// Declared as TYPE ALIASES rather than interfaces, and the difference is
// load-bearing rather than stylistic: `EventEnvelope.payload` is
// `Record<string, unknown>`, and TypeScript grants an implicit index signature
// to object-literal types and their intersections but never to an interface —
// so an interface payload cannot satisfy the envelope it extends.
export type MachineContentDescriptor = {
  /** Pre-truncation UTF-8 byte length of the body that was sealed. */
  contentLength?: number | undefined;
  /** Present as `true` only when the stored body is a prefix; never `false`. */
  contentTruncated?: true | undefined;
};

/** `assistant.message` / `assistant.thinking_update` payload shape. */
export type AssistantOutputPayload = MachineContentDescriptor & {
  sessionId: SessionId;
  runId: string;
  /** Media type of the body, set by the PRODUCER and not by the codec. */
  contentType?: string | undefined;
  sourceEpoch?: SourceEpoch | undefined;
  sourcePosition?: SourcePosition | undefined;
};

/** `tool.invoked` / `tool.result` / `tool.error` payload shape. */
export type ToolActivityPayload = MachineContentDescriptor & {
  sessionId: SessionId;
  runId: string;
  /**
   * A tool row with no tool name is unattributable — every consumer of keys on it —
   * and unlike the descriptive members it is never something the codec could supply.
   */
  toolName: string;
  toolCallId?: string | undefined;
  durationMs?: number | undefined;
  sourceEpoch?: SourceEpoch | undefined;
  sourcePosition?: SourcePosition | undefined;
};

// Shared shape factories, the `buildCommonShape()` principle applied one level
// down: the five payload schemas below and the five union branches share these
// two, so a member cannot drift between the assistant pair or across the tool
// trio.
const buildMachineContentDescriptorShape = () => ({
  contentLength: z.number().int().nonnegative().optional(),
  // `z.literal(true)` rather than `z.boolean()`: the omit-never-false rule is
  // a wire contract (a `false` on the wire would canonicalize into bytes a
  // complete row must not have), so it is enforced at parse rather than
  // narrated.
  contentTruncated: z.literal(true).optional(),
});

const buildAssistantOutputPayloadShape = () => ({
  sessionId: SessionIdSchema,
  // A bounded free-form guard, the one `EventEnvelope.id` takes, rather than
  // the branded `RunIdSchema` from provider-driver.ts that
  // `usage.model_rerouted` below uses.
  runId: wireFreeFormString(EVENT_FIELD_MAX_LEN, "assistant output payload runId"),
  contentType: wireFreeFormString(
    EVENT_FIELD_MAX_LEN,
    "assistant output payload contentType",
  ).optional(),
  ...buildMachineContentDescriptorShape(),
});

const buildToolActivityPayloadShape = () => ({
  sessionId: SessionIdSchema,
  runId: wireFreeFormString(EVENT_FIELD_MAX_LEN, "tool activity payload runId"),
  toolName: wireFreeFormString(EVENT_FIELD_MAX_LEN, "tool activity payload toolName"),
  toolCallId: wireFreeFormString(
    EVENT_FIELD_MAX_LEN,
    "tool activity payload toolCallId",
  ).optional(),
  durationMs: z.number().int().nonnegative().optional(),
  ...buildMachineContentDescriptorShape(),
});

const assistantMessagePayloadSchema = withEpochStamp(
  z.object(buildAssistantOutputPayloadShape()).strict(),
);
const assistantThinkingUpdatePayloadSchema = withEpochStamp(
  z.object(buildAssistantOutputPayloadShape()).strict(),
);
const toolInvokedPayloadSchema = withEpochStamp(z.object(buildToolActivityPayloadShape()).strict());
const toolResultPayloadSchema = withEpochStamp(z.object(buildToolActivityPayloadShape()).strict());
const toolErrorPayloadSchema = withEpochStamp(z.object(buildToolActivityPayloadShape()).strict());

export interface AssistantMessageEvent extends EventEnvelope {
  type: "assistant.message";
  category: "assistant_output";
  payload: AssistantOutputPayload;
}
export const AssistantMessageEventSchema: z.ZodType<AssistantMessageEvent> = z
  .object({
    ...buildCommonShape(),
    type: z.literal("assistant.message"),
    category: z.literal("assistant_output"),
    payload: assistantMessagePayloadSchema,
  })
  .strict();

export interface AssistantThinkingUpdateEvent extends EventEnvelope {
  type: "assistant.thinking_update";
  category: "assistant_output";
  payload: AssistantOutputPayload;
}
export const AssistantThinkingUpdateEventSchema: z.ZodType<AssistantThinkingUpdateEvent> = z
  .object({
    ...buildCommonShape(),
    type: z.literal("assistant.thinking_update"),
    category: z.literal("assistant_output"),
    payload: assistantThinkingUpdatePayloadSchema,
  })
  .strict();

export interface ToolInvokedEvent extends EventEnvelope {
  type: "tool.invoked";
  category: "tool_activity";
  payload: ToolActivityPayload;
}
export const ToolInvokedEventSchema: z.ZodType<ToolInvokedEvent> = z
  .object({
    ...buildCommonShape(),
    type: z.literal("tool.invoked"),
    category: z.literal("tool_activity"),
    payload: toolInvokedPayloadSchema,
  })
  .strict();

export interface ToolResultEvent extends EventEnvelope {
  type: "tool.result";
  category: "tool_activity";
  payload: ToolActivityPayload;
}
export const ToolResultEventSchema: z.ZodType<ToolResultEvent> = z
  .object({
    ...buildCommonShape(),
    type: z.literal("tool.result"),
    category: z.literal("tool_activity"),
    payload: toolResultPayloadSchema,
  })
  .strict();

export interface ToolErrorEvent extends EventEnvelope {
  type: "tool.error";
  category: "tool_activity";
  payload: ToolActivityPayload;
}
export const ToolErrorEventSchema: z.ZodType<ToolErrorEvent> = z
  .object({
    ...buildCommonShape(),
    type: z.literal("tool.error"),
    category: z.literal("tool_activity"),
    payload: toolErrorPayloadSchema,
  })
  .strict();

// --------------------------------------------------------------------------
// The variants whose payload a contract of its own declares.
// --------------------------------------------------------------------------
//
// Each payload below is declared beside the method or record that produces it
// (`approval.ts`, `plan.ts`, `question.ts`, `session-controls.ts` and the rest)
// and imported here, the rule the repo, workspace and worktree families
// already follow: the emitter's contract authors the payload.
// `usage.model_rerouted` is declared here, since no other contract states it;
// it is built by the same builder.
//
// TWO EPOCH STAMPS. `command.ended` (`tool_activity`) and `usage.model_rerouted`
// (`usage_telemetry`) are the run-scoped members of a late-append family here,
// each with a required `runId`, so they alone take `withEpochStamp`. The
// `approval_flow`, `session_lifecycle`, `interactive_request`,
// `security_events` and `mcp_governance` variants are outside the late-append
// window; and `git.settled` names a run on only some of its causes.
//
// ONE BUILDER, NO SECOND COPY. Each arm is built once by
// `buildSessionEventVariantSchema` and registered in the union directly: the
// builder is not exported, so its inferred return type keeps the literal `type`
// the discriminated union dispatches on, and nothing has to be rebuilt for the
// union. The builder also takes its category as the registry's own entry for
// the type, so an arm filed under another category is a compile error. These
// variants export their event type and no standalone schema;
// `SessionEventSchema` is where they parse.

/**
 * A session event whose payload a contract of its own declares: the envelope
 * with `type`, `category` and `payload` narrowed to one variant.
 *
 * `payload` is the payload's members mapped into an object type. The envelope's
 * `payload` is `Record<string, unknown>`, and TypeScript grants the implicit
 * index signature that needs to an object type but never to an interface, so
 * mapping here lets an owning contract declare its payload either way.
 */
export interface SessionEventVariant<
  TType extends SessionEventType,
  TCategory extends EventCategory,
  TPayload extends object,
> extends EventEnvelope {
  type: TType;
  category: TCategory;
  payload: { [Member in keyof TPayload]: TPayload[Member] };
}

const buildSessionEventVariantSchema = <
  TType extends SessionEventType,
  TPayload extends z.ZodType<object>,
>(
  type: TType,
  category: (typeof SESSION_EVENT_CATEGORY_RECORD)[TType],
  payload: TPayload,
) =>
  z
    .object({
      ...buildCommonShape(),
      type: z.literal(type),
      category: z.literal(category),
      payload,
    })
    .strict();

export type ApprovalRejectedEvent = SessionEventVariant<
  "approval.rejected",
  "approval_flow",
  ApprovalResolvedPayload
>;
export type ApprovalCanceledEvent = SessionEventVariant<
  "approval.canceled",
  "approval_flow",
  ApprovalCanceledPayload
>;
export type ApprovalRememberedEvent = SessionEventVariant<
  "approval.remembered",
  "approval_flow",
  ApprovalRememberedPayload
>;
export type ApprovalRuleRevokedEvent = SessionEventVariant<
  "approval.rule_revoked",
  "approval_flow",
  ApprovalRuleRevokedPayload
>;
export type ModerationReviewFlaggedEvent = SessionEventVariant<
  "moderation.review_flagged",
  "approval_flow",
  ModerationReviewFlaggedPayload
>;
export type PlanProposedEvent = SessionEventVariant<
  "plan.proposed",
  "approval_flow",
  PlanProposedPayload
>;
export type PlanAcceptedEvent = SessionEventVariant<
  "plan.accepted",
  "approval_flow",
  PlanAcceptedPayload
>;
export type PlanHandedOffEvent = SessionEventVariant<
  "plan.handed_off",
  "approval_flow",
  PlanHandedOffPayload
>;
export type QuestionAskedEvent = SessionEventVariant<
  "question.asked",
  "interactive_request",
  QuestionAskedPayload
>;
export type McpServerStatusChangedEvent = SessionEventVariant<
  "mcp.server_status_changed",
  "mcp_governance",
  McpServerStatusChangedPayload
>;
export type McpServerConfigChangedEvent = SessionEventVariant<
  "mcp.server_config_changed",
  "mcp_governance",
  McpServerConfigChangedPayload
>;
export type McpServerTrustChangedEvent = SessionEventVariant<
  "mcp.server_trust_changed",
  "mcp_governance",
  McpServerTrustChangedPayload
>;
export type McpToolOverrideChangedEvent = SessionEventVariant<
  "mcp.tool_override_changed",
  "mcp_governance",
  McpToolOverrideChangedPayload
>;
export type McpServerOauthCompletedEvent = SessionEventVariant<
  "mcp.server_oauth_completed",
  "mcp_governance",
  McpServerOauthCompletedPayload
>;
export type CloudTaskUpdatedEvent = SessionEventVariant<
  "cloud.task_updated",
  "session_lifecycle",
  CloudTaskUpdatedPayload
>;
export type SessionRestoreFinishedEvent = SessionEventVariant<
  "session.restore_finished",
  "session_lifecycle",
  SessionRestoreFinishedPayload
>;
export type SessionGoalClearedEvent = SessionEventVariant<
  "session.goal_cleared",
  "session_lifecycle",
  SessionGoalClearedPayload
>;
export type SessionNoticeEvent = SessionEventVariant<
  "session.notice",
  "session_lifecycle",
  SessionNoticePayload
>;
export type SessionSideQuestionAnsweredEvent = SessionEventVariant<
  "session.side_question_answered",
  "session_lifecycle",
  SessionSideQuestionAnsweredPayload
>;
export type GitSettledEvent = SessionEventVariant<
  "git.settled",
  "artifact_publication",
  GitSettledPayload
>;
export type RelayPinRefusedEvent = SessionEventVariant<
  "relay.pin_refused",
  "security_events",
  RelayPinRefusedPayload
>;
export type CommandEndedEvent = SessionEventVariant<
  "command.ended",
  "tool_activity",
  CommandEndedPayload & {
    sourceEpoch?: SourceEpoch | undefined;
    sourcePosition?: SourcePosition | undefined;
  }
>;

/**
 * `usage.model_rerouted`: the provider moved a turn onto another model and the
 * turn went on. `scope` says how long the switch holds — this turn, the rest
 * of the session, or only a subagent's, a side question's or a background
 * fork's response (`local`). `sentence` and `explanation` are the provider's
 * own words when it sends them; `safetyCategory` names the check's category
 * when the provider reports one.
 */
export type UsageModelReroutedPayload = {
  sessionId: SessionId;
  runId: RunId;
  agentId?: string | undefined;
  fromModel: string;
  toModel: string;
  scope: "turn" | "session" | "local";
  sentence?: string | undefined;
  explanation?: string | undefined;
  cause: "safety" | "model_unavailable" | "model_blocked" | "out_of_credits";
  safetyCategory?: string | undefined;
};
export type UsageModelReroutedEvent = SessionEventVariant<
  "usage.model_rerouted",
  "usage_telemetry",
  UsageModelReroutedPayload & {
    sourceEpoch?: SourceEpoch | undefined;
    sourcePosition?: SourcePosition | undefined;
  }
>;
export type SessionArchivedEvent = SessionEventVariant<
  "session.archived",
  "session_lifecycle",
  SessionLifecycleChangePayload
>;
export type SessionReactivatedEvent = SessionEventVariant<
  "session.reactivated",
  "session_lifecycle",
  SessionLifecycleChangePayload
>;
export type SessionClosedEvent = SessionEventVariant<
  "session.closed",
  "session_lifecycle",
  SessionLifecycleChangePayload
>;
export type SessionPinnedEvent = SessionEventVariant<
  "session.pinned",
  "session_lifecycle",
  SessionMarkChangePayload
>;
export type SessionUnpinnedEvent = SessionEventVariant<
  "session.unpinned",
  "session_lifecycle",
  SessionMarkChangePayload
>;
export type SessionMutedEvent = SessionEventVariant<
  "session.muted",
  "session_lifecycle",
  SessionMarkChangePayload
>;
export type SessionUnmutedEvent = SessionEventVariant<
  "session.unmuted",
  "session_lifecycle",
  SessionMarkChangePayload
>;
export type SessionConvertedEvent = SessionEventVariant<
  "session.converted",
  "session_lifecycle",
  SessionConvertedPayload
>;
export type SessionBranchChangedEvent = SessionEventVariant<
  "session.branch_changed",
  "session_lifecycle",
  SessionBranchChangedPayload
>;
export type SessionSweptToRepoRootEvent = SessionEventVariant<
  "session.swept_to_repo_root",
  "session_lifecycle",
  SessionSweptToRepoRootPayload
>;
export type AgentProviderBindingChangedEvent = SessionEventVariant<
  "agent.provider_binding_changed",
  "session_lifecycle",
  AgentProviderBindingChangedPayload
>;
export type AgentProviderBindingChangeFailedEvent = SessionEventVariant<
  "agent.provider_binding_change_failed",
  "session_lifecycle",
  AgentProviderBindingChangeFailedPayload
>;
export type ApprovalRequestedEvent = SessionEventVariant<
  "approval.requested",
  "approval_flow",
  ApprovalRequestedPayload
>;
export type ApprovalApprovedEvent = SessionEventVariant<
  "approval.approved",
  "approval_flow",
  ApprovalResolvedPayload
>;
/**
 * `approval.reviewer_denied` carries the provider's own denial as its sealed body,
 * so its payload takes the codec's content members beside the owner's.
 */
export type ApprovalReviewerDeniedEvent = SessionEventVariant<
  "approval.reviewer_denied",
  "approval_flow",
  ApprovalReviewerDeniedPayload & MachineContentDescriptor
>;
export type ApprovalDenialOverriddenEvent = SessionEventVariant<
  "approval.denial_overridden",
  "approval_flow",
  ApprovalDenialOverriddenPayload
>;
export type RunQueuedEvent = SessionEventVariant<"run.queued", "run_lifecycle", RunQueuedPayload>;
export type RunStepLimitReachedEvent = SessionEventVariant<
  "run.step_limit_reached",
  "run_lifecycle",
  RunStepLimitReachedPayload
>;
export type RunRecoveryResolvedEvent = SessionEventVariant<
  "run.recovery_resolved",
  "run_lifecycle",
  RunRecoveryResolvedPayload
>;
export type SessionGoalUpdatedEvent = SessionEventVariant<
  "session.goal_updated",
  "session_lifecycle",
  SessionGoalUpdatedPayload
>;
export type SessionRenamedEvent = SessionEventVariant<
  "session.renamed",
  "session_lifecycle",
  SessionRenamedPayload
>;
export type PtyControlChangedEvent = SessionEventVariant<
  "pty.control_changed",
  "session_lifecycle",
  PtyControlChangedPayload
>;
export type WorkflowStartedEvent = SessionEventVariant<
  "workflow.started",
  "workflow_lifecycle",
  WorkflowStartedPayload
>;
export type WorkflowResumedEvent = SessionEventVariant<
  "workflow.resumed",
  "workflow_lifecycle",
  WorkflowResumedPayload
>;
export type WorkflowCanceledEvent = SessionEventVariant<
  "workflow.canceled",
  "workflow_lifecycle",
  WorkflowCanceledPayload
>;
export type WorkflowResultsPostedEvent = SessionEventVariant<
  "workflow.results_posted",
  "workflow_lifecycle",
  WorkflowResultsPostedPayload
>;
export type WorkflowStepStartedEvent = SessionEventVariant<
  "workflow.step_started",
  "workflow_phase_lifecycle",
  WorkflowStepStartedPayload
>;
export type WorkflowStepFinishedEvent = SessionEventVariant<
  "workflow.step_finished",
  "workflow_phase_lifecycle",
  WorkflowStepFinishedPayload
>;
export type WorkflowStepFailedEvent = SessionEventVariant<
  "workflow.step_failed",
  "workflow_phase_lifecycle",
  WorkflowStepFailedPayload
>;
export type WorkflowStepCanceledEvent = SessionEventVariant<
  "workflow.step_canceled",
  "workflow_phase_lifecycle",
  WorkflowStepEventPayload
>;
export type WorkflowStepSkippedEvent = SessionEventVariant<
  "workflow.step_skipped",
  "workflow_phase_lifecycle",
  WorkflowStepSkippedPayload
>;
export type WorkflowGateResolvedEvent = SessionEventVariant<
  "workflow.gate_resolved",
  "workflow_gate_resolution",
  WorkflowGateResolvedPayload
>;
export type BackupCompletedEvent = SessionEventVariant<
  "backup.completed",
  "event_maintenance",
  BackupCompletedPayload
>;
export type BackupFailedEvent = SessionEventVariant<
  "backup.failed",
  "event_maintenance",
  BackupFailedPayload
>;
export type BackupRestoredEvent = SessionEventVariant<
  "backup.restored",
  "event_maintenance",
  BackupRestoredPayload
>;

// `withEpochStamp` takes the strict ZodObject its generic constraint checks,
// and the imported schema is annotated `z.ZodType<T>`, which erases that
// surface. It is that strict object at runtime, so the surface is re-widened for
// the call and the result annotated with the payload the composition produces.
const commandEndedVariantPayloadSchema = withEpochStamp(
  CommandEndedPayloadSchema as unknown as z.ZodObject<Record<never, never>, z.core.$strict>,
) as unknown as z.ZodType<CommandEndedEvent["payload"]>;

const usageModelReroutedVariantPayloadSchema = withEpochStamp(
  z
    .object({
      sessionId: SessionIdSchema,
      runId: RunIdSchema,
      agentId: uuidTextFormSchema.optional(),
      fromModel: wireFreeFormString(EVENT_FIELD_MAX_LEN, "UsageModelReroutedPayload.fromModel"),
      toModel: wireFreeFormString(EVENT_FIELD_MAX_LEN, "UsageModelReroutedPayload.toModel"),
      scope: z.enum(["turn", "session", "local"]),
      sentence: wireFreeFormString(
        DRIVER_FAILURE_DETAIL_MAX_LEN,
        "UsageModelReroutedPayload.sentence",
      ).optional(),
      explanation: wireFreeFormString(
        DRIVER_FAILURE_DETAIL_MAX_LEN,
        "UsageModelReroutedPayload.explanation",
      ).optional(),
      cause: z.enum(["safety", "model_unavailable", "model_blocked", "out_of_credits"]),
      safetyCategory: wireFreeFormString(
        EVENT_FIELD_MAX_LEN,
        "UsageModelReroutedPayload.safetyCategory",
      ).optional(),
    })
    .strict(),
);

const approvalRejectedVariantSchema = buildSessionEventVariantSchema(
  "approval.rejected",
  "approval_flow",
  ApprovalResolvedPayloadSchema,
);
const approvalCanceledVariantSchema = buildSessionEventVariantSchema(
  "approval.canceled",
  "approval_flow",
  ApprovalCanceledPayloadSchema,
);
const approvalRememberedVariantSchema = buildSessionEventVariantSchema(
  "approval.remembered",
  "approval_flow",
  ApprovalRememberedPayloadSchema,
);
const approvalRuleRevokedVariantSchema = buildSessionEventVariantSchema(
  "approval.rule_revoked",
  "approval_flow",
  ApprovalRuleRevokedPayloadSchema,
);
const moderationReviewFlaggedVariantSchema = buildSessionEventVariantSchema(
  "moderation.review_flagged",
  "approval_flow",
  ModerationReviewFlaggedPayloadSchema,
);
const planProposedVariantSchema = buildSessionEventVariantSchema(
  "plan.proposed",
  "approval_flow",
  PlanProposedPayloadSchema,
);
const planAcceptedVariantSchema = buildSessionEventVariantSchema(
  "plan.accepted",
  "approval_flow",
  PlanAcceptedPayloadSchema,
);
const planHandedOffVariantSchema = buildSessionEventVariantSchema(
  "plan.handed_off",
  "approval_flow",
  PlanHandedOffPayloadSchema,
);
const questionAskedVariantSchema = buildSessionEventVariantSchema(
  "question.asked",
  "interactive_request",
  QuestionAskedPayloadSchema,
);
const mcpServerStatusChangedVariantSchema = buildSessionEventVariantSchema(
  "mcp.server_status_changed",
  "mcp_governance",
  McpServerStatusChangedPayloadSchema,
);
const mcpServerConfigChangedVariantSchema = buildSessionEventVariantSchema(
  "mcp.server_config_changed",
  "mcp_governance",
  McpServerConfigChangedPayloadSchema,
);
const mcpServerTrustChangedVariantSchema = buildSessionEventVariantSchema(
  "mcp.server_trust_changed",
  "mcp_governance",
  McpServerTrustChangedPayloadSchema,
);
const mcpToolOverrideChangedVariantSchema = buildSessionEventVariantSchema(
  "mcp.tool_override_changed",
  "mcp_governance",
  McpToolOverrideChangedPayloadSchema,
);
const mcpServerOauthCompletedVariantSchema = buildSessionEventVariantSchema(
  "mcp.server_oauth_completed",
  "mcp_governance",
  McpServerOauthCompletedPayloadSchema,
);
const cloudTaskUpdatedVariantSchema = buildSessionEventVariantSchema(
  "cloud.task_updated",
  "session_lifecycle",
  CloudTaskUpdatedPayloadSchema,
);
const sessionRestoreFinishedVariantSchema = buildSessionEventVariantSchema(
  "session.restore_finished",
  "session_lifecycle",
  SessionRestoreFinishedPayloadSchema,
);
const sessionGoalClearedVariantSchema = buildSessionEventVariantSchema(
  "session.goal_cleared",
  "session_lifecycle",
  SessionGoalClearedPayloadSchema,
);
const sessionNoticeVariantSchema = buildSessionEventVariantSchema(
  "session.notice",
  "session_lifecycle",
  SessionNoticePayloadSchema,
);
const sessionSideQuestionAnsweredVariantSchema = buildSessionEventVariantSchema(
  "session.side_question_answered",
  "session_lifecycle",
  SessionSideQuestionAnsweredPayloadSchema,
);
const gitSettledVariantSchema = buildSessionEventVariantSchema(
  "git.settled",
  "artifact_publication",
  GitSettledPayloadSchema,
);
const relayPinRefusedVariantSchema = buildSessionEventVariantSchema(
  "relay.pin_refused",
  "security_events",
  RelayPinRefusedPayloadSchema,
);
const commandEndedVariantSchema = buildSessionEventVariantSchema(
  "command.ended",
  "tool_activity",
  commandEndedVariantPayloadSchema,
);
const sessionArchivedVariantSchema = buildSessionEventVariantSchema(
  "session.archived",
  "session_lifecycle",
  SessionLifecycleChangePayloadSchema,
);
const sessionReactivatedVariantSchema = buildSessionEventVariantSchema(
  "session.reactivated",
  "session_lifecycle",
  SessionLifecycleChangePayloadSchema,
);
const sessionClosedVariantSchema = buildSessionEventVariantSchema(
  "session.closed",
  "session_lifecycle",
  SessionLifecycleChangePayloadSchema,
);
const sessionPinnedVariantSchema = buildSessionEventVariantSchema(
  "session.pinned",
  "session_lifecycle",
  SessionMarkChangePayloadSchema,
);
const sessionUnpinnedVariantSchema = buildSessionEventVariantSchema(
  "session.unpinned",
  "session_lifecycle",
  SessionMarkChangePayloadSchema,
);
const sessionMutedVariantSchema = buildSessionEventVariantSchema(
  "session.muted",
  "session_lifecycle",
  SessionMarkChangePayloadSchema,
);
const sessionUnmutedVariantSchema = buildSessionEventVariantSchema(
  "session.unmuted",
  "session_lifecycle",
  SessionMarkChangePayloadSchema,
);
const usageModelReroutedVariantSchema = buildSessionEventVariantSchema(
  "usage.model_rerouted",
  "usage_telemetry",
  usageModelReroutedVariantPayloadSchema,
);
const sessionConvertedVariantSchema = buildSessionEventVariantSchema(
  "session.converted",
  "session_lifecycle",
  SessionConvertedPayloadSchema,
);
const sessionBranchChangedVariantSchema = buildSessionEventVariantSchema(
  "session.branch_changed",
  "session_lifecycle",
  SessionBranchChangedPayloadSchema,
);
const sessionSweptToRepoRootVariantSchema = buildSessionEventVariantSchema(
  "session.swept_to_repo_root",
  "session_lifecycle",
  SessionSweptToRepoRootPayloadSchema,
);
const agentProviderBindingChangedVariantSchema = buildSessionEventVariantSchema(
  "agent.provider_binding_changed",
  "session_lifecycle",
  AgentProviderBindingChangedPayloadSchema,
);
const agentProviderBindingChangeFailedVariantSchema = buildSessionEventVariantSchema(
  "agent.provider_binding_change_failed",
  "session_lifecycle",
  AgentProviderBindingChangeFailedPayloadSchema,
);
const approvalRequestedVariantSchema = buildSessionEventVariantSchema(
  "approval.requested",
  "approval_flow",
  ApprovalRequestedPayloadSchema,
);
const approvalApprovedVariantSchema = buildSessionEventVariantSchema(
  "approval.approved",
  "approval_flow",
  ApprovalResolvedPayloadSchema,
);
// The owner's schema is annotated `z.ZodType<T>`, which erases the object surface
// `.extend()` needs; it is a strict object at runtime, so the surface is re-widened
// for the call and the result annotated with the payload the composition produces.
const approvalReviewerDeniedVariantPayloadSchema = (
  ApprovalReviewerDeniedPayloadSchema as unknown as z.ZodObject<
    Record<never, never>,
    z.core.$strict
  >
).extend(buildMachineContentDescriptorShape()) as unknown as z.ZodType<
  ApprovalReviewerDeniedEvent["payload"]
>;
const approvalReviewerDeniedVariantSchema = buildSessionEventVariantSchema(
  "approval.reviewer_denied",
  "approval_flow",
  approvalReviewerDeniedVariantPayloadSchema,
);
const approvalDenialOverriddenVariantSchema = buildSessionEventVariantSchema(
  "approval.denial_overridden",
  "approval_flow",
  ApprovalDenialOverriddenPayloadSchema,
);
const runQueuedVariantSchema = buildSessionEventVariantSchema(
  "run.queued",
  "run_lifecycle",
  RunQueuedPayloadSchema,
);
const runStepLimitReachedVariantSchema = buildSessionEventVariantSchema(
  "run.step_limit_reached",
  "run_lifecycle",
  RunStepLimitReachedPayloadSchema,
);
const runRecoveryResolvedVariantSchema = buildSessionEventVariantSchema(
  "run.recovery_resolved",
  "run_lifecycle",
  RunRecoveryResolvedPayloadSchema,
);
const sessionGoalUpdatedVariantSchema = buildSessionEventVariantSchema(
  "session.goal_updated",
  "session_lifecycle",
  SessionGoalUpdatedPayloadSchema,
);
const sessionRenamedVariantSchema = buildSessionEventVariantSchema(
  "session.renamed",
  "session_lifecycle",
  SessionRenamedPayloadSchema,
);
const ptyControlChangedVariantSchema = buildSessionEventVariantSchema(
  "pty.control_changed",
  "session_lifecycle",
  PtyControlChangedPayloadSchema,
);
const workflowStartedVariantSchema = buildSessionEventVariantSchema(
  "workflow.started",
  "workflow_lifecycle",
  WorkflowStartedPayloadSchema,
);
const workflowResumedVariantSchema = buildSessionEventVariantSchema(
  "workflow.resumed",
  "workflow_lifecycle",
  WorkflowResumedPayloadSchema,
);
const workflowCanceledVariantSchema = buildSessionEventVariantSchema(
  "workflow.canceled",
  "workflow_lifecycle",
  WorkflowCanceledPayloadSchema,
);
const workflowResultsPostedVariantSchema = buildSessionEventVariantSchema(
  "workflow.results_posted",
  "workflow_lifecycle",
  WorkflowResultsPostedPayloadSchema,
);
const workflowStepStartedVariantSchema = buildSessionEventVariantSchema(
  "workflow.step_started",
  "workflow_phase_lifecycle",
  WorkflowStepStartedPayloadSchema,
);
const workflowStepFinishedVariantSchema = buildSessionEventVariantSchema(
  "workflow.step_finished",
  "workflow_phase_lifecycle",
  WorkflowStepFinishedPayloadSchema,
);
const workflowStepFailedVariantSchema = buildSessionEventVariantSchema(
  "workflow.step_failed",
  "workflow_phase_lifecycle",
  WorkflowStepFailedPayloadSchema,
);
const workflowStepCanceledVariantSchema = buildSessionEventVariantSchema(
  "workflow.step_canceled",
  "workflow_phase_lifecycle",
  WorkflowStepCanceledPayloadSchema,
);
const workflowStepSkippedVariantSchema = buildSessionEventVariantSchema(
  "workflow.step_skipped",
  "workflow_phase_lifecycle",
  WorkflowStepSkippedPayloadSchema,
);
const workflowGateResolvedVariantSchema = buildSessionEventVariantSchema(
  "workflow.gate_resolved",
  "workflow_gate_resolution",
  WorkflowGateResolvedPayloadSchema,
);
const backupCompletedVariantSchema = buildSessionEventVariantSchema(
  "backup.completed",
  "event_maintenance",
  BackupCompletedPayloadSchema,
);
const backupFailedVariantSchema = buildSessionEventVariantSchema(
  "backup.failed",
  "event_maintenance",
  BackupFailedPayloadSchema,
);
const backupRestoredVariantSchema = buildSessionEventVariantSchema(
  "backup.restored",
  "event_maintenance",
  BackupRestoredPayloadSchema,
);

// --------------------------------------------------------------------------
// HydratedSessionEvent — the read projection that pairs a stored row with
// its opened body.
// --------------------------------------------------------------------------
//
// The whole point of the type is that `event` and `content` are SEPARATE
// members. The body is never merged into `event.payload`: the body-bearing
// payload schemas are strict and declare no body member, so a merge would add
// an undeclared member that fails validation.
//
// `event` is typed as the tolerant {@link EventEnvelope} rather than the strict
// {@link SessionEvent} union deliberately: a stored row is rebuilt through the
// envelope carrier, and narrowing to the strict union is a separate step the
// caller chooses. Typing the projection on the union would force every reader
// to re-parse a row before it could ask whether the body opened.

/**
 * Why a body is not available — a CLOSED set, because the read path exists to
 * replace "the key is missing, therefore assume loss" with a reason a caller
 * can act on. `absent` and `purged` in particular are distinguishable only
 * from the row's retention class, which is why the reader takes it as input.
 */
export type HydratedContentUnavailableReason =
  /** The row never carried a body: live row, NULL column. */
  | "absent"
  /** The session was deleted; its row is a stub and the body went with it. */
  | "purged"
  /** The daemon master key could not be obtained, so no wrapped key opens. */
  | "master_key_unavailable"
  /** The session has a sealed body but no wrapped key row to open it with. */
  | "wrapped_key_missing"
  /**
   * Sealed material refused to open. Covers the session key's own envelope
   * (wrong master, a blob moved between rows, a replay under a superseded key
   * version) as well as the body ciphertext failing its AEAD tag or decoding to
   * invalid UTF-8 — the AEAD refuses these identically, and guessing between
   * them here would put a cause in the record that nothing established.
   */
  | "decrypt_failed";

/** The closed two-arm content union of a {@link HydratedSessionEvent}. */
export type HydratedSessionEventContent =
  | {
      readonly status: "available";
      /** The opened body — a PREFIX when `contentTruncated` is `true`. */
      readonly body: string;
      /** Echoed from the stored payload, never recomputed from `body`. */
      readonly contentLength?: number | undefined;
      readonly contentTruncated?: true | undefined;
    }
  | {
      readonly status: "unavailable";
      readonly reason: HydratedContentUnavailableReason;
    };

/**
 * A stored event paired with its machine-authored body — never a mutated
 * event.
 */
export interface HydratedSessionEvent {
  /** Byte-identical to the stored row. */
  readonly event: EventEnvelope;
  readonly content: HydratedSessionEventContent;
}

// --------------------------------------------------------------------------
// SessionEvent — discriminated union over `type`.
// --------------------------------------------------------------------------
//
// `z.discriminatedUnion` requires every variant to be a literal-typed
// ZodObject sharing the same discriminator key. This gives O(1) parse-time
// dispatch and narrowed inferred types at the consumption site
// (e.g. `if (e.type === "session.created") e.payload.mainAgent // typed`).
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
  | RepoAttachedEvent
  | RepoDetachedEvent
  | WorkspacePreparingEvent
  | WorkspaceReadyEvent
  | WorkspaceStaleEvent
  | WorkspaceArchivedEvent
  | WorktreeCreatedEvent
  | WorktreeReadyEvent
  | WorktreeDirtyEvent
  | WorktreeMergedEvent
  | WorktreeRetiredEvent
  | EventCompactedEvent
  | AssistantMessageEvent
  | AssistantThinkingUpdateEvent
  | ToolInvokedEvent
  | ToolResultEvent
  | ToolErrorEvent
  | ApprovalRejectedEvent
  | ApprovalCanceledEvent
  | ApprovalRememberedEvent
  | ApprovalRuleRevokedEvent
  | ModerationReviewFlaggedEvent
  | PlanProposedEvent
  | PlanAcceptedEvent
  | PlanHandedOffEvent
  | QuestionAskedEvent
  | McpServerStatusChangedEvent
  | McpServerConfigChangedEvent
  | McpServerTrustChangedEvent
  | McpToolOverrideChangedEvent
  | McpServerOauthCompletedEvent
  | CloudTaskUpdatedEvent
  | SessionRestoreFinishedEvent
  | SessionGoalClearedEvent
  | SessionNoticeEvent
  | SessionSideQuestionAnsweredEvent
  | GitSettledEvent
  | RelayPinRefusedEvent
  | CommandEndedEvent
  | UsageModelReroutedEvent
  | SessionArchivedEvent
  | SessionReactivatedEvent
  | SessionClosedEvent
  | SessionPinnedEvent
  | SessionUnpinnedEvent
  | SessionMutedEvent
  | SessionUnmutedEvent
  | SessionConvertedEvent
  | SessionBranchChangedEvent
  | SessionSweptToRepoRootEvent
  | AgentProviderBindingChangedEvent
  | AgentProviderBindingChangeFailedEvent
  | ApprovalRequestedEvent
  | ApprovalApprovedEvent
  | ApprovalReviewerDeniedEvent
  | ApprovalDenialOverriddenEvent
  | RunQueuedEvent
  | RunStepLimitReachedEvent
  | RunRecoveryResolvedEvent
  | SessionGoalUpdatedEvent
  | SessionRenamedEvent
  | PtyControlChangedEvent
  | WorkflowStartedEvent
  | WorkflowResumedEvent
  | WorkflowCanceledEvent
  | WorkflowResultsPostedEvent
  | WorkflowStepStartedEvent
  | WorkflowStepFinishedEvent
  | WorkflowStepFailedEvent
  | WorkflowStepCanceledEvent
  | WorkflowStepSkippedEvent
  | WorkflowGateResolvedEvent
  | BackupCompletedEvent
  | BackupFailedEvent
  | BackupRestoredEvent;
export const SessionEventSchema: z.ZodType<SessionEvent> = z.discriminatedUnion("type", [
  z
    .object({
      ...buildCommonShape(),
      type: z.literal("session.created"),
      category: z.literal("session_lifecycle"),
      payload: SessionCreatedPayloadSchema,
    })
    .strict(),
  // The six repo/workspace arms. Each shares repo.ts's single
  // `RepoWorkspaceLifecyclePayloadSchema`, so these branch schemas and the
  // `*EventSchema` exports above cannot drift on payload shape — the same
  // single-sourcing the local `*PayloadSchema` consts give the three arms. None
  // is wrapped with `withEpochStamp`; see the no-epoch-stamp note on their
  // declarations above.
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
      type: z.literal("workspace.preparing"),
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
  // The five worktree arms. Each uses the same payload schema as its
  // `*EventSchema` export above — the family factory instantiated over
  // `WorktreeStateSchema`, with created and retired adding their kept-copy
  // member — so these branch schemas and the exports cannot drift on payload
  // shape. No `worktree.failed` arm
  // exists, and none is wrapped with `withEpochStamp` (`session_lifecycle`,
  // not run-scoped; see the no-epoch-stamp note on their declarations above).
  z
    .object({
      ...buildCommonShape(),
      type: z.literal("worktree.created"),
      category: z.literal("session_lifecycle"),
      payload: WorktreeCreatedPayloadSchema,
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
      payload: WorktreeRetiredPayloadSchema,
    })
    .strict(),
  // The `event.compacted` arm. It shares the payload schema declared above —
  // authored in THIS file rather than imported, because the daemon emits the
  // row itself — so this branch schema and the `*EventSchema` export above
  // cannot drift on payload shape. Not wrapped with `withEpochStamp`
  // (daemon-scope, not run-scoped; see the no-epoch-stamp note on its
  // declaration above).
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
      type: z.literal("assistant.message"),
      category: z.literal("assistant_output"),
      payload: assistantMessagePayloadSchema,
    })
    .strict(),
  z
    .object({
      ...buildCommonShape(),
      type: z.literal("assistant.thinking_update"),
      category: z.literal("assistant_output"),
      payload: assistantThinkingUpdatePayloadSchema,
    })
    .strict(),
  z
    .object({
      ...buildCommonShape(),
      type: z.literal("tool.invoked"),
      category: z.literal("tool_activity"),
      payload: toolInvokedPayloadSchema,
    })
    .strict(),
  z
    .object({
      ...buildCommonShape(),
      type: z.literal("tool.result"),
      category: z.literal("tool_activity"),
      payload: toolResultPayloadSchema,
    })
    .strict(),
  z
    .object({
      ...buildCommonShape(),
      type: z.literal("tool.error"),
      category: z.literal("tool_activity"),
      payload: toolErrorPayloadSchema,
    })
    .strict(),
  // The arms built once by
  // `buildSessionEventVariantSchema` above.
  approvalRejectedVariantSchema,
  approvalCanceledVariantSchema,
  approvalRememberedVariantSchema,
  approvalRuleRevokedVariantSchema,
  moderationReviewFlaggedVariantSchema,
  planProposedVariantSchema,
  planAcceptedVariantSchema,
  planHandedOffVariantSchema,
  questionAskedVariantSchema,
  mcpServerStatusChangedVariantSchema,
  mcpServerConfigChangedVariantSchema,
  mcpServerTrustChangedVariantSchema,
  mcpToolOverrideChangedVariantSchema,
  mcpServerOauthCompletedVariantSchema,
  cloudTaskUpdatedVariantSchema,
  sessionRestoreFinishedVariantSchema,
  sessionGoalClearedVariantSchema,
  sessionNoticeVariantSchema,
  sessionSideQuestionAnsweredVariantSchema,
  gitSettledVariantSchema,
  relayPinRefusedVariantSchema,
  commandEndedVariantSchema,
  usageModelReroutedVariantSchema,
  sessionArchivedVariantSchema,
  sessionReactivatedVariantSchema,
  sessionClosedVariantSchema,
  sessionPinnedVariantSchema,
  sessionUnpinnedVariantSchema,
  sessionMutedVariantSchema,
  sessionUnmutedVariantSchema,
  sessionConvertedVariantSchema,
  sessionBranchChangedVariantSchema,
  sessionSweptToRepoRootVariantSchema,
  agentProviderBindingChangedVariantSchema,
  agentProviderBindingChangeFailedVariantSchema,
  approvalRequestedVariantSchema,
  approvalApprovedVariantSchema,
  approvalReviewerDeniedVariantSchema,
  approvalDenialOverriddenVariantSchema,
  runQueuedVariantSchema,
  runStepLimitReachedVariantSchema,
  runRecoveryResolvedVariantSchema,
  sessionGoalUpdatedVariantSchema,
  sessionRenamedVariantSchema,
  ptyControlChangedVariantSchema,
  workflowStartedVariantSchema,
  workflowResumedVariantSchema,
  workflowCanceledVariantSchema,
  workflowResultsPostedVariantSchema,
  workflowStepStartedVariantSchema,
  workflowStepFinishedVariantSchema,
  workflowStepFailedVariantSchema,
  workflowStepCanceledVariantSchema,
  workflowStepSkippedVariantSchema,
  workflowGateResolvedVariantSchema,
  backupCompletedVariantSchema,
  backupFailedVariantSchema,
  backupRestoredVariantSchema,
]);

// --------------------------------------------------------------------------
// SessionEventType — the canonical event-type census.
// --------------------------------------------------------------------------
//
// Every wire `type` string is registered below.
//
//   • Category/type bijection: every type belongs to exactly one category,
//     and `SESSION_EVENT_CATEGORY_BY_TYPE` covers every type. The type-level
//     leg is the `satisfies Record<SessionEventType, EventCategory>` totality
//     check below (missing, unknown, or duplicate keys are compile errors);
//     the runtime leg (the per-category partition) lives in
//     __tests__/session-event.test.ts.
//   • Event-type-string immutability: type strings are immutable wire
//     identifiers (MINOR bumps are additive-only), so renaming a registered
//     literal is forbidden.
//
// Blocks are grouped by category in `EventCategory` declaration order;
// within a block, types follow. Declaration order is NOT load-bearing (RFC
// 8785 JCS serializes the literal strings — see the EventCategory note
// above); the grouping exists so reviewers can reconcile each block against
// its spec section and against the same-ordered per-category arrays +
// registry entries below.
//
// A type's category is the REGISTRY entry, never the namespace prefix:
// `session.clock_unsynced` / `session.clock_corrected` are
// `runtime_node_lifecycle` (the `session.` prefix is preserved because a
// rename is wire-breaking — "Name preservation"), `daemon.*` are
// `security_events`, `relay.pin_refused` is `security_events`,
// `moderation.review_flagged` and `plan.*` are `approval_flow`, and
// `orchestration.rejected` is `orchestration_admission`.
export type SessionEventType =
  // run_lifecycle — the forward non-terminal rollback event, and the
  // forward, non-state rows.
  | "run.queued"
  | "run.starting"
  | "run.running"
  | "run.waiting_for_approval"
  | "run.waiting_for_input"
  | "run.pausing"
  | "run.paused"
  | "run.completed"
  | "run.interrupted"
  | "run.failed"
  | "run.rolled_back"
  | "run.provider_initialized"
  | "run.turn_started"
  | "run.worker_shutdown"
  | "run.step_limit_reached"
  | "run.recovery_resolved"
  | "assistant.message"
  | "assistant.thinking_update"
  // tool_activity — two recovery rows, two subagent-lifecycle
  // rows, and the stored ending of a command.
  | "tool.invoked"
  | "tool.result"
  | "tool.error"
  | "tool.replayed"
  | "tool.skipped_during_recovery"
  | "subagent.started"
  | "subagent.completed"
  | "command.ended"
  // + intervention subfamilies, plus the `user.message` row registered here and
  // `question.asked`.
  | "queue_item.created"
  | "queue_item.admitted"
  | "queue_item.superseded"
  | "queue_item.canceled"
  | "queue_item.not_delivered"
  | "intervention.requested"
  | "intervention.accepted"
  | "intervention.applied"
  | "intervention.rejected"
  | "intervention.degraded"
  | "intervention.expired"
  | "user.message"
  | "question.asked"
  | "artifact.published"
  | "artifact.visibility_updated"
  | "artifact.superseded"
  | "diff.created"
  | "git.settled"
  // session_lifecycle
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
  | "session.pinned"
  | "session.unpinned"
  | "session.muted"
  | "session.unmuted"
  | "session.converted"
  | "session.side_question_answered"
  | "session.restore_finished"
  | "agent.provider_binding_changed"
  | "agent.provider_binding_change_failed"
  | "repo.attached"
  | "repo.detached"
  | "workspace.preparing"
  | "workspace.ready"
  | "workspace.stale"
  | "workspace.archived"
  | "worktree.created"
  | "worktree.ready"
  | "worktree.dirty"
  | "worktree.merged"
  | "worktree.retired"
  | "session.branch_changed"
  | "session.swept_to_repo_root"
  | "pty.control_changed"
  | "cloud.task_updated"
  | "approval.requested"
  | "approval.approved"
  | "approval.rejected"
  | "approval.canceled"
  | "approval.remembered"
  | "approval.rule_revoked"
  | "approval.reviewer_denied"
  | "approval.denial_overridden"
  | "moderation.review_flagged"
  | "plan.proposed"
  | "plan.accepted"
  | "plan.handed_off"
  // + budget warning + account-plane rate-limit snapshot + the three B18
  | "usage.token_count"
  | "usage.cost_update"
  | "usage.context_window_update"
  | "usage.budget_warning"
  | "usage.rate_limit_update"
  | "usage.api_retry"
  | "usage.context_compacted"
  | "usage.model_rerouted"
  // runtime_node_lifecycle — the two name-preserved `session.clock_*`
  // events.
  | "session.clock_unsynced"
  | "session.clock_corrected"
  | "recovery.attempted"
  | "recovery.succeeded"
  | "recovery.failed"
  | "security.default.override"
  | "security.update.available"
  | "daemon.master_key_source"
  | "daemon.pii_split_ambiguous"
  | "relay.pin_refused"
  | "event.compacted"
  | "backup.completed"
  | "backup.failed"
  | "backup.restored"
  | "policy_bundle.loaded"
  | "policy_bundle.rejected"
  | "orchestration.rejected"
  // mcp_governance — the audit surface of the MCP servers a session
  // uses. Emission, payload semantics, and
  // authorization live elsewhere; this census owns registration only.
  | "mcp.server_status_changed"
  | "mcp.server_config_changed"
  | "mcp.server_trust_changed"
  | "mcp.tool_override_changed"
  | "mcp.server_oauth_completed"
  // workflow_lifecycle
  | "workflow.created"
  | "workflow.started"
  | "workflow.gated"
  | "workflow.failed"
  | "workflow.completed"
  | "workflow.resumed"
  | "workflow.canceled"
  | "workflow.run_waiting"
  | "workflow.schedule_armed"
  | "workflow.schedule_fired"
  | "workflow.trigger_armed"
  | "workflow.trigger_fired"
  | "workflow.results_posted"
  // workflow_phase_lifecycle
  | "workflow.phase_admitted"
  | "workflow.phase_waiting_on_pool"
  | "workflow.phase_started"
  | "workflow.phase_progressed"
  | "workflow.phase_canceling"
  | "workflow.phase_failed"
  | "workflow.phase_retried"
  | "workflow.phase_suspended"
  | "workflow.phase_resumed"
  | "workflow.phase_completed"
  | "workflow.human_phase_claimed"
  | "workflow.human_phase_escalated"
  | "workflow.step_started"
  | "workflow.step_finished"
  | "workflow.step_failed"
  | "workflow.step_canceled"
  | "workflow.step_skipped"
  // workflow_parallel_coordination
  | "workflow.parallel_join_cancellation"
  // workflow_gate_resolution
  | "workflow.gate_resolved";

// The SCHEMA-registered subset — the types whose payload variants are
// registered in `SessionEventSchema` above — NOT the taxonomy census (that
// is `SESSION_EVENT_CATEGORY_BY_TYPE`, whose keys iterate all 153 registered
// types). The `SessionEvent["type"]` element annotation binds membership to
// the schema union at COMPILE time: a census literal without a registered
// payload variant is rejected here (a plain `SessionEventType` annotation
// would admit any of the 153), and the admissible set widens as emitting
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
// Order mirrors the declaration order of the union arms above.
export const SESSION_EVENT_TYPES: readonly SessionEvent["type"][] = [
  "session.created",
  "repo.attached",
  "repo.detached",
  "workspace.preparing",
  "workspace.ready",
  "workspace.stale",
  "workspace.archived",
  "worktree.created",
  "worktree.ready",
  "worktree.dirty",
  "worktree.merged",
  "worktree.retired",
  "event.compacted",
  "assistant.message",
  "assistant.thinking_update",
  "tool.invoked",
  "tool.result",
  "tool.error",
  "approval.rejected",
  "approval.canceled",
  "approval.remembered",
  "approval.rule_revoked",
  "moderation.review_flagged",
  "plan.proposed",
  "plan.accepted",
  "plan.handed_off",
  "question.asked",
  "mcp.server_status_changed",
  "mcp.server_config_changed",
  "mcp.server_trust_changed",
  "mcp.tool_override_changed",
  "mcp.server_oauth_completed",
  "cloud.task_updated",
  "session.restore_finished",
  "session.goal_cleared",
  "session.notice",
  "session.side_question_answered",
  "git.settled",
  "relay.pin_refused",
  "command.ended",
  "usage.model_rerouted",
  "session.archived",
  "session.reactivated",
  "session.closed",
  "session.pinned",
  "session.unpinned",
  "session.muted",
  "session.unmuted",
  "session.converted",
  "session.branch_changed",
  "session.swept_to_repo_root",
  "agent.provider_binding_changed",
  "agent.provider_binding_change_failed",
  "approval.requested",
  "approval.approved",
  "approval.reviewer_denied",
  "approval.denial_overridden",
  "run.queued",
  "run.step_limit_reached",
  "run.recovery_resolved",
  "session.goal_updated",
  "session.renamed",
  "pty.control_changed",
  "workflow.started",
  "workflow.resumed",
  "workflow.canceled",
  "workflow.results_posted",
  "workflow.step_started",
  "workflow.step_finished",
  "workflow.step_failed",
  "workflow.step_canceled",
  "workflow.step_skipped",
  "workflow.gate_resolved",
  "backup.completed",
  "backup.failed",
  "backup.restored",
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
// category, and the 19 arrays partition the 153-type census — both asserted
// per-category in __tests__/session-event.test.ts. Explicit `readonly
// SessionEventType[]` annotations keep the exported surface
// `--isolatedDeclarations`-clean, matching `SESSION_EVENT_TYPES` above.

export const RUN_LIFECYCLE_EVENT_TYPES: readonly SessionEventType[] = [
  "run.queued",
  "run.starting",
  "run.running",
  "run.waiting_for_approval",
  "run.waiting_for_input",
  "run.pausing",
  "run.paused",
  "run.completed",
  "run.interrupted",
  "run.failed",
  "run.rolled_back",
  "run.provider_initialized",
  "run.turn_started",
  "run.worker_shutdown",
  "run.step_limit_reached",
  "run.recovery_resolved",
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
  "command.ended",
] as const;

export const INTERACTIVE_REQUEST_EVENT_TYPES: readonly SessionEventType[] = [
  "queue_item.created",
  "queue_item.admitted",
  "queue_item.superseded",
  "queue_item.canceled",
  "queue_item.not_delivered",
  "intervention.requested",
  "intervention.accepted",
  "intervention.applied",
  "intervention.rejected",
  "intervention.degraded",
  "intervention.expired",
  "user.message",
  "question.asked",
] as const;

export const ARTIFACT_PUBLICATION_EVENT_TYPES: readonly SessionEventType[] = [
  "artifact.published",
  "artifact.visibility_updated",
  "artifact.superseded",
  "diff.created",
  "git.settled",
] as const;

// Five subsections flattened in spec order: session (incl. the side question,
// the undo record, the pin and mute marks and a chat's conversion), agent,
// repo/workspace/worktree (incl. the sweep to the repository root and the
// branch change), pty, cloud task.
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
  "session.pinned",
  "session.unpinned",
  "session.muted",
  "session.unmuted",
  "session.converted",
  "session.side_question_answered",
  "session.restore_finished",
  "agent.provider_binding_changed",
  "agent.provider_binding_change_failed",
  "repo.attached",
  "repo.detached",
  "workspace.preparing",
  "workspace.ready",
  "workspace.stale",
  "workspace.archived",
  "worktree.created",
  "worktree.ready",
  "worktree.dirty",
  "worktree.merged",
  "worktree.retired",
  "session.branch_changed",
  "session.swept_to_repo_root",
  "pty.control_changed",
  "cloud.task_updated",
] as const;

export const APPROVAL_FLOW_EVENT_TYPES: readonly SessionEventType[] = [
  "approval.requested",
  "approval.approved",
  "approval.rejected",
  "approval.canceled",
  "approval.remembered",
  "approval.rule_revoked",
  "approval.reviewer_denied",
  "approval.denial_overridden",
  "moderation.review_flagged",
  "plan.proposed",
  "plan.accepted",
  "plan.handed_off",
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
  "session.clock_unsynced",
  "session.clock_corrected",
] as const;

export const RECOVERY_EVENTS_EVENT_TYPES: readonly SessionEventType[] = [
  "recovery.attempted",
  "recovery.succeeded",
  "recovery.failed",
] as const;

export const SECURITY_EVENTS_EVENT_TYPES: readonly SessionEventType[] = [
  "security.default.override",
  "security.update.available",
  "daemon.master_key_source",
  "daemon.pii_split_ambiguous",
  "relay.pin_refused",
] as const;

export const EVENT_MAINTENANCE_EVENT_TYPES: readonly SessionEventType[] = [
  "event.compacted",
  "backup.completed",
  "backup.failed",
  "backup.restored",
] as const;

export const POLICY_EVENTS_EVENT_TYPES: readonly SessionEventType[] = [
  "policy_bundle.loaded",
  "policy_bundle.rejected",
] as const;

export const ORCHESTRATION_ADMISSION_EVENT_TYPES: readonly SessionEventType[] = [
  "orchestration.rejected",
] as const;

// Four of the five bind to the daemon-scope sentinel;
// `mcp.server_status_changed` binds per-event
export const MCP_GOVERNANCE_EVENT_TYPES: readonly SessionEventType[] = [
  "mcp.server_status_changed",
  "mcp.server_config_changed",
  "mcp.server_trust_changed",
  "mcp.tool_override_changed",
  "mcp.server_oauth_completed",
] as const;

export const WORKFLOW_LIFECYCLE_EVENT_TYPES: readonly SessionEventType[] = [
  "workflow.created",
  "workflow.started",
  "workflow.gated",
  "workflow.failed",
  "workflow.completed",
  "workflow.resumed",
  "workflow.canceled",
  "workflow.run_waiting",
  "workflow.schedule_armed",
  "workflow.schedule_fired",
  "workflow.trigger_armed",
  "workflow.trigger_fired",
  "workflow.results_posted",
] as const;

export const WORKFLOW_PHASE_LIFECYCLE_EVENT_TYPES: readonly SessionEventType[] = [
  "workflow.phase_admitted",
  "workflow.phase_waiting_on_pool",
  "workflow.phase_started",
  "workflow.phase_progressed",
  "workflow.phase_canceling",
  "workflow.phase_failed",
  "workflow.phase_retried",
  "workflow.phase_suspended",
  "workflow.phase_resumed",
  "workflow.phase_completed",
  "workflow.human_phase_claimed",
  "workflow.human_phase_escalated",
  "workflow.step_started",
  "workflow.step_finished",
  "workflow.step_failed",
  "workflow.step_canceled",
  "workflow.step_skipped",
] as const;

export const WORKFLOW_PARALLEL_COORDINATION_EVENT_TYPES: readonly SessionEventType[] = [
  "workflow.parallel_join_cancellation",
] as const;

export const WORKFLOW_GATE_RESOLUTION_EVENT_TYPES: readonly SessionEventType[] = [
  "workflow.gate_resolved",
] as const;

// --------------------------------------------------------------------------
// SESSION_EVENT_CATEGORY_BY_TYPE — canonical type → category registry.
// --------------------------------------------------------------------------
//
// Internal Record backing the exported ReadonlyMap. The `satisfies
// Record<SessionEventType, EventCategory>` check is the compile-time
// totality leg: a union member missing here, an unregistered key, or a
// duplicate key is a compile error, so the registry can never silently
// drift from `SessionEventType`. Entries mirror the union's category-block
// order (same reconciliation affordance; order is not load-bearing).
const SESSION_EVENT_CATEGORY_RECORD = {
  // run_lifecycle
  "run.queued": "run_lifecycle",
  "run.starting": "run_lifecycle",
  "run.running": "run_lifecycle",
  "run.waiting_for_approval": "run_lifecycle",
  "run.waiting_for_input": "run_lifecycle",
  "run.pausing": "run_lifecycle",
  "run.paused": "run_lifecycle",
  "run.completed": "run_lifecycle",
  "run.interrupted": "run_lifecycle",
  "run.failed": "run_lifecycle",
  "run.rolled_back": "run_lifecycle",
  "run.provider_initialized": "run_lifecycle",
  "run.turn_started": "run_lifecycle",
  "run.worker_shutdown": "run_lifecycle",
  "run.step_limit_reached": "run_lifecycle",
  "run.recovery_resolved": "run_lifecycle",
  // assistant_output
  "assistant.message": "assistant_output",
  "assistant.thinking_update": "assistant_output",
  // tool_activity
  "tool.invoked": "tool_activity",
  "tool.result": "tool_activity",
  "tool.error": "tool_activity",
  "tool.replayed": "tool_activity",
  "tool.skipped_during_recovery": "tool_activity",
  "subagent.started": "tool_activity",
  "subagent.completed": "tool_activity",
  "command.ended": "tool_activity",
  // interactive_request
  "queue_item.created": "interactive_request",
  "queue_item.admitted": "interactive_request",
  "queue_item.superseded": "interactive_request",
  "queue_item.canceled": "interactive_request",
  "queue_item.not_delivered": "interactive_request",
  "intervention.requested": "interactive_request",
  "intervention.accepted": "interactive_request",
  "intervention.applied": "interactive_request",
  "intervention.rejected": "interactive_request",
  "intervention.degraded": "interactive_request",
  "intervention.expired": "interactive_request",
  "user.message": "interactive_request",
  "question.asked": "interactive_request",
  // artifact_publication
  "artifact.published": "artifact_publication",
  "artifact.visibility_updated": "artifact_publication",
  "artifact.superseded": "artifact_publication",
  "diff.created": "artifact_publication",
  "git.settled": "artifact_publication",
  // session_lifecycle
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
  "session.pinned": "session_lifecycle",
  "session.unpinned": "session_lifecycle",
  "session.muted": "session_lifecycle",
  "session.unmuted": "session_lifecycle",
  "session.converted": "session_lifecycle",
  "session.side_question_answered": "session_lifecycle",
  "session.restore_finished": "session_lifecycle",
  "agent.provider_binding_changed": "session_lifecycle",
  "agent.provider_binding_change_failed": "session_lifecycle",
  "repo.attached": "session_lifecycle",
  "repo.detached": "session_lifecycle",
  "workspace.preparing": "session_lifecycle",
  "workspace.ready": "session_lifecycle",
  "workspace.stale": "session_lifecycle",
  "workspace.archived": "session_lifecycle",
  "worktree.created": "session_lifecycle",
  "worktree.ready": "session_lifecycle",
  "worktree.dirty": "session_lifecycle",
  "worktree.merged": "session_lifecycle",
  "worktree.retired": "session_lifecycle",
  "session.branch_changed": "session_lifecycle",
  "session.swept_to_repo_root": "session_lifecycle",
  "pty.control_changed": "session_lifecycle",
  "cloud.task_updated": "session_lifecycle",
  // approval_flow
  "approval.requested": "approval_flow",
  "approval.approved": "approval_flow",
  "approval.rejected": "approval_flow",
  "approval.canceled": "approval_flow",
  "approval.remembered": "approval_flow",
  "approval.rule_revoked": "approval_flow",
  "approval.reviewer_denied": "approval_flow",
  "approval.denial_overridden": "approval_flow",
  "moderation.review_flagged": "approval_flow",
  "plan.proposed": "approval_flow",
  "plan.accepted": "approval_flow",
  "plan.handed_off": "approval_flow",
  // usage_telemetry
  "usage.token_count": "usage_telemetry",
  "usage.cost_update": "usage_telemetry",
  "usage.context_window_update": "usage_telemetry",
  "usage.budget_warning": "usage_telemetry",
  "usage.rate_limit_update": "usage_telemetry",
  "usage.api_retry": "usage_telemetry",
  "usage.context_compacted": "usage_telemetry",
  "usage.model_rerouted": "usage_telemetry",
  // runtime_node_lifecycle
  "session.clock_unsynced": "runtime_node_lifecycle",
  "session.clock_corrected": "runtime_node_lifecycle",
  // recovery_events
  "recovery.attempted": "recovery_events",
  "recovery.succeeded": "recovery_events",
  "recovery.failed": "recovery_events",
  // security_events
  "security.default.override": "security_events",
  "security.update.available": "security_events",
  "daemon.master_key_source": "security_events",
  "daemon.pii_split_ambiguous": "security_events",
  "relay.pin_refused": "security_events",
  // event_maintenance
  "event.compacted": "event_maintenance",
  "backup.completed": "event_maintenance",
  "backup.failed": "event_maintenance",
  "backup.restored": "event_maintenance",
  // policy_events
  "policy_bundle.loaded": "policy_events",
  "policy_bundle.rejected": "policy_events",
  // orchestration_admission
  "orchestration.rejected": "orchestration_admission",
  // mcp_governance
  "mcp.server_status_changed": "mcp_governance",
  "mcp.server_config_changed": "mcp_governance",
  "mcp.server_trust_changed": "mcp_governance",
  "mcp.tool_override_changed": "mcp_governance",
  "mcp.server_oauth_completed": "mcp_governance",
  // workflow_lifecycle
  "workflow.created": "workflow_lifecycle",
  "workflow.started": "workflow_lifecycle",
  "workflow.gated": "workflow_lifecycle",
  "workflow.failed": "workflow_lifecycle",
  "workflow.completed": "workflow_lifecycle",
  "workflow.resumed": "workflow_lifecycle",
  "workflow.canceled": "workflow_lifecycle",
  "workflow.run_waiting": "workflow_lifecycle",
  "workflow.schedule_armed": "workflow_lifecycle",
  "workflow.schedule_fired": "workflow_lifecycle",
  "workflow.trigger_armed": "workflow_lifecycle",
  "workflow.trigger_fired": "workflow_lifecycle",
  "workflow.results_posted": "workflow_lifecycle",
  // workflow_phase_lifecycle
  "workflow.phase_admitted": "workflow_phase_lifecycle",
  "workflow.phase_waiting_on_pool": "workflow_phase_lifecycle",
  "workflow.phase_started": "workflow_phase_lifecycle",
  "workflow.phase_progressed": "workflow_phase_lifecycle",
  "workflow.phase_canceling": "workflow_phase_lifecycle",
  "workflow.phase_failed": "workflow_phase_lifecycle",
  "workflow.phase_retried": "workflow_phase_lifecycle",
  "workflow.phase_suspended": "workflow_phase_lifecycle",
  "workflow.phase_resumed": "workflow_phase_lifecycle",
  "workflow.phase_completed": "workflow_phase_lifecycle",
  "workflow.human_phase_claimed": "workflow_phase_lifecycle",
  "workflow.human_phase_escalated": "workflow_phase_lifecycle",
  "workflow.step_started": "workflow_phase_lifecycle",
  "workflow.step_finished": "workflow_phase_lifecycle",
  "workflow.step_failed": "workflow_phase_lifecycle",
  "workflow.step_canceled": "workflow_phase_lifecycle",
  "workflow.step_skipped": "workflow_phase_lifecycle",
  // workflow_parallel_coordination
  "workflow.parallel_join_cancellation": "workflow_parallel_coordination",
  // workflow_gate_resolution
  "workflow.gate_resolved": "workflow_gate_resolution",
} satisfies Record<SessionEventType, EventCategory>;

// Map from each registered wire type to its canonical category. Exposed so
// consumers (projectors, replay machinery) can assert
// category/type consistency without re-parsing the schema.
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
// Readers walk this lookup BEFORE re-parsing through
// `SessionEventSchema`, so the prototype-chain immunity is load-bearing.
// (The backing Record above is module-internal and never looked up — it
// exists solely for the compile-time totality check.)
export const SESSION_EVENT_CATEGORY_BY_TYPE: ReadonlyMap<SessionEventType, EventCategory> = new Map(
  // Cast justified by the `satisfies` check above: the record's own
  // enumerable keys are exactly the 153 SessionEventType literals (totality
  // + excess-property checks), so `Object.entries` narrowing from
  // `[string, ...]` is sound.
  Object.entries(SESSION_EVENT_CATEGORY_RECORD) as ReadonlyArray<[SessionEventType, EventCategory]>,
);

// --------------------------------------------------------------------------
// NormalizedEventKind — surveyed-runtime normalized census + disposition
// registry.
// --------------------------------------------------------------------------
//
// The provider drivers normalize both provider wires into a 35-kind
// normalized event vocabulary BEFORE the taxonomy maps each kind onto the
// `SessionEventType` census. `EVENT_DISPOSITION_BY_KIND` below is the
// machine-readable form of — the single source of disposition truth
// normalizers (the B10 bundle) consume. Every kind resolves to exactly one
// disposition under the no-silent-capability-loss default:
// `adopt`/`rename` is the default, and every `correlate`/`discard` carries
// a stated reason, so a capability-bearing kind is never dropped silently.
//
// Registry scope is the 35 CENSUS kinds only. The nine wire-level Claude
// system-channel discards and the current-wire delta families in the same
// plan table are normalizer's wire layer, NOT registry keys — the
// `worker_shutting_down` delta orphan foremost (the ninth B18 target; its
// literal `run.worker_shutdown` was closed by the union widening alone,
// with no registry entry). The unknown residual — a wire kind outside this
// census — is backstopped at runtime normalizer's structured
// default-branch diagnostic (B10), never by this registry.
//
// Eight census kinds' exact `SessionEventType` literals were minted by the
// 2026-07-22 B18 census amendment ahead of their registration in this
// file, so their entries carried `typePending: "B18"` in place of
// `eventType`. registered all fifteen B18 literals in the census above and
// flipped each of the eight to its `eventType`, so the two-file
// shrink-only ratchet that guarded the gap is CONSUMED: the pinned pending
// set is empty and no registry entry uses the `typePending` arm.
//
// The arm itself is RETAINED, not removed — it is the reusable mechanism
// for a future census amendment that mints a literal ahead of its
// registration. What guards registry/census agreement from here is the
// standing bijection pair: the `satisfies Record<SessionEventType,
// EventCategory>` totality check above (a census literal cannot go
// unregistered) plus the both-direction set-equality assertions in
// __tests__/session-event.test.ts. Registration is not emission license:
// normalizers route every flipped kind to their default-branch diagnostic
// until its payload variant is registered in `SessionEventSchema` by its
// owning surface — emission turns on variant-by-variant, never on the registry flip alone. Should the arm ever
// be used again, a pending kind routes to that same diagnostic rather than
// constructing an envelope against a missing type — no envelope, no silent
// drop.

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
// makes a MISSING kind a compile error.
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
 *
 * A discriminated union whose arms make illegal states unrepresentable at
 * the type level (the compiler enforces SHAPE; the Vitest suite verifies
 * census CONTENT):
 *   • `adopt`/`rename` entries name a canonical {@link EventCategory} and
 *     carry EXACTLY ONE of `eventType` — a registered
 *     {@link SessionEventType} census literal — or `typePending: "B18"`
 *     (a literal minted by a census amendment ahead of its registration
 *     here). flipped the last eight `typePending` rows, so the pending arm
 *     currently has ZERO registry instances; it is retained as the
 *     mechanism for the next such amendment. The `?: never` keys forbid
 *     both-present; the arm split forbids neither-present. `eventType`
 *     names the row's PRIMARY target only — outcome-dependent fan-out
 *     (`tool.error`, `approval.rejected` / `.canceled`,
 *     `subagent.completed`) is normalizer detail, not registry data.
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
// `SESSION_EVENT_CATEGORY_RECORD` above. The `satisfies
// Record<NormalizedEventKind, EventKindDisposition>` check is the
// compile-time totality leg: a census kind missing here, an unregistered
// key, or a duplicate key is a compile error — and the
// `EventKindDisposition` union arms reject an entry carrying both
// `eventType` and `typePending`, either alongside a `reason`, or a
// correlate/discard smuggling a taxonomy target. Entries mirror the plan
// table's row order (blocks per its Group column; order is not
// load-bearing). Fan-out notes ("fans to …") are normalizer detail — the
// registry names each row's PRIMARY target.
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
  // A provider's permission ask that reaches a person, recorded once as the
  // approval it opens. An ask the daemon answers itself, by a policy allow or a
  // remembered rule, appends nothing: the tool row is the record.
  approval_request: {
    disposition: "adopt",
    category: "approval_flow",
    eventType: "approval.requested",
  },
  // Approval resolution; fans by outcome to `approval.rejected` /
  // `approval.canceled`.
  approval_resolved: {
    disposition: "adopt",
    category: "approval_flow",
    eventType: "approval.approved",
  },
  // A structured question to the person: the question record the card renders.
  user_input_request: {
    disposition: "adopt",
    category: "interactive_request",
    eventType: "question.asked",
  },
  user_input_resolved: {
    disposition: "discard",
    reason:
      "the answer is recorded as the person's own user.message turn by the call that answered the question; its delivery to the provider is kept in the daemon's log only",
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
  // `system.api_retry` typed-error enum enriches this same kind —
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
      "correlation-only wire echo — folds into the originating app-sent user-message row via correlation_id (delivery confirmation of the pending send; no new persisted type); correlate target user.message (B18-minted 2026-07-22, registered in this census so the target literal resolves; the echo keeps routing to normalizer default-branch diagnostic until user.message payload variant joins the union)",
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
 * kinds. normalizers (the B10 bundle) consume it as the single source of
 * disposition truth; see the section comment above for scope (census kinds
 * only, wire-layer discards and delta families excluded) and the
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
// CapabilityDetails — declared in event-core.ts and re-exported above.
// --------------------------------------------------------------------------

// Note: cross-file ID types (`SessionId`, `UserId`, …) are not re-
// exported here — they are surfaced from `session.ts` and reach the public
// API via `index.ts`'s `export * from "./session.js"`. Re-exporting them
// from this file too would create a duplicate-export conflict at the
// package barrel.

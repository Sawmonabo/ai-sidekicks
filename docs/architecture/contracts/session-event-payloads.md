# Session Event Payload Contracts

Part of [API Payload Contracts](./api-payload-contracts.md), which holds the shared types, the error envelope and the conventions every shape here uses.

## Plan-004 — Session Event Taxonomy

```ts
// EventEnvelopeVersion — branded semver "MAJOR.MINOR" string per ADR-017 §Decision #1.
// Wire form and persisted form are both string (never numeric). Parsing extracts MAJOR
// and MINOR as integers for numeric comparison; lexical string comparison is unsafe
// (e.g. "1.10" lexically < "1.9"). The connection handshake's `version.floor_exceeded` /
// `version.ceiling_exceeded` reasons are about the wire protocol
// (local-ipc-payloads.md §JSON-RPC Handshake `protocolVersion` Field), not this brand.
type EventEnvelopeVersion = string & { readonly __brand: "EventEnvelopeVersion" };
// Format: /^(0|[1-9]\d*)\.(0|[1-9]\d*)$/ — validated at envelope construction.

// EventEnvelope — canonical event message
interface EventEnvelope {
  id: string;
  sessionId: SessionId;
  sequence: number;
  occurredAt: string; // ISO 8601
  category: EventCategory;
  type: string; // specific type within category
  actor?: string | null; // the connection's device id, the agent id, or null for the system
  payload: Record<string, unknown>; // category-specific fields; may carry the cross-cutting sourceEpoch + sourcePosition pair (below)
  correlationId?: string;
  causationId?: string;
  version: EventEnvelopeVersion; // semver "MAJOR.MINOR" per ADR-017 §Decision #1 (never numeric)
}

// sourceEpoch + sourcePosition — the cross-cutting epoch-attribution payload pair
// (Plan-004 T1.8, the CP-002-12 registration; Spec-005 §Event Type
// Enumeration). Stamped TOGETHER at ingestion by Plan-002 T3.10's late-append leg on
// pre-rollback-epoch rows (the pair from the straggler's per-event operation
// association — (epoch, turn) recorded at operation open — falling back to the closed
// delivery generation's always-superseding retained pair; Spec-003 §Required Behavior
// owns the fence and generation-rotation mechanics) of the four late-append families
// — assistant_output,
// tool_activity, usage_telemetry and artifact_publication (a provider permission ask from
// before a cut is absorbed, never appended): sourceEpoch names the
// pre-rollback execution epoch, sourcePosition the normalized session position (the
// Spec-003 targetPosition turn-boundary vocabulary) the row occupies within it —
// registered because no run-scoped family payload carries a native position key, and
// the supersede cutoff (turn > targetPosition) cannot rank a late row against its
// epoch's surviving prefix without one. Admission is keyed on run-scopedness, not
// family membership: only run-scoped SessionEventSchema branches of those families
// admit the pair (via Plan-004 T1.8's withEpochStamp helper, whose pairing
// refinement requires both keys + runId on any stamped payload); variants without
// run attribution — the account-plane usage.rate_limit_update foremost — and every
// run_lifecycle branch never admit it (stragglers absorb, never append). Absent on
// every current-epoch row — absence means current-epoch, and the stamp is never
// fabricated at read time. The pair rides INSIDE payload, so it sits in the RFC 8785
// canonical bytes with no envelope-level field
// added — the canonical set above is unchanged — and it is part of the v1.0
// baseline payload contract. Compaction preserves the sourceEpoch + sourcePosition
// + runId triple, on accepted run.rolled_back boundary rows the
// runId/runVersion/targetPosition rewind cutoff, and on every run-scoped row its runId
// ([Spec-005 §Event Compaction Policy](../../specs/005-session-event-taxonomy-and-audit-log.md#event-compaction-policy)), so Plan-002 T3.15's supersede projection keys cross-epoch rows durably even after
// both the boundary and the stale rows compact. Execution-epoch semantics are
// Spec-003-owned (§Required Behavior + Run State Machine §Invariants): 0 before any
// rollback, advancing with each accepted run.rolled_back rewind regardless of the
// file-leg disposition. The key names are pinned by SOURCE_EPOCH_PAYLOAD_KEY /
// SOURCE_POSITION_PAYLOAD_KEY in packages/contracts/src/event/envelope.ts — a rename is
// forbidden-non-additive per ADR-017 §Decision #8.
type SourceEpoch = number; // int >= 0 — SourceEpochSchema in packages/contracts/src/event/envelope.ts (Plan-004 T1.8)
type SourcePosition = number; // int >= 0 — SourcePositionSchema, same file (Plan-004 T1.8); Spec-003 targetPosition vocabulary

type EventCategory =
  | "run_lifecycle"
  | "assistant_output"
  | "tool_activity"
  | "interactive_request"
  | "artifact_publication"
  | "session_lifecycle"
  | "approval_flow"
  | "usage_telemetry"
  // Extended per Spec-005 §Recovery Events, §Security Events, §Event Maintenance,
  // §Orchestration Admission, §MCP Governance and the
  // workflow families (§Workflow Lifecycle through §Workflow Gate Resolution). The
  // category list and its event types are Spec-005 §Event Type Summary's, which
  // carries the table; read them there, never restated here.
  | "recovery_events"
  | "security_events"
  | "event_maintenance"
  | "orchestration_admission"
  | "mcp_governance"
  // The workflow families are separate categories rather than one, so a reader can query a
  // run's life, its steps, its parallel coordination and its gates apart from one
  // another — the split run_lifecycle and approval_flow already make between runs and
  // approvals (Spec-005 §Workflow Lifecycle through §Workflow Gate Resolution; emitted by Plan-014).
  | "workflow_lifecycle"
  | "workflow_phase_lifecycle"
  | "workflow_parallel_coordination"
  | "workflow_gate_resolution";
// Individual event types within each category are enumerated in Spec-005 §Event Type Enumeration.

// ---------------------------------------------------------------------------
// Payload variants authored in packages/contracts/src/event/declared-variants.ts
// (event.compacted and the event_maintenance base) and
// packages/contracts/src/event/variant-types.ts (usage.model_rerouted, its
// schema in packages/contracts/src/event/session.ts), which Plan-004
// owns, rather than imported from an emitting plan's module (contrast the
// repo/workspace/worktree family, authored in repo/mount.ts / worktree/lifecycle.ts under
// emitter-authors-payload); Plan-004 T1.10 registers event.compacted.
// Registering a payload variant is additive-MINOR per ADR-017 §Decision #8;
// these type strings are listed in Spec-005 §Event Type Summary, so
// registering them adds no event type.
//
// Session binding (Spec-005 §Daemon-Scope Event Binding): relay.pin_refused and
// the event_maintenance types bind the reserved RFC 9562 §5.10 Max UUID sentinel
// session_id (lowercase). Binding is an emitter obligation: the envelope's
// SessionId already admits the sentinel, so no schema carve-out exists.
//
// Of these, only usage.model_rerouted is run-scoped (its payload carries runId),
// so it alone admits the sourceEpoch + sourcePosition pair documented above.
// relay.pin_refused payload (security_events): the relay's host and the two key-hash prefixes, and
// nothing else (Spec-005 §Security Events). The daemon records it on its sentinel session when a
// pinned relay presents a key other than the one pinned when it was linked, and refuses the
// connection. Emitted by the relay pin (Plan-025 Phase 3), not by Plan-004, so its schema,
// RelayPinRefusedPayloadSchema, is authored in packages/contracts/src/relay.ts under
// emitter-authors-payload and imported by the union, like the repo/workspace/worktree family.
// Each prefix is the first 8 bytes of its key hash, never a token.
interface RelayPinRefusedPayload {
  relayHost: string; // a host name
  pinnedSpkiPrefix: string;
  presentedSpkiPrefix: string;
}

// usage.model_rerouted payload (usage_telemetry), per Spec-005 §Usage Telemetry, which maps each
// provider frame onto these members. Draws the `Model switched` row (Spec-011 §Flow Row Kinds).
interface UsageModelReroutedPayload {
  sessionId: SessionId;
  runId: RunId;
  agentId?: AgentId;
  fromModel: string;
  toModel: string; // the model the request ran on, and the model it is priced at
  scope: "turn" | "session" | "local"; // one turn; the rest of the session; only a subagent's, a side question's or a background fork's response
  sentence?: string; // the provider's own sentence, absent when it sent none
  explanation?: string; // the provider's explanation, shown verbatim
  cause: "safety" | "model_unavailable" | "model_blocked" | "out_of_credits";
  safetyCategory?: string; // the provider's open safety category, such as "cyber" or "bio"
}

// assistant.message payload (assistant_output), per Spec-005 §Assistant Output. The body itself
// travels out-of-payload in `session_events.content_payload`. `runId` is absent only on a Codex
// voice call's answer, which comes outside any run and carries `origin: "voice"`.
interface AssistantMessagePayload {
  sessionId: SessionId;
  runId?: RunId;
  contentType?: string;
  contentLength?: number;
  origin?: "voice";
}

// event_maintenance payload base — {nodeId, operationId, occurredAt}, per
// Spec-005 §Event Maintenance. occurredAt re-spells the envelope member (the
// spec's shape; both sit in the RFC 8785 canonical bytes).

interface EventCompactedPayload {
  nodeId: NodeId;
  operationId: string;
  occurredAt: string; // ISO 8601
  removedSessions: Array<{ sessionId: SessionId; fromSeq: number; toSeq: number }>; // each session the deletion removed, with the range of rows it deleted
}

// The daemon's internal reads of the log (Plan-004 T4.1's `readAfterCursor` and `readWindow`). They are
// not methods: a screen reads a session's events only through `session.subscribe` (SessionSubscribe,
// in session-payloads.md §Plan-001).

// EventReadAfterCursor
interface EventReadAfterCursorRequest {
  sessionId: SessionId;
  afterCursor?: EventCursor; // absent ≡ start-of-log position -1: full surviving-range read, the same as a subscription's first connect
  limit?: number; // default 100
}
interface EventReadAfterCursorResponse {
  events: EventEnvelope[];
  nextCursor: EventCursor;
  hasMore: boolean;
}

// EventReadWindow
interface EventReadWindowRequest {
  sessionId: SessionId;
  fromSequence: number;
  toSequence: number;
}
interface EventReadWindowResponse {
  events: EventEnvelope[];
}
```

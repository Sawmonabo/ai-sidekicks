// Runtime node contracts — RuntimeNodeAttach request/response payloads plus the
// `NodeId` / `NodeState` brands for Plan-003 (Runtime Node Attach). Exact field
// set mirrors the canonical TypeScript shapes in
// docs/architecture/contracts/api-payload-contracts.md § Tier 3 — Plan-003
// (verbatim — adding/removing/renaming a field here is a contract break and
// requires the spec edit first).
//
// Design note — two ORTHOGONAL axes on the attach response (api-payload-
// contracts.md:494-499):
//   • `state: NodeState`  — LIVENESS axis (registering|online|degraded|offline|
//     revoked), the row's lifecycle position.
//   • `readOnly: boolean` — PERMISSION axis, DERIVED: true iff the daemon's
//     `clientVersion` is below the session's `min_client_version` floor. This is
//     never a `NodeState` value; a node may be `online` AND `readOnly` at once.
// The two together express I-003-1 (Plan-003): a below-floor daemon is ADMITTED
// read-only (not ejected); a later write attempt returns typed
// `VERSION_FLOOR_EXCEEDED` (ADR-018 §Decision #4). T1.1 only ships the contract
// SURFACE that makes the verdict expressible — `clientVersion` (the floor-
// compared input) and `readOnly` (the derived verdict). The Phase-3 attach
// service performs the comparison and populates `readOnly`.
//
// Refs: Spec-003 (Runtime Node Attach), ADR-018 (cross-version compatibility),
// ADR-022 (toolchain — Zod 4.x).
import { z } from "zod";

import { EventEnvelopeVersionSchema, type EventEnvelopeVersion } from "./event.js";
import {
  ParticipantIdSchema,
  SessionIdSchema,
  type ParticipantId,
  type SessionId,
} from "./session.js";

// --------------------------------------------------------------------------
// NodeId — daemon-assigned opaque string brand (NOT a UUID).
// --------------------------------------------------------------------------
//
// `node_id` is `TEXT NOT NULL, -- daemon-assigned node identifier` in
// `runtime_node_attachments` (shared-postgres-schema.md:199) — deliberately
// contrasted against `id` / `session_id` / `participant_id`, which are `UUID`
// in the SAME table — and `TEXT` in both local SQLite tables
// (local-sqlite-schema.md:271,280). So `NodeId` is a daemon-minted opaque
// scalar, NOT a server-minted UUID: we mirror `SessionId`'s brand SHAPE but
// deliberately depart from its UUID parser, using the non-UUID branded-scalar
// idiom from `session.ts`'s `EventCursorSchema` (z.string().min(1).max(cap)
// + inline `.brand()` cast) instead of the `brandedUuidIdSchema` helper.
//
// The `.max(NODE_ID_MAX_LEN)` cap is defense-in-depth against pathological
// lengths (mirrors `EVENT_CURSOR_MAX_LEN` in session.ts — the wire/IPC trust
// boundary admits cross-node input we cannot length-trust on producer faith
// alone). The `z.ZodType<NodeId, NodeId>` double-T annotation (not single-T)
// is required because `NodeIdSchema` composes into `RuntimeNodeAttachRequest-
// Schema`, a tRPC v11 request schema whose Standard-Schema-V1 input inference
// must resolve to `NodeId` and not `unknown` (per ADR-014 — same rationale as
// `EventCursorSchema`; see ./internal/branded.ts).
export const NODE_ID_MAX_LEN = 256;
export type NodeId = string & { readonly __brand: "NodeId" };
export const NodeIdSchema: z.ZodType<NodeId, NodeId> = z
  .string()
  .min(1)
  .max(NODE_ID_MAX_LEN)
  .brand<"NodeId">() as unknown as z.ZodType<NodeId, NodeId>;

// --------------------------------------------------------------------------
// NodeState — node-attachment LIVENESS enum (5 values).
// --------------------------------------------------------------------------
//
// Aligned with the `runtime_node_attachments.state` CHECK constraint
// (shared-postgres-schema.md:202-203): exactly these five values, in any
// order (RFC 8785 JCS serializes the literal wire string, so enum declaration
// order is not load-bearing — but the membership of the set IS a contract per
// ADR-018 §Decision #1: removals MAJOR, additions MINOR).
//
// Distinct from two neighboring enums — do NOT conflate:
//   • `RuntimeNodeHealthState` below — 2-value health axis on the wire
//     (online|degraded).
//   • Postgres `runtime_node_presence.health_state` — 3-value
//     (online|degraded|offline) (shared-postgres-schema.md:223). `offline` is
//     a presence-derived value, not a daemon-reported one, so it is NOT in the
//     2-value wire health enum.
export type NodeState = "registering" | "online" | "degraded" | "offline" | "revoked";
export const NodeStateSchema: z.ZodType<NodeState> = z.enum([
  "registering",
  "online",
  "degraded",
  "offline",
  "revoked",
]);

// --------------------------------------------------------------------------
// RuntimeNodeHealthState — daemon-reported health enum (2 values).
// --------------------------------------------------------------------------
//
// SHARED wire enum: `healthState: "online" | "degraded"` appears on BOTH
// `RuntimeNodeAttachRequest` (this task, T1.1) and `RuntimeNodeHeartbeatRequest`
// (T1.3, same file — api-payload-contracts.md:502-504). Hoisted to a single
// named export so the two surfaces stay single-sourced (2+ wire-surface
// consumers is the hoist bar). This is the daemon's SELF-REPORTED health at
// attach/heartbeat time — a 2-value subset, distinct from the 5-value
// `NodeState` liveness axis above and the 3-value Postgres
// `runtime_node_presence.health_state` (which adds the presence-derived
// `offline`).
export type RuntimeNodeHealthState = "online" | "degraded";
export const RuntimeNodeHealthStateSchema: z.ZodType<RuntimeNodeHealthState> = z.enum([
  "online",
  "degraded",
]);

// --------------------------------------------------------------------------
// RuntimeNodeAttach — request / response.
// --------------------------------------------------------------------------
//
// Canonical wire: api-payload-contracts.md:486-499. The request carries the
// daemon's reported `clientVersion` (typed `EventEnvelopeVersion` — the branded
// MAJOR.MINOR semver, NOT a plain string, so the Phase-3 floor comparison is
// semver-aware not lexicographic, per ADR-018 §Decision #1) and is `.strict()`
// (unknown keys rejected — schema drift surfaces at parse time).

export interface RuntimeNodeAttachRequest {
  sessionId: SessionId;
  participantId: ParticipantId;
  nodeId: NodeId;
  clientVersion: EventEnvelopeVersion;
  capabilities: Record<string, unknown>;
  healthState: RuntimeNodeHealthState;
}
// `z.ZodType<T, T>` (double-T) — required so tRPC v11's Standard-Schema-V1
// input inference resolves to `RuntimeNodeAttachRequest` and not `unknown`.
// The schema is non-transforming (no `.transform()` / `.coerce()` /
// `.preprocess()`), so pre-validation Input ≡ post-validation Output ≡ T;
// explicit double-T preserves that equivalence on the type surface (matches
// `SessionCreateRequestSchema` et al. in session.ts).
//
// The outer `as unknown as z.ZodType<T, T>` cast bridges the composed object's
// output type to the double-T shape — load-bearing HERE specifically because
// the upstream `EventEnvelopeVersionSchema` (event.ts:124) is declared single-T
// (`z.ZodType<EventEnvelopeVersion>`): its `Input` slot is `unknown`, so without
// the cast the composed request's `clientVersion` input resolves to `unknown`
// (TS2375 under `exactOptionalPropertyTypes`). This is the FIRST consumer to
// compose `EventEnvelopeVersionSchema` into a tRPC request schema — its only
// prior use (event.ts:246) was inside the single-T `SessionEventSchema`, where
// the asymmetry never surfaced. Same bridge pattern as `MembershipUpdateSchema`
// (memberships.ts:230) and `brandedUuidIdSchema` (./internal/branded.ts); see
// ADR-014. We bridge at the consumption site rather than re-annotating the
// shared event.ts symbol (out of this task's scope, and its envelope consumer
// is correct as single-T).
export const RuntimeNodeAttachRequestSchema: z.ZodType<
  RuntimeNodeAttachRequest,
  RuntimeNodeAttachRequest
> = z
  .object({
    sessionId: SessionIdSchema,
    participantId: ParticipantIdSchema,
    nodeId: NodeIdSchema,
    clientVersion: EventEnvelopeVersionSchema,
    // Zod v4 two-arg `z.record(keySchema, valueSchema)` — the one-arg v3 form
    // `z.record(z.unknown())` mis-types under v4.3.6 (matches the
    // `RecordOfUnknownSchema` shape in session.ts).
    capabilities: z.record(z.string(), z.unknown()),
    healthState: RuntimeNodeHealthStateSchema,
  })
  .strict() as unknown as z.ZodType<RuntimeNodeAttachRequest, RuntimeNodeAttachRequest>;

export interface RuntimeNodeAttachResponse {
  attachmentId: string;
  state: NodeState;
  readOnly: boolean;
  attachedAt: string;
}
// Single-T `z.ZodType<T>` — response schemas are not tRPC input surfaces, so
// they do not need the double-T input-inference preservation (matches
// `SessionCreateResponseSchema` et al. in session.ts).
export const RuntimeNodeAttachResponseSchema: z.ZodType<RuntimeNodeAttachResponse> = z
  .object({
    // `attachmentId`: the wire contract (api-payload-contracts.md:495) types
    // this plain `string`, NOT `NodeId`/UUID — it is the `runtime_node_
    // attachments.id` surfaced opaquely. We deliberately do NOT add `.uuid()`
    // (the wire asserts no UUID-format invariant; matches the opaque-`id`
    // stance taken for EventEnvelope.id in event.ts).
    attachmentId: z.string().min(1),
    // LIVENESS axis.
    state: NodeStateSchema,
    // PERMISSION axis — derived below-floor flag, ORTHOGONAL to `state` (true
    // iff `clientVersion` is below the session floor; populated by the Phase-3
    // attach service per ADR-018 §Decision #4 / I-003-1). NOT a NodeState value.
    readOnly: z.boolean(),
    // ISO 8601 per api-payload-contracts.md §RuntimeNodeAttachResponse.
    // `{ offset: true }` widens default Z-only acceptance to numeric RFC 3339
    // §5.6 offsets — identical convention to `createdAt`/`occurredAt` in
    // session.ts / event.ts.
    attachedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

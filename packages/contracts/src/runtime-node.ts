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

import {
  EVENT_FIELD_MAX_LEN,
  EventEnvelopeVersionSchema,
  type EventEnvelopeVersion,
} from "./event.js";
import {
  ParticipantIdSchema,
  SessionIdSchema,
  wireFreeFormString,
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
// ADR-018 §Decision #8: removals MAJOR, additions MINOR).
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

// --------------------------------------------------------------------------
// RuntimeNodeCapabilityUpdate — request / response.
// --------------------------------------------------------------------------
//
// Operation-scoped cap for the free-form `healthChanges.reason` audit string.
// Mirrors `INVITE_REVOKE_REASON_MAX_LEN` (invites.ts:98) — same per-operation
// convention (we deliberately do NOT pre-create a shared reason constant for
// the not-yet-written T1.3 detach `reason`; each operation owns its own cap).
export const RUNTIME_NODE_CAPABILITY_UPDATE_REASON_MAX_LEN = 512;
//
// Canonical wire: api-payload-contracts.md:508-518. Method
// `runtimenode.capabilityupdate` (a tRPC mutation), so the REQUEST is a tRPC
// input surface. The request carries the daemon's FULL REPLACEMENT capability
// map — additions and removals are both expressed by the new `capabilities`
// set (a key absent from the new map is a removal; a new key is an addition).
// Health transitions ride the OPTIONAL `healthChanges` object. Both objects are
// `.strict()` (top-level AND nested) — the wire shape is closed, so unknown
// keys at either level are schema drift surfaced at parse time.
//
// `healthChanges.state` is the FULL 5-value `NodeState` liveness enum, NOT the
// 2-value `RuntimeNodeHealthState` wire-health enum (intentional per the wire
// doc, api-payload-contracts.md:512). A capability-update may move the node to
// any liveness position the daemon reports (e.g. `offline`/`revoked`), which the
// narrower attach/heartbeat health axis cannot express.
//
// Optional fields are typed `key?: T | undefined` (not bare `key?:`): Zod's
// `.optional()` infers `T | undefined`, and the interface must match the
// schema's inferred output for the double-T annotation (see the
// `exactOptionalPropertyTypes` note at session.ts:252-257 and the identical
// `reason?: string | undefined` stance at invites.ts:184). The wire signal is
// still "key absent" — `.optional()` keeps the key omittable; consumers that
// need absent-vs-undefined can test `"healthChanges" in obj`.

export interface RuntimeNodeCapabilityUpdateRequest {
  nodeId: NodeId;
  capabilities: Record<string, unknown>;
  healthChanges?: { state: NodeState; reason?: string | undefined } | undefined;
}
// `z.ZodType<T, T>` (double-T) with the outer `as unknown as z.ZodType<T, T>`
// cast — required so tRPC v11's Standard-Schema-V1 input inference resolves to
// `RuntimeNodeCapabilityUpdateRequest` and not `unknown` (per ADR-014; the
// schema is non-transforming, so Input ≡ Output ≡ T and the double-T preserves
// that equivalence on the type surface).
//
// The cast's load-bearing trigger here is the single-T `NodeStateSchema` member
// inside `healthChanges.state` (declared `z.ZodType<NodeState>` above — its
// `Input` slot defaults to `unknown`). Because this is a tRPC INPUT surface,
// that single-T member poisons the composed object's input inference: without
// the bridge the request's `healthChanges.state` input resolves to `unknown`.
// The ablation diagnostic (cast removed) is TS2375; the trigger is the single-T
// member's `unknown` input slot, NOT the optionality of `healthChanges` — the
// `online`/`degraded` distinction here is irrelevant. TS2375 is emitted (rather
// than TS2322) because the `ZodType`→`ZodType` structural comparison routes
// through the `exactOptionalPropertyTypes` path via Zod's internal phantom
// `_input` structure; the all-required `RuntimeNodeAttachRequestSchema` above
// (zero optional user-type fields) ablates to the SAME TS2375, which is direct
// proof the diagnostic tracks the single-T `unknown`-input member, not any
// optional property on the request type. This is a DIFFERENT single-T member
// than `RuntimeNodeAttachRequestSchema` (driven by `EventEnvelopeVersionSchema`,
// a member T1.2 does NOT carry), but the mechanism is identical. We bridge at
// the consumption site rather than re-annotating the shared single-T
// `NodeStateSchema` (its response consumers below are correct as single-T, and
// re-annotation is out of this task's scope).
export const RuntimeNodeCapabilityUpdateRequestSchema: z.ZodType<
  RuntimeNodeCapabilityUpdateRequest,
  RuntimeNodeCapabilityUpdateRequest
> = z
  .object({
    nodeId: NodeIdSchema,
    // Zod v4 two-arg `z.record(keySchema, valueSchema)` — the one-arg v3 form
    // `z.record(z.unknown())` mis-types under v4 (matches the `capabilities`
    // shape on `RuntimeNodeAttachRequestSchema` above / `RecordOfUnknownSchema`
    // in session.ts). The full map is a REPLACEMENT set: removals are encoded
    // by omission, additions by presence.
    capabilities: z.record(z.string(), z.unknown()),
    // Nested object ALSO `.strict()` so unknown keys inside `healthChanges` are
    // rejected too (the wire shape is closed at both levels). `reason` uses the
    // package's standard wire free-form-string realization, `wireFreeFormString`
    // (session.ts:118, "Used by every wire-layer free-form string in this
    // package") — it centralizes the trust-boundary guards (length cap + NUL-
    // byte rejection + empty/whitespace-only rejection) that every free-form
    // wire field shares. A wire `reason?: string` is NOT accept-any-string at
    // the boundary: the identical `InviteRevoke.reason` (invites.ts:191, same
    // `reason?: string` wire spec) composes the same helper. This is the
    // default REALIZATION of a wire string here, not a contract tightening — no
    // sibling that uses it (ChannelSummary.name, InviteRevoke.reason, identity
    // handles) needed a spec edit. The helper's `.min(1)` makes empty/
    // whitespace-only rejection come free (no separate `.min(1)` needed).
    healthChanges: z
      .object({
        state: NodeStateSchema,
        reason: wireFreeFormString(
          RUNTIME_NODE_CAPABILITY_UPDATE_REASON_MAX_LEN,
          "RuntimeNodeCapabilityUpdate.healthChanges.reason",
        ).optional(),
      })
      .strict()
      .optional(),
  })
  .strict() as unknown as z.ZodType<
  RuntimeNodeCapabilityUpdateRequest,
  RuntimeNodeCapabilityUpdateRequest
>;

export interface RuntimeNodeCapabilityUpdateResponse {
  nodeId: NodeId;
  state: NodeState;
  updatedAt: string;
}
// Single-T `z.ZodType<T>` — response schemas are not tRPC input surfaces, so
// they need no double-T input-inference bridge. This composes the same single-T
// `NodeStateSchema` for `state` and compiles clean with NO cast (matches
// `RuntimeNodeAttachResponseSchema` above) — direct proof the single-T member
// only poisons input inference on the REQUEST side.
export const RuntimeNodeCapabilityUpdateResponseSchema: z.ZodType<RuntimeNodeCapabilityUpdateResponse> =
  z
    .object({
      nodeId: NodeIdSchema,
      // LIVENESS axis — the node's post-update liveness position.
      state: NodeStateSchema,
      // ISO 8601 per api-payload-contracts.md §RuntimeNodeCapabilityUpdate-
      // Response. `{ offset: true }` matches `attachedAt` above (RFC 3339 §5.6
      // numeric offsets widen the default Z-only acceptance).
      updatedAt: z.iso.datetime({ offset: true }),
    })
    .strict();

// --------------------------------------------------------------------------
// RuntimeNodeHeartbeat — request / response.
// --------------------------------------------------------------------------
//
// Canonical wire: api-payload-contracts.md:501-506. Method
// `runtimenode.heartbeat` (a tRPC mutation), so the REQUEST is a tRPC input
// surface. The heartbeat is the daemon's periodic liveness self-report: it
// carries the `nodeId` and the daemon's CURRENT 2-value health on the wire.
//
// `healthState` REUSES the hoisted 2-value `RuntimeNodeHealthStateSchema`
// (online|degraded) declared above — the SHARED daemon-reported health enum
// whose comment (lines 99-101) reserves it for exactly this surface. It is the
// daemon's SELF-REPORTED health axis, deliberately NARROWER than the 5-value
// `NodeState` liveness enum: `offline`/`registering`/`revoked` are NodeState
// liveness positions a daemon cannot self-report as a heartbeat health value
// (e.g. `offline` is presence-DERIVED, never daemon-asserted), so they MUST be
// rejected here. The capability-update path (above) is where a daemon moves the
// node across the full 5-value liveness axis; heartbeat is health-only.
//
// `healthState` is REQUIRED (no `.optional()`, no `| undefined`): a heartbeat
// without a reported health value is not a valid heartbeat.

export interface RuntimeNodeHeartbeatRequest {
  nodeId: NodeId;
  healthState: RuntimeNodeHealthState;
}
// `z.ZodType<T, T>` (double-T) with the outer `as unknown as z.ZodType<T, T>`
// cast — required so tRPC v11's Standard-Schema-V1 input inference resolves to
// `RuntimeNodeHeartbeatRequest` and not `unknown` (per ADR-014; the schema is
// non-transforming, so Input ≡ Output ≡ T and the double-T preserves that
// equivalence on the type surface).
//
// The cast's load-bearing trigger is the single-T `RuntimeNodeHealthStateSchema`
// member (declared `z.ZodType<RuntimeNodeHealthState>` at line 109 — its `Input`
// slot defaults to `unknown`). Because this is a tRPC INPUT surface, that single-
// T member poisons the composed object's input inference: without the bridge the
// request's `healthState` input resolves to `unknown`. The ablation diagnostic
// (cast removed) is TS2375 — the same mechanism and code as the two casts above:
// `RuntimeNodeAttachRequestSchema` (single-T `EventEnvelopeVersionSchema`) and
// `RuntimeNodeCapabilityUpdateRequestSchema` (single-T `NodeStateSchema`). The
// determinant is the single-T `unknown`-input member, NOT user-type optionality:
// `RuntimeNodeHeartbeatRequest` has ZERO optional fields yet ablates to TS2375,
// exactly like the all-required `RuntimeNodeAttachRequestSchema` (the cap-update
// comment above proves the same from the optional-field side). We bridge at the
// consumption site rather than re-annotating the shared single-T
// `RuntimeNodeHealthStateSchema` (its other consumer,
// `RuntimeNodeAttachRequestSchema`, is bridged the same way, and re-annotation
// is out of this task's scope).
export const RuntimeNodeHeartbeatRequestSchema: z.ZodType<
  RuntimeNodeHeartbeatRequest,
  RuntimeNodeHeartbeatRequest
> = z
  .object({
    nodeId: NodeIdSchema,
    healthState: RuntimeNodeHealthStateSchema,
  })
  .strict() as unknown as z.ZodType<RuntimeNodeHeartbeatRequest, RuntimeNodeHeartbeatRequest>;

// No-content response. The wire payload is literally `null`, NOT a 204 empty
// body (api-payload-contracts.md:506,537): the resolver returns `null`, which
// tRPC serializes as an ordinary HTTP 200 success envelope
// `{ result: { data: null } }`, and the JSON-RPC daemon transport returns
// `result: null`. Both are validated by this `z.null()` schema, so
// `RuntimeNodeHeartbeatResponseSchema.parse(null)` MUST succeed and any non-null
// value (`{}`, a string, `undefined`) MUST fail. No `RuntimeNodeHeartbeatResponse`
// type alias exists: the response type IS `null`, so there is nothing to name
// (and none is in `contract_provides`). Single-T `z.ZodType<null>` — a response
// schema is not a tRPC input surface, so it needs no double-T input-inference
// bridge (matches `RuntimeNodeAttachResponseSchema` above).
export const RuntimeNodeHeartbeatResponseSchema: z.ZodType<null> = z.null();

// --------------------------------------------------------------------------
// RuntimeNodeDetach — request / response.
// --------------------------------------------------------------------------
//
// Operation-scoped cap for the free-form detach `reason` audit string. Mirrors
// `RUNTIME_NODE_CAPABILITY_UPDATE_REASON_MAX_LEN` (line 208) and
// `INVITE_REVOKE_REASON_MAX_LEN` (invites.ts:98) — same per-operation
// convention: each operation owns its OWN reason cap rather than sharing a
// single package-wide constant. The capability-update comment at lines 204-207
// explicitly anticipated this T1.3 constant ("the not-yet-written T1.3 detach
// `reason`"). The framework body-size cap (owned by Plan-004/Plan-005) is the
// authoritative limit; this is defense-in-depth at the wire trust boundary.
export const RUNTIME_NODE_DETACH_REASON_MAX_LEN = 512;
//
// Canonical wire: api-payload-contracts.md:520-525. Method `runtimenode.detach`
// (a tRPC mutation), so the REQUEST is a tRPC input surface. The request carries
// the `nodeId` and an OPTIONAL free-form `reason` audit string.
//
// `reason` uses the package's standard wire free-form-string realization,
// `wireFreeFormString` (session.ts:118, "Used by every wire-layer free-form
// string in this package") — it centralizes the trust-boundary guards (length
// cap + `.min(1)` empty rejection + whitespace-only rejection + NUL-byte
// rejection) that every free-form wire field shares. A wire `reason?: string` is
// NOT accept-any-string at the boundary: the identical `InviteRevoke.reason`
// (invites.ts:191, same `reason?: string` wire spec) composes the same helper,
// as does `RuntimeNodeCapabilityUpdate.healthChanges.reason` above. This is the
// default REALIZATION of a wire string here, not a contract tightening — no
// sibling that uses it needed a spec edit.
//
// `reason` is typed `reason?: string | undefined` (not bare `reason?:`): Zod's
// `.optional()` infers `string | undefined`, and the interface must match the
// schema's inferred output for the double-T annotation (see the
// `exactOptionalPropertyTypes` note at session.ts:252-257 and the identical
// `reason?: string | undefined` stance at invites.ts:184 / runtime-node.ts:236).

export interface RuntimeNodeDetachRequest {
  nodeId: NodeId;
  reason?: string | undefined;
}
// `z.ZodType<T, T>` (double-T) — required so tRPC v11's Standard-Schema-V1 input
// inference resolves to `RuntimeNodeDetachRequest` and not `unknown` (per
// ADR-014; the schema is non-transforming, so Input ≡ Output ≡ T).
//
// This schema needs NO `as unknown as z.ZodType<T, T>` cast and compiles clean —
// it is the CONTRAST case to the three cast-bearing request schemas above. Both
// composed members are double-T: `NodeIdSchema` (`z.ZodType<NodeId, NodeId>`,
// line 63) and `wireFreeFormString(...).optional()` (`wireFreeFormString`
// returns `z.ZodString`, session.ts:118 — its `Input` slot is `string`, not
// `unknown`). With no single-T member there is no `unknown`-input slot to poison
// the composed object's input inference, EVEN THOUGH `reason` is `.optional()` —
// direct proof the cast tracks single-T MEMBERS, not optionality and not
// "request-ness". The structural twin `InviteRevokeSchema` (invites.ts:187-193 —
// branded IDs + `wireFreeFormString(...).optional()` + `.strict()`, declared
// double-T) likewise carries no cast. Ablation confirms: compiling with the
// double-T annotation and no cast succeeds; no diagnostic is emitted.
export const RuntimeNodeDetachRequestSchema: z.ZodType<
  RuntimeNodeDetachRequest,
  RuntimeNodeDetachRequest
> = z
  .object({
    nodeId: NodeIdSchema,
    // The helper's `.min(1)` makes empty/whitespace-only rejection come free (no
    // separate `.min(1)` needed); `.optional()` keeps the key omittable.
    reason: wireFreeFormString(
      RUNTIME_NODE_DETACH_REASON_MAX_LEN,
      "RuntimeNodeDetach.reason",
    ).optional(),
  })
  .strict();

// No-content response. The wire payload is literally `null`, NOT a 204 empty
// body (api-payload-contracts.md:525,539): the resolver returns `null`, which
// tRPC serializes as an ordinary HTTP 200 success envelope
// `{ result: { data: null } }`, and the JSON-RPC daemon transport returns
// `result: null`. Both are validated by this `z.null()` schema, so
// `RuntimeNodeDetachResponseSchema.parse(null)` MUST succeed and any non-null
// value MUST fail. No `RuntimeNodeDetachResponse` type alias exists: the response
// type IS `null` (and none is in `contract_provides`). Single-T `z.ZodType<null>`
// — a response schema is not a tRPC input surface (matches
// `RuntimeNodeHeartbeatResponseSchema` above).
export const RuntimeNodeDetachResponseSchema: z.ZodType<null> = z.null();

// --------------------------------------------------------------------------
// RUNTIME_NODE_EVENT_NAMES — the 7 `runtime_node.*` durable event-type names.
// --------------------------------------------------------------------------
//
// The canonical exported set of the SEVEN `runtime_node.*` durable event-type
// names, sourced verbatim from the Runtime Node Lifecycle taxonomy table in
// docs/specs/006-session-event-taxonomy-and-audit-log.md lines 374-380. This
// ships the NAME taxonomy for C4 conformance. The per-event payload-SHAPE schemas
// for the 5 daemon-reachable events (`registered`, `online`, `offline`,
// `capability_declared`, `capability_updated`) are now authored in Plan-003 Phase 2
// in the `Runtime-node event PAYLOAD-shape schemas` section BELOW (CP-003-1
// amendment 2026-06-02; `degraded` / `revoked` remain Phase 3 — no Phase-2
// producer). What stays the additive Plan-006 Tier 4 follow-up is (a) the
// REGISTRATION of these names + payloads into the discriminated `SessionEventSchema`
// / `EventType` union in event.ts, (b) the `EventEnvelope` integrity wrapper
// (BLAKE3 hash chain + dual signature + RFC 8785 JCS), and (c) binding the
// canonical `CapabilityDetails` over the interim-opaque capability fields. So the
// names are still deliberately NOT added to event.ts's union here.
//
// Shape mirrors `SESSION_EVENT_TYPES` / `SessionEventType` (event.ts:405-413): a
// union type alias plus an explicitly-annotated `readonly [...]  as const` tuple.
// The explicit `readonly RuntimeNodeEventName[]` annotation is required for
// `isolatedDeclarations`, and `as const` freezes the literal element types so
// consumers can iterate the registered set without re-parsing schemas. The
// membership of the SET is the contract, not the declaration order — RFC 8785
// JCS serializes the literal wire string, so tuple order is not load-bearing
// (same stance as `NodeState` above and `SESSION_EVENT_TYPES`; additions are
// MINOR, removals MAJOR under ADR-018 §Decision #8).
//
// BOUNDARY — the `session.clock_*` pair is EXCLUDED. `session.clock_unsynced` /
// `session.clock_corrected` (Spec-006:381-382) sit in the SAME EventCategory
// (`runtime_node_lifecycle`) but retain the `session.` prefix by name-
// preservation (Spec-006:384 / ADR-018 §Decision #8 — an event-type rename is
// not additive, so it is wire-breaking). They were promoted from Spec-015
// §Reserved Events and are NOT `runtime_node.*` names: this set is the 7-name
// `runtime_node.*` prefix set ONLY (Spec-006:374-380), exactly per the C4
// acceptance criterion.
//
// CATEGORY OWNERSHIP — all 7 names belong to EventCategory
// `"runtime_node_lifecycle"`, which is already declared in Plan-001's taxonomy
// (event.ts:84 type union + event.ts:101 `EventCategorySchema` enum). This file
// references that category but does NOT redefine it and does NOT add a category-
// binding map. Per CP-003-1 (docs/plans/003-runtime-node-attach.md §CP-003-1,
// "Payload-shape ownership" at line 83): Plan-003 owns the `runtime_node.*` name
// constants AND the per-event payload-SHAPE schemas (Phase 2 ships the 5
// daemon-reachable shapes BELOW; Phase 3 ships `degraded` / `revoked`). Plan-006
// Tier 4 owns the discriminated-union REGISTRATION (folding each payload schema
// into `SessionEventSchema` in event.ts) + the `EventEnvelope` integrity wrapper
// (BLAKE3 hash chain, dual-signature mechanics, JCS) + binding the canonical
// `CapabilityDetails`, all against the integrity columns Plan-001 forward-declares.
export type RuntimeNodeEventName =
  | "runtime_node.registered"
  | "runtime_node.online"
  | "runtime_node.degraded"
  | "runtime_node.offline"
  | "runtime_node.revoked"
  | "runtime_node.capability_declared"
  | "runtime_node.capability_updated";
export const RUNTIME_NODE_EVENT_NAMES: readonly RuntimeNodeEventName[] = [
  "runtime_node.registered",
  "runtime_node.online",
  "runtime_node.degraded",
  "runtime_node.offline",
  "runtime_node.revoked",
  "runtime_node.capability_declared",
  "runtime_node.capability_updated",
] as const;

// ==========================================================================
// Runtime-node event PAYLOAD-shape schemas — Plan-003 Phase 2 (CP-003-1).
// ==========================================================================
//
// The Zod object shape of the `EventEnvelope.payload` field for each of the 5
// DAEMON-REACHABLE `runtime_node.*` events — `registered`, `online`, `offline`,
// `capability_declared`, `capability_updated` (the events Plan-003 Phase 2's
// node-registry + capability-service producers actually emit). `degraded` and
// `revoked` are deferred to Plan-003 Phase 3 (their producers — heartbeat-loss
// and admin-revoke — are Phase 3; authoring them now would be untested
// speculative surface). Sourced from the Runtime Node Lifecycle taxonomy table,
// docs/specs/006-session-event-taxonomy-and-audit-log.md lines 374-380.
//
// SCOPE — these schemas validate the PAYLOAD CONTENTS ONLY, not the full
// envelope: there is no `type` / `category` / `sequence` / `id` / `occurredAt`
// / `version` / `prev_hash` / `row_hash` / `daemon_signature` here. That
// integrity wrapper (the `EventEnvelope` schema, BLAKE3 hash chain, dual
// signature, RFC 8785 JCS serialization) and the registration of these payloads
// into the discriminated `SessionEventSchema` / `EventType` union in `event.ts`
// are owned by Plan-006 Tier 4 (CP-003-1; see the `RUNTIME_NODE_EVENT_NAMES`
// block above). The names are therefore still NOT added to `event.ts`'s union
// here — only the per-event payload SHAPES land in this phase.
//
// EXPORTED (const + interface), unlike `event.ts`'s module-LOCAL
// `sessionCreatedPayloadSchema` et al. (event.ts:255-275): these have 2+
// cross-file consumers, so they clear the export bar — (a) Plan-006 Tier 4
// imports each `*PayloadSchema` to register it into `SessionEventSchema`, and
// (b) the Phase-2 T2.1-T2.5 daemon producers (`node-registry.ts`,
// `node-capability-service.ts`) import them to `.parse()`-validate the payload
// at the emission boundary (the `.parse()` validation seam CP-003-1 mandates,
// in place of ad-hoc objects). Plan-001's local payload consts were single-file
// (folded only into the same module's union branches), so they stayed local.
//
// TYPING — single-`T` `z.ZodType<T>`, `.strict()`. These are NON-INPUT event
// payloads: constructed daemon-side and validated at the emission boundary with
// `.parse()`, never a tRPC request input. So they follow the single-T
// `RuntimeNodeAttachResponseSchema` (line 178, "response schemas are not tRPC
// input surfaces") and `event.ts`'s single-T event schemas — NOT the double-T
// `RuntimeNodeAttachRequestSchema` input idiom. NO `as unknown as` cast is
// needed even though each composes the branded `NodeIdSchema` / `SessionIdSchema`
// double-T scalars: the direct precedent is `MembershipSummarySchema`
// (session.ts:239) — single-T `z.ZodType<T>` over a `.strict()` object composing
// branded `MembershipIdSchema` / `ParticipantIdSchema`, exported interface, and
// compiles clean with no cast (so do `SessionSnapshotSchema` / `ChannelSummary-
// Schema` / `SessionCreateResponseSchema`). The cast on this file's REQUEST
// schemas is driven by the double-T input-inference slot (it "only poisons input
// inference on the REQUEST side", line 313), which a single-T payload does not
// carry — so single-T payloads composing branded ids compose cleanly.
//
// Optional interface fields are typed `key?: T | undefined` (not bare `key?:`):
// Zod's `.optional()` infers `T | undefined`, and with no `as unknown as` cast
// TypeScript checks interface ↔ inferred-output equality exactly, so the
// interface must match (same `exactOptionalPropertyTypes` stance as
// `ChannelSummary.name` at session.ts:267 and lines 225-231 above). `actor` is
// `.nullable().optional()` → its inferred output is `string | null | undefined`,
// so the field is `actor?: string | null | undefined` (mirrors `EventEnvelope`'s
// `actor` at event.ts:211).
//
// --------------------------------------------------------------------------
// Operation-scoped caps for the new free-form payload string fields. Same
// per-operation convention as `RUNTIME_NODE_CAPABILITY_UPDATE_REASON_MAX_LEN`
// (line 208) / `RUNTIME_NODE_DETACH_REASON_MAX_LEN` (line 410): each field owns
// its own cap rather than sharing a single package-wide constant. Co-located at
// the head of this section (self-contained) rather than each immediately above
// its consuming schema, since all three are consumed across the factories +
// schemas below. Defense-in-depth length bounds at the wire/replay trust
// boundary — the daemon synthesizes these payloads, but event replay re-admits
// them from durable storage, so producer trust alone is not sufficient.
// --------------------------------------------------------------------------
//
// `nodeVersion` (the node's software RELEASE version, conventionally full semver
// e.g. "1.4.2") and `platform` (e.g. "darwin-arm64") are bounded free strings,
// NOT typed enums/`EventEnvelopeVersion` — see the field-type rationale on
// `RuntimeNodeRegisteredPayloadSchema` below.
export const RUNTIME_NODE_VERSION_MAX_LEN = 64;
export const RUNTIME_NODE_PLATFORM_MAX_LEN = 64;
// The canonical capability identifier (e.g. "provider-driver") carried on
// `capability_declared` / `capability_updated`.
export const RUNTIME_NODE_CAPABILITY_KEY_MAX_LEN = 128;

// --------------------------------------------------------------------------
// Shared base-shape factories (DRY) — spread into each `z.object` below.
// --------------------------------------------------------------------------
//
// Shape-factory functions (NOT shared schema consts) spread into each
// `z.object({ ...buildXShape(), ... }).strict()`, mirroring `event.ts`'s
// `buildCommonShape()` (event.ts:217-247): the factory makes accidental drift
// between sibling schemas harder than re-typing the fields each time. (Zod 4
// check chains are immutable and safe to share, so a shared const would also be
// correct — the factory is the established house style here, event.ts:191-199.)
//
// FULL LIFECYCLE base — `{sessionId?, nodeId, previousState?, newState, actor?}`.
// The Spec-006 base payload shared by every `runtime_node.*` LIFECYCLE event
// (Spec-006:368). `sessionId` is `.optional()` per Spec-006's `sessionId?` base:
// the daemon always populates it for `runtime_node.*` events (Spec-006:370,
// "carry the session_id of the attachment they describe"), but the SCHEMA mirrors
// the spec's optional base. `actor` is the EventEnvelope free-form actor
// (`participant_id | agent_id | null` per api-payload-contracts.md §EventEnvelope
// line 760), realized with `wireFreeFormString(...).nullable().optional()` — the
// SAME wire field as `EventEnvelope.actor` (event.ts:243), so it reuses the
// shared `EVENT_FIELD_MAX_LEN` cap (a wire field above the 2-consumer hoist bar),
// NOT a branded `ParticipantId`.
const buildRuntimeNodeLifecycleBaseShape = () => ({
  sessionId: SessionIdSchema.optional(),
  nodeId: NodeIdSchema,
  previousState: NodeStateSchema.optional(),
  newState: NodeStateSchema,
  actor: wireFreeFormString(EVENT_FIELD_MAX_LEN, "RuntimeNodeLifecyclePayload.actor")
    .nullable()
    .optional(),
});

// REDUCED CAPABILITY base — the full base MINUS `previousState` / `newState`.
// Capability events are NOT `NodeState` transitions: the canonical typed
// payloads `RuntimeNodeCapabilityDeclaredPayload` / `RuntimeNodeCapabilityUpdated-
// Payload` (api-payload-contracts.md §Plan-006, lines 729-741) carry NO base /
// `NodeState` fields at all — only the capability fields. Carrying a base
// `newState: NodeState` here would additionally COLLIDE with `capability_updated`'s
// own `previousState` / `newState`, which are `CapabilityDetails` SNAPSHOTS (the
// interim-opaque record below), not `NodeState` values. So the reduced base
// keeps only `{sessionId?, nodeId, actor?}`.
const buildRuntimeNodeCapabilityBaseShape = () => ({
  sessionId: SessionIdSchema.optional(),
  nodeId: NodeIdSchema,
  actor: wireFreeFormString(EVENT_FIELD_MAX_LEN, "RuntimeNodeCapabilityPayload.actor")
    .nullable()
    .optional(),
});

// --------------------------------------------------------------------------
// runtime_node.registered — base + {capabilities, nodeVersion, platform}.
// --------------------------------------------------------------------------
//
// Spec-006:374 ("base + {capabilities[], nodeVersion, platform}"). Emitted by the
// T2.1 node-registry when a node is accepted into the roster (Spec-003 §Attach
// Protocol). Field-type rationale (so reviewers verify, not re-derive):
//   • `capabilities` = `z.record(z.string(), z.unknown())` — a lossless snapshot
//     of the declared capability map, mirroring `RuntimeNodeAttachRequest.
//     capabilities` (line 164) VERBATIM. Departs from Spec-006's informal
//     `capabilities[]` table gloss (an array notation) in favor of the typed
//     line-164 record shape, which governs per typed-source-over-table-gloss.
//     Forward-compatible: Plan-006 Tier 4 can tighten `unknown` → the canonical
//     `CapabilityDetails` with no SHAPE change.
//   • `nodeVersion` = bounded free string, NOT `EventEnvelopeVersion` — it is the
//     node's software RELEASE version (conventionally full semver, e.g. "1.4.2"),
//     which the MAJOR.MINOR-only `EventEnvelopeVersion` regex (event.ts:124,
//     /^(0|[1-9]\d*)\.(0|[1-9]\d*)$/) would REJECT. No source pins its format, so
//     bounded-but-format-unconstrained is the non-lossy call.
//   • `platform` = bounded free string, NOT an enum — no source enumerates the
//     platform set, and composite `platform+arch` values (e.g. "darwin-arm64")
//     must not be rejected.
export interface RuntimeNodeRegisteredPayload {
  sessionId?: SessionId | undefined;
  nodeId: NodeId;
  previousState?: NodeState | undefined;
  newState: NodeState;
  actor?: string | null | undefined;
  capabilities: Record<string, unknown>;
  nodeVersion: string;
  platform: string;
}
export const RuntimeNodeRegisteredPayloadSchema: z.ZodType<RuntimeNodeRegisteredPayload> = z
  .object({
    ...buildRuntimeNodeLifecycleBaseShape(),
    // Zod v4 two-arg `z.record(keySchema, valueSchema)` — the one-arg v3 form
    // mis-types under v4 (matches `RuntimeNodeAttachRequest.capabilities`, line
    // 164 / `RecordOfUnknownSchema` in session.ts).
    capabilities: z.record(z.string(), z.unknown()),
    nodeVersion: wireFreeFormString(
      RUNTIME_NODE_VERSION_MAX_LEN,
      "RuntimeNodeRegisteredPayload.nodeVersion",
    ),
    platform: wireFreeFormString(
      RUNTIME_NODE_PLATFORM_MAX_LEN,
      "RuntimeNodeRegisteredPayload.platform",
    ),
  })
  .strict();

// --------------------------------------------------------------------------
// runtime_node.online — base (no extension).
// --------------------------------------------------------------------------
//
// Spec-006:375 ("base"). Emitted by the T2.1/T2.2 path only AFTER
// `runtime_node.capability_declared` succeeds (I-003-2 ordering, Plan-003 §Phase
// 2). No payload extension — the full lifecycle base is the whole payload.
export interface RuntimeNodeOnlinePayload {
  sessionId?: SessionId | undefined;
  nodeId: NodeId;
  previousState?: NodeState | undefined;
  newState: NodeState;
  actor?: string | null | undefined;
}
export const RuntimeNodeOnlinePayloadSchema: z.ZodType<RuntimeNodeOnlinePayload> = z
  .object({
    ...buildRuntimeNodeLifecycleBaseShape(),
  })
  .strict();

// --------------------------------------------------------------------------
// runtime_node.offline — base + {lastHeartbeatAt, reason}.
// --------------------------------------------------------------------------
//
// Spec-006:377 ("base + {lastHeartbeatAt, reason ∈ ['heartbeat_lost',
// 'explicit_shutdown','network_partition']}"). `reason` is authored as the FULL
// 3-value enum — the COMPLETE contract per Spec-006 — even though Phase 2's T2.5
// detach producer emits only `explicit_shutdown` (the `heartbeat_lost` /
// `network_partition` producers are the Phase-3 heartbeat service). Authoring the
// full enum now keeps the SHAPE stable across phases (Phase 3 adds producers, not
// a schema change). `lastHeartbeatAt` is ISO 8601 with `{ offset: true }` (RFC
// 3339 §5.6 numeric offsets), the same datetime convention as `attachedAt` (line
// 192) / `occurredAt` (event.ts:235).
export interface RuntimeNodeOfflinePayload {
  sessionId?: SessionId | undefined;
  nodeId: NodeId;
  previousState?: NodeState | undefined;
  newState: NodeState;
  actor?: string | null | undefined;
  lastHeartbeatAt: string;
  reason: "heartbeat_lost" | "explicit_shutdown" | "network_partition";
}
export const RuntimeNodeOfflinePayloadSchema: z.ZodType<RuntimeNodeOfflinePayload> = z
  .object({
    ...buildRuntimeNodeLifecycleBaseShape(),
    lastHeartbeatAt: z.iso.datetime({ offset: true }),
    reason: z.enum(["heartbeat_lost", "explicit_shutdown", "network_partition"]),
  })
  .strict();

// --------------------------------------------------------------------------
// runtime_node.degraded — base + {degradedCapabilities[], detail}.
// --------------------------------------------------------------------------
//
// Spec-006:376 ("base + {degradedCapabilities[], detail}"). Authored in Plan-003
// Phase 3 (T3.6) alongside its producer — the control-plane heartbeat-staleness
// sweep — exactly as Phase 2 deferred this shape ("their producers — heartbeat-
// loss and admin-revoke — are Phase 3", lines 556-558 above). The canonical
// `api-payload-contracts.md` carries NO `RuntimeNodeDegradedPayload` interface
// (only the `NodeState` / wire-`healthState` enums), so Spec-006:376 is the
// authoritative shape source here (typed-source-over-table-gloss falls back to
// the spec gloss when the typed doc is silent — verified 2026-06-04).
//
// ONE EVENT NAME, ONE SCHEMA, TWO PRODUCERS. Spec-006:376 frames `degraded` as
// CAPABILITY degradation ("one or more degraded capabilities (provider driver
// unhealthy, …)") — that producer (a Plan-005 driver-health path) supplies a
// non-empty `degradedCapabilities`. But T3.6's producer is HEARTBEAT-STALENESS
// degradation: a node whose `last_heartbeat_at` aged past `30s` is reachable-but-
// stale with NO per-capability signal, so it carries `degradedCapabilities: []`
// and a `detail` staleness reason. The schema must accommodate BOTH, so
// `degradedCapabilities` is deliberately NOT required-non-empty (`z.array` with
// NO `.min(1)`) — a required-non-empty array would reject the staleness producer
// outright. `detail` IS required (a degraded event always explains itself): it is
// `wireFreeFormString`, whose `.min(1)` (session.ts:118) already rejects an empty
// / whitespace-only detail, so the staleness producer MUST pass a non-empty
// reason string (e.g. "heartbeat stale: ...").
//
// `degradedCapabilities` elements reuse `RUNTIME_NODE_CAPABILITY_KEY_MAX_LEN`
// (line 626) — the SAME bounded cap-key realization as `capability` on the
// `capability_declared` / `capability_updated` payloads — so a capability key is
// length-bounded + NUL-guarded identically wherever it appears. NO
// `lastHeartbeatAt` here (that field is `offline`-only, line 766): a degraded
// node is still heartbeating-but-stale OR capability-impaired; the last-heartbeat
// timestamp is the OFFLINE event's evidence, not degraded's.
//
// TYPING — single-`T` `z.ZodType<T>`, `.strict()`, EXPORTED (const + interface),
// built via `buildRuntimeNodeLifecycleBaseShape()` + extension — mirrors the
// `RuntimeNodeOfflinePayloadSchema` above (lines 769-775) exactly. NON-INPUT
// event payload (constructed daemon-side, validated at the emission boundary with
// `.parse()`), so no double-T input-inference bridge — same stance as the 5
// Phase-2 payload schemas (see the §TYPING note at lines 581-595).
export interface RuntimeNodeDegradedPayload {
  sessionId?: SessionId | undefined;
  nodeId: NodeId;
  previousState?: NodeState | undefined;
  newState: NodeState;
  actor?: string | null | undefined;
  degradedCapabilities: string[];
  detail: string;
}
export const RuntimeNodeDegradedPayloadSchema: z.ZodType<RuntimeNodeDegradedPayload> = z
  .object({
    ...buildRuntimeNodeLifecycleBaseShape(),
    // NO `.min(1)` — see the two-producer rationale above. The staleness producer
    // (T3.6) carries `[]`; the capability-degradation producer carries a non-empty
    // set. Element bound reuses the canonical capability-key cap.
    degradedCapabilities: z.array(
      wireFreeFormString(
        RUNTIME_NODE_CAPABILITY_KEY_MAX_LEN,
        "RuntimeNodeDegradedPayload.degradedCapabilities[]",
      ),
    ),
    // REQUIRED non-empty (wireFreeFormString `.min(1)`): a degraded event always
    // carries a human-readable reason — the staleness detail or the capability-
    // health detail. Bounded at the wire/replay trust boundary like the other
    // free-form payload strings.
    detail: wireFreeFormString(EVENT_FIELD_MAX_LEN, "RuntimeNodeDegradedPayload.detail"),
  })
  .strict();

// --------------------------------------------------------------------------
// runtime_node.capability_declared — REDUCED base + {capability, capabilityDetails}.
// --------------------------------------------------------------------------
//
// Spec-006:379 ("base + {capability, capabilityDetails}"). Emitted by the T2.2
// capability-service when a node declares a new capability after registration.
//
// NAMING NOTE — this `RuntimeNodeCapabilityDeclaredPayload` is a SUPERSET of the
// canonical interface of the same name in api-payload-contracts.md §Plan-006
// (line 729), which lists the EXTENSION fields only (`capability`,
// `capabilityDetails`). Our schema = Spec-006's REDUCED base (`{sessionId?,
// nodeId, actor?}`) + that doc's extension fields; it does not contradict the
// canonical interface, it carries the base the canonical doc's extension-only
// listing omits (the canonical doc documents extensions inline, per Spec-006:368).
//
// `capabilityDetails` ships as interim-opaque `z.record(z.string(), z.unknown())`
// — marker `Plan-006-Tier-4-binds-canonical`: the canonical `CapabilityDetails`
// (`{flags: Record<DriverCapabilityFlag, boolean>; contractVersion: string;
// tools: NormalizedProviderToolMetadata[]}`, api-payload-contracts.md:721)
// consumes Plan-005's `provider-driver.ts` types (`DriverCapabilityFlag`,
// `NormalizedProviderToolMetadata`) which DO NOT EXIST yet. This is an HONEST
// forward-dependency mirroring the existing loose `capabilities` at line 164, NOT
// the lazy-`Record` anti-pattern (CP-003-1). Plan-006 Tier 4 EXTENDs by binding
// the canonical `CapabilityDetails` over this field.
export interface RuntimeNodeCapabilityDeclaredPayload {
  sessionId?: SessionId | undefined;
  nodeId: NodeId;
  actor?: string | null | undefined;
  capability: string;
  capabilityDetails: Record<string, unknown>;
}
export const RuntimeNodeCapabilityDeclaredPayloadSchema: z.ZodType<RuntimeNodeCapabilityDeclaredPayload> =
  z
    .object({
      ...buildRuntimeNodeCapabilityBaseShape(),
      capability: wireFreeFormString(
        RUNTIME_NODE_CAPABILITY_KEY_MAX_LEN,
        "RuntimeNodeCapabilityDeclaredPayload.capability",
      ),
      // Interim-opaque — Plan-006-Tier-4-binds-canonical `CapabilityDetails`.
      capabilityDetails: z.record(z.string(), z.unknown()),
    })
    .strict();

// --------------------------------------------------------------------------
// runtime_node.capability_updated — REDUCED base + {capability, previousState, newState}.
// --------------------------------------------------------------------------
//
// Spec-006:380 ("base + {capability, previousState, newState}"). Emitted by the
// T2.2 capability-service on a capability health/config change. CRITICAL: here
// `previousState` / `newState` are `CapabilityDetails` SNAPSHOTS (so consumers
// diff capability snapshots structurally — api-payload-contracts.md:735-740),
// NOT `NodeState` values. This is exactly why this event uses the REDUCED base:
// a base `previousState`/`newState: NodeState` would collide with these
// capability-snapshot fields of the same name. Both ship as interim-opaque
// `z.record(z.string(), z.unknown())` — marker `Plan-006-Tier-4-binds-canonical`,
// same honest-forward-dep on Plan-005's absent `provider-driver.ts` types as
// `capabilityDetails` above.
export interface RuntimeNodeCapabilityUpdatedPayload {
  sessionId?: SessionId | undefined;
  nodeId: NodeId;
  actor?: string | null | undefined;
  capability: string;
  previousState: Record<string, unknown>;
  newState: Record<string, unknown>;
}
export const RuntimeNodeCapabilityUpdatedPayloadSchema: z.ZodType<RuntimeNodeCapabilityUpdatedPayload> =
  z
    .object({
      ...buildRuntimeNodeCapabilityBaseShape(),
      capability: wireFreeFormString(
        RUNTIME_NODE_CAPABILITY_KEY_MAX_LEN,
        "RuntimeNodeCapabilityUpdatedPayload.capability",
      ),
      // Interim-opaque CapabilityDetails snapshots — Plan-006-Tier-4-binds-
      // canonical. `previousState`/`newState` are CAPABILITY snapshots, NOT
      // `NodeState` (the reason this event uses the reduced base, above).
      previousState: z.record(z.string(), z.unknown()),
      newState: z.record(z.string(), z.unknown()),
    })
    .strict();

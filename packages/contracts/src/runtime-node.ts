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
// whose comment (lines 95-97) reserves it for exactly this surface. It is the
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
// member (declared `z.ZodType<RuntimeNodeHealthState>` at line 105 — its `Input`
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
// `RUNTIME_NODE_CAPABILITY_UPDATE_REASON_MAX_LEN` (line 204) and
// `INVITE_REVOKE_REASON_MAX_LEN` (invites.ts:98) — same per-operation
// convention: each operation owns its OWN reason cap rather than sharing a
// single package-wide constant. The capability-update comment at lines 200-203
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
// `reason?: string | undefined` stance at invites.ts:184 / runtime-node.ts:232).

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
// line 59) and `wireFreeFormString(...).optional()` (`wireFreeFormString`
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

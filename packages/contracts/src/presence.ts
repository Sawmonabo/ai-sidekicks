// Presence contracts — request/response payloads for Plan-002 Phase 1 presence
// surfaces (heartbeat ingestion, JSON-RPC update push, JSON-RPC read).
//
// These shapes implement the C4 acceptance criterion (Plan-002 §C4, Spec-002
// line 84): `PresenceHeartbeat` carries the 5 required metadata fields
// `{deviceType, focusedSessionId, focusedChannelId, lastActivityAt, appVisible}`.
//
// Canonical wire forms live in
// docs/architecture/contracts/api-payload-contracts.md:
//   * line 119          — `PresenceState = "online" | "idle" | "reconnecting" | "offline"`
//   * line 120          — `JoinMode = "viewer" | "collaborator" | "runtime contributor"`
//   * lines 412-417     — `PresenceHeartbeatRequest {participantId, deviceId, activityState}`
//                         (response: 204 No Content, fire-and-forget)
//   * lines 420-424     — `PresenceUpdateParams {sessionId, awarenessState: Uint8Array}`
//                         (JSON-RPC, local IPC, daemon → client push)
//   * lines 426-436     — `PresenceReadParams {sessionId}` + `PresenceReadResult {participants}`
//                         (JSON-RPC, local IPC)
//
// Wire-doc reconciliation — `PresenceHeartbeat` outer + metadata:
//
//   `api-payload-contracts.md:417-421` shows ONLY the outer 3 fields
//   `{participantId, deviceId, activityState}`. Spec-002 line 59 + line 84
//   mandate 5 ADDITIONAL metadata fields the heartbeat MUST carry:
//   `{deviceType, focusedSessionId, focusedChannelId, lastActivityAt, appVisible}`.
//
//   We merge both: the 3 outer api-payload-contracts.md fields plus a nested
//   `metadata` sub-object holding the 5 Spec-002 fields. ALL 5 metadata fields
//   are REQUIRED — the keys are always present in the payload per Spec-002:59
//   ("must include at minimum") and Spec-002:84 (canonical 5-field list).
//   `focusedSessionId` and `focusedChannelId` accept explicit `null` (NOT
//   undefined, NOT absent) so heartbeats can fire when no session/channel is
//   focused without omitting the wire key. The no-focus case is serialized as
//   `null` on the wire, preserving the "5 keys always present" floor.
//
//   `api-payload-contracts.md:417-421` is INCOMPLETE relative to Spec-002 line
//   59 + line 84 — the canonical wire doc lacks the metadata sub-object
//   entirely. A follow-up doc edit to align the wire form is recommended
//   (out of scope here; broad-impact governance file). The aligned wire
//   form should match this file: 5-required keys, focusedSessionId and
//   focusedChannelId nullable on the value branch.
//
// Canonical `JoinMode` home:
//
//   `api-payload-contracts.md:124` binds `JoinMode` as the canonical enum
//   (also used by `InviteCreateRequest.joinMode: JoinMode` at
//   api-payload-contracts.md:383). This file owns the canonical
//   declaration; `InviteCreate.joinMode` in `invites.ts` consumes
//   `JoinMode` / `JoinModeSchema` via direct import. The canonical home
//   is presence.ts because the wire-doc authority for `JoinMode` lives
//   in `api-payload-contracts.md` §Presence (line 120) adjacent to the
//   `JoinMode` definition.
//
// Naming convention — Request/Response vs Params/Result:
//
//   The api-payload-contracts.md JSON-RPC sections use
//   `PresenceUpdateParams` / `PresenceReadParams` / `PresenceReadResult`
//   (the conventional JSON-RPC naming). The wider @ai-sidekicks/contracts
//   package convention is `XxxRequest` / `XxxResponse` (per session.ts).
//   This file follows the package convention for consistency with
//   `SessionReadRequest`, `SessionJoinRequest`, etc.; the surface names
//   differ from the canonical doc's JSON-RPC labels but the WIRE SHAPES
//   are identical.
//
// I-002-3 reminder — presence is in-memory only:
//
//   `Plan-002 §Invariants I-002-3` and Spec-002 lines 155-157 declare
//   presence state (Yjs Awareness CRDT) MUST live in memory only and MUST
//   be garbage-collected on disconnect. These schemas are for WIRE TRANSIT
//   ONLY; they MUST NOT be persisted to SQLite or Postgres. P10 in
//   Plan-002 (T2.5) is the migration-shape regression test that pins the
//   ephemeral invariant on the storage side.
//
// `isolatedDeclarations: true` (from tsconfig.base.json) forbids inferred
// types on exported declarations — every exported schema is explicitly
// annotated with `z.ZodType<T, T>` (the double-T shape required for
// Standard-Schema-V1 input inference in tRPC v11 per ADR-014). Schemas are
// non-transforming, so pre-validation Input ≡ post-validation Output ≡ T.
//
// Refs: Spec-002 §Required Behavior (lines 41-50), §Default Behavior (lines
// 53-62), §Interfaces And Contracts (lines 78-89), §State And Data
// Implications (lines 155-157); Plan-002 §Phase 1 (C4) + §Invariants I-002-3;
// docs/architecture/contracts/api-payload-contracts.md §Shared Enums
// (lines 119-120) + §Tier 2 — Plan-002 (lines 412-436); ADR-014 (tRPC v11 /
// Standard Schema V1), ADR-022 (toolchain — Zod 4.x).
import { z } from "zod";

import { SubscribeAckResponseSchema, type SubscribeAckResponse } from "./jsonrpc-streaming.js";
import {
  ChannelIdSchema,
  ParticipantIdSchema,
  SessionIdSchema,
  wireFreeFormString,
  type ChannelId,
  type ParticipantId,
  type SessionId,
} from "./session.js";

// --------------------------------------------------------------------------
// Re-exports from session.ts
// --------------------------------------------------------------------------
//
// Consumers wiring up presence flows should `import { ... } from
// "@ai-sidekicks/contracts"` and get all the related symbols in one shot.
// session.ts remains the single source of truth (Plan-001 Phase 2 ownership);
// this file does NOT re-declare any of these symbols.
//
// Type-only re-exports MUST use `export type { ... }` (the `isolatedModules`
// + `verbatimModuleSyntax` posture from tsconfig.base.json forbids erased
// re-exports on the runtime form).

export type { ChannelId, ParticipantId, SessionId } from "./session.js";
export { ChannelIdSchema, ParticipantIdSchema, SessionIdSchema } from "./session.js";

// --------------------------------------------------------------------------
// PresenceState — canonical lifecycle enum (api-payload-contracts.md:123)
// --------------------------------------------------------------------------
//
// Exactly 4 states per Spec-002 line 47 + api-payload-contracts.md:123.
// Adding `"away"` / `"busy"` / `"focused"` here is a contract break and
// requires the spec edit FIRST per AGENTS.md "doc-first ordering".

export type PresenceState = "online" | "idle" | "reconnecting" | "offline";
export const PresenceStateSchema: z.ZodType<PresenceState, PresenceState> = z.enum([
  "online",
  "idle",
  "reconnecting",
  "offline",
]);

// --------------------------------------------------------------------------
// JoinMode — canonical enum (api-payload-contracts.md:124 + :383)
// --------------------------------------------------------------------------
//
// Canonical name per api-payload-contracts.md:124; also referenced by
// `InviteCreateRequest.joinMode: JoinMode` at api-payload-contracts.md:383.
// This file owns the canonical declaration; `InviteCreate.joinMode` in
// `invites.ts` consumes `JoinMode` / `JoinModeSchema` via direct import.
//
// "runtime contributor" includes the SPACE — preserved verbatim from the
// canonical enum. Editing to "runtime_contributor" / "runtimeContributor"
// is a contract break and requires the spec edit FIRST.
//
// Why double-T: `JoinMode` composes into request schemas at the invite
// layer (`InviteCreateSchema` in invites.ts) and future Phase 2
// service-layer types; the double-T annotation preserves
// Standard-Schema-V1 input inference for any tRPC v11 consumer per ADR-014.

export type JoinMode = "viewer" | "collaborator" | "runtime contributor";
export const JoinModeSchema: z.ZodType<JoinMode, JoinMode> = z.enum([
  "viewer",
  "collaborator",
  "runtime contributor",
]);

// --------------------------------------------------------------------------
// Defense-in-depth length caps
// --------------------------------------------------------------------------
//
// `DEVICE_ID_MAX_LEN` — opaque client-supplied device identifier (UUID-like
// or platform-specific token, e.g. iOS deviceID / Windows machine GUID).
// 256 chars is generous slack for any reasonable format; the framework
// body-size cap (owned by Plan-004/005) is the authoritative limit.
//
// `DEVICE_TYPE_MAX_LEN` — short categorical string ("desktop", "mobile",
// "cli", "ios", etc.). 64 chars matches `IDENTITY_HANDLE_MAX_LEN` order.
//
// Both caps are composed with `wireFreeFormString` at the schema layer (see
// the `PresenceHeartbeatSchema` definition below), which layers on the
// canonical wire-trust-boundary guards from session.ts:118: `.min(1)`,
// NUL-byte rejection (OpenTelemetry log-injection guard), and whitespace-
// only rejection. The fields are wire input from cross-process / cross-node
// callers — even though clients EMIT these values (rather than humans
// TYPING them), schema-level guards are required because client trust is
// not the wire layer's to assume.

export const DEVICE_ID_MAX_LEN = 256;
export const DEVICE_TYPE_MAX_LEN = 64;

// --------------------------------------------------------------------------
// C4 — PresenceHeartbeat (Spec-002 line 59 + line 84;
//      api-payload-contracts.md:417-421 merged with Spec-002 metadata fields)
// --------------------------------------------------------------------------
//
// Wire shape merges two governance sources:
//
//   1. `api-payload-contracts.md:417-421` outer fields (3 required):
//      `{participantId: ParticipantId, deviceId: string, activityState: PresenceState}`
//
//   2. Spec-002 line 59 + line 84 metadata sub-object (all 5 REQUIRED; 2 nullable):
//      `metadata: {
//        deviceType: string;                       // required
//        focusedSessionId: SessionId | null;       // REQUIRED key, nullable value
//        focusedChannelId: ChannelId | null;       // REQUIRED key, nullable value
//        lastActivityAt: string;                   // required, ISO 8601 timestamp
//        appVisible: boolean;                      // required
//      }`
//
// All 3 outer fields and ALL 5 metadata fields are REQUIRED at parse time —
// the keys MUST be present in every heartbeat payload. The two nullable
// metadata fields (`focusedSessionId`, `focusedChannelId`) encode the no-
// focus case as serialized `null` (the key is present with value `null`),
// NOT as an absent key. Heartbeats fire on the daemon-bound transport
// regardless of whether the user is currently focused on a session or
// channel; the no-focus case ships `null` and the schema accepts it.
//
// Why nullable, not optional: Spec-002:59 ("must include at minimum:
// deviceType, focusedSessionId, focusedChannelId, lastActivityAt,
// appVisible") and Spec-002:84 (canonical 5-field list) bind the FIELD SET
// — the floor, not "candidate fields some of which may be absent". The
// `.nullable()` shape preserves "5 keys always present" while admitting
// the no-focus runtime case. `.optional()` would let producers omit the
// key entirely, violating the spec floor; `.nullish()` would re-admit the
// absent-key case under a different name — explicitly NOT used here.
//
// `.strict()` on the outer object AND the nested metadata object rejects
// unknown keys at parse time, surfacing schema drift early. Matches the
// convention used by every other request schema in this package (see
// `SessionCreateRequest`, `InviteCreate`, `MembershipUpdate`).
//
// `lastActivityAt` follows the session.ts ISO 8601 convention (RFC 3339
// §5.6 — accepts both Z-suffixed UTC and numeric offsets like "+00:00").

export interface PresenceHeartbeat {
  participantId: ParticipantId;
  deviceId: string;
  activityState: PresenceState;
  metadata: {
    deviceType: string;
    focusedSessionId: SessionId | null;
    focusedChannelId: ChannelId | null;
    lastActivityAt: string;
    appVisible: boolean;
  };
}

// `z.ZodType<T, T>` — see SessionCreateRequestSchema for rationale (preserves
// Standard-Schema-V1 input inference for tRPC v11 consumers).
export const PresenceHeartbeatSchema: z.ZodType<PresenceHeartbeat, PresenceHeartbeat> = z
  .object({
    participantId: ParticipantIdSchema,
    deviceId: wireFreeFormString(DEVICE_ID_MAX_LEN, "PresenceHeartbeat.deviceId"),
    activityState: PresenceStateSchema,
    metadata: z
      .object({
        deviceType: wireFreeFormString(
          DEVICE_TYPE_MAX_LEN,
          "PresenceHeartbeat.metadata.deviceType",
        ),
        focusedSessionId: SessionIdSchema.nullable(),
        focusedChannelId: ChannelIdSchema.nullable(),
        lastActivityAt: z.iso.datetime({ offset: true }),
        appVisible: z.boolean(),
      })
      .strict(),
  })
  .strict();

// --------------------------------------------------------------------------
// PresenceUpdate — JSON-RPC local IPC, daemon → client push
// --------------------------------------------------------------------------
//
// Exact wire shape (api-payload-contracts.md:424-428):
//   `{sessionId: SessionId, awarenessState: Uint8Array}`
//
// `awarenessState` is the serialized Yjs Awareness CRDT (binary format
// owned by `y-protocols/awareness`). At the contract layer we accept any
// `Uint8Array` instance — the CRDT-format validity check belongs to the
// Plan-002 Phase 3 presence service consumer, not the wire schema.
//
// Note on `Buffer`: Node's `Buffer extends Uint8Array`, so `z.instanceof(Uint8Array)`
// accepts `Buffer` instances. This is intentional — daemon-side producers
// frequently emit `Buffer` from the Yjs encoder, and forcing a copy at the
// contract layer would be wasteful. A regression test pins this behavior.
//
// One-way push — no Request/Response split. The daemon initiates each
// `PresenceUpdate` notification independently; there is no client-side
// response payload (the JSON-RPC framing handles ack at the substrate
// layer per Plan-007-partial).

export interface PresenceUpdate {
  sessionId: SessionId;
  awarenessState: Uint8Array;
}

// `z.ZodType<T, T>` — see SessionCreateRequestSchema for rationale (preserves
// Standard-Schema-V1 input inference for tRPC v11 consumers).
export const PresenceUpdateSchema: z.ZodType<PresenceUpdate, PresenceUpdate> = z
  .object({
    sessionId: SessionIdSchema,
    awarenessState: z.instanceof(Uint8Array),
  })
  .strict();

// --------------------------------------------------------------------------
// PresenceRead — JSON-RPC local IPC, client → daemon query
// --------------------------------------------------------------------------
//
// Request shape (api-payload-contracts.md:430-433):
//   `{sessionId: SessionId}`
//
// Response shape (api-payload-contracts.md:434-440):
//   `{participants: Array<{participantId: ParticipantId, state: PresenceState, lastSeen: string}>}`
//
// `lastSeen` follows the same ISO 8601 wire convention as `lastActivityAt`
// on `PresenceHeartbeat.metadata` (RFC 3339 §5.6 — accepts Z-suffixed UTC
// and numeric offsets). Plan-002 Phase 3 service code (CP-002-1) is the
// authority on canonical normalization at projection time.

export interface PresenceReadRequest {
  sessionId: SessionId;
}

// `z.ZodType<T, T>` — see SessionCreateRequestSchema for rationale (preserves
// Standard-Schema-V1 input inference for tRPC v11 consumers).
export const PresenceReadRequestSchema: z.ZodType<PresenceReadRequest, PresenceReadRequest> = z
  .object({
    sessionId: SessionIdSchema,
  })
  .strict();

export interface PresenceReadResponseParticipant {
  participantId: ParticipantId;
  state: PresenceState;
  lastSeen: string;
}

export interface PresenceReadResponse {
  participants: PresenceReadResponseParticipant[];
}

// Per-participant projection element — `.strict()` rejects unknown keys at
// parse time, surfacing schema drift early. Used inline by
// `PresenceReadResponseSchema` below.
const PresenceReadResponseParticipantSchema: z.ZodType<
  PresenceReadResponseParticipant,
  PresenceReadResponseParticipant
> = z
  .object({
    participantId: ParticipantIdSchema,
    state: PresenceStateSchema,
    lastSeen: z.iso.datetime({ offset: true }),
  })
  .strict();

export const PresenceReadResponseSchema: z.ZodType<PresenceReadResponse, PresenceReadResponse> = z
  .object({
    participants: z.array(PresenceReadResponseParticipantSchema),
  })
  .strict();

// --------------------------------------------------------------------------
// PresenceSubscribe — JSON-RPC local IPC subscribe-init
// --------------------------------------------------------------------------
//
// `presence.subscribe` is the streaming subscribe-init surface for the
// daemon → client presence push (Spec-002 §Interfaces And Contracts line 85;
// Spec-007 §Wire Format lines 50-56 streaming subscribe primitive). The
// handler returns a `{subscriptionId}` ack synchronously; live Yjs Awareness
// CRDT deltas then flow as `$/subscription/notify` frames carrying
// `PresenceUpdate` values.
//
// Plan-002 owns the `presence.*` namespace wire contract (Plan-002 §Phase 3,
// CP-002-2). Per BL-102 no-mirror disposition, `api-payload-contracts.md`
// does not maintain a doc-side mirror of this code-side typed surface.

/**
 * The `presence.subscribe` request — carries only `{sessionId}`.
 *
 * Structurally identical to `PresenceReadRequest` today, but a DISTINCT
 * semantic type: a subscribe is not a read. Keeping them separate lets the
 * two surfaces diverge independently if either request later gains a field,
 * with zero churn on the other.
 *
 * Carries NO replay cursors — unlike `SessionSubscribeRequest`, which carries
 * `afterCursor` / `lastEventId` for durable event-log replay. Presence pushes
 * live in-memory CRDT state (Plan-002 §Invariants I-002-3: presence is
 * in-memory only); there is no durable cursor to replay, so the request stays
 * minimal.
 */
export interface PresenceSubscribeRequest {
  sessionId: SessionId;
}

// Double-T per this file's uniform annotation convention (header lines 73-77;
// cf. `PresenceReadRequestSchema`). Note: `presence.subscribe` is a
// runtime-daemon local-IPC JSON-RPC method today, NOT a tRPC procedure — the
// double-T is for file-wide annotation uniformity, not a live tRPC-input
// requirement.
export const PresenceSubscribeRequestSchema: z.ZodType<
  PresenceSubscribeRequest,
  PresenceSubscribeRequest
> = z
  .object({
    sessionId: SessionIdSchema,
  })
  .strict();

/**
 * The `presence.subscribe` init ack — an ALIAS SEAM over the canonical
 * generic `SubscribeAckResponse` (jsonrpc-streaming.ts), mirroring
 * `SessionSubscribeResponse`. Today it is EXACTLY `{subscriptionId}`,
 * identical to every other `*.subscribe` method's ack.
 *
 * Minting a named presence symbol (rather than borrowing `session`'s) gives
 * `presence.subscribe` its own wire contract and symmetry with the session
 * surface. If presence's ack ever diverges, this seam becomes
 * `export interface PresenceSubscribeResponse extends SubscribeAckResponse { … }`
 * plus its own schema — localized here, zero consumer churn, and additive per
 * ADR-018 §Decision #1 (MINOR widening, the `subscriptionId` floor preserved).
 */
export type PresenceSubscribeResponse = SubscribeAckResponse;

// SINGLE-T annotation here, deviating from this file's double-T norm:
// `SubscribeAckResponseSchema` is typed `z.ZodType<SubscribeAckResponse>`
// (single-T, Input = unknown). Under Zod 4's `class ZodType<out Output, out
// Input>`, assigning that single-T schema to a double-T annotation
// (`z.ZodType<X, X>`) fails the covariant `out Input` check (`unknown` is not
// assignable to `X`). Single-T is also semantically correct: a response is an
// alias of a single-T generic and is NOT a tRPC procedure input, so it does
// not need the double-T input-inference form (the session response schema is
// single-T for the same reason).
export const PresenceSubscribeResponseSchema: z.ZodType<PresenceSubscribeResponse> =
  SubscribeAckResponseSchema;

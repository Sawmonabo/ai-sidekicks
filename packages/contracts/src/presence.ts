// Presence contracts — request/response payloads for the presence surfaces
// (heartbeat ingestion, JSON-RPC update push, JSON-RPC read, JSON-RPC
// subscribe).
//
// Presence describes the ONE user's linked DEVICES, never a roster of people.
// Every shape below is keyed on `deviceId`: a heartbeat reports one device's
// liveness, and a read projects the set of devices currently bound to a
// session.
//
// `PresenceState` is the canonical device-liveness enum. The heartbeat carries
// the five metadata fields a device reports about itself
// (`{deviceType, focusedSessionId, focusedChannelId, lastActivityAt,
// appVisible}`).
//
// Presence is in-memory only: these schemas are for WIRE TRANSIT ONLY and MUST
// NOT be persisted to SQLite or Postgres. The register service garbage-collects
// device state on disconnect.
//
// Naming convention — Request/Response vs Params/Result: this package's
// convention is `XxxRequest` / `XxxResponse` (per session.ts), which this file
// follows for consistency with `SessionReadRequest` et al.
//
// `isolatedDeclarations: true` (from tsconfig.base.json) forbids inferred
// types on exported declarations — every exported schema is explicitly
// annotated with `z.ZodType<T, T>` (the double-T shape required for
// Standard-Schema-V1 input inference in tRPC v11). Schemas are
// non-transforming, so pre-validation Input ≡ post-validation Output ≡ T.
import { z } from "zod";

import { SubscribeAckResponseSchema, type SubscribeAckResponse } from "./jsonrpc-streaming.js";
import {
  ChannelIdSchema,
  SessionIdSchema,
  wireFreeFormString,
  type ChannelId,
  type SessionId,
} from "./session.js";

// --------------------------------------------------------------------------
// Re-exports from session.ts
// --------------------------------------------------------------------------
//
// Consumers wiring up presence flows should `import { ... } from
// "@ai-sidekicks/contracts"` and get all the related symbols in one shot.
// session.ts remains the single source of truth; this file does NOT re-declare
// any of these symbols.
//
// Type-only re-exports MUST use `export type { ... }` (the `isolatedModules`
// + `verbatimModuleSyntax` posture from tsconfig.base.json forbids erased
// re-exports on the runtime form).

export type { ChannelId, SessionId } from "./session.js";
export { ChannelIdSchema, SessionIdSchema } from "./session.js";

// --------------------------------------------------------------------------
// PresenceState — canonical device-liveness enum
// --------------------------------------------------------------------------
//
// Exactly 4 states. Adding `"away"` / `"busy"` / `"focused"` here is a
// contract break.

export type PresenceState = "online" | "idle" | "reconnecting" | "offline";
export const PresenceStateSchema: z.ZodType<PresenceState, PresenceState> = z.enum([
  "online",
  "idle",
  "reconnecting",
  "offline",
]);

// --------------------------------------------------------------------------
// Defense-in-depth length caps
// --------------------------------------------------------------------------
//
// `DEVICE_ID_MAX_LEN` — opaque client-supplied device identifier (UUID-like
// or platform-specific token, e.g. iOS deviceID / Windows machine GUID).
// 256 chars is generous slack for any reasonable format; the framework
// body-size cap is the authoritative limit.
//
// `DEVICE_TYPE_MAX_LEN` — short categorical string ("desktop", "mobile",
// "cli", "ios", etc.).
//
// Both caps are composed with `wireFreeFormString` at the schema layer, which
// layers on the canonical wire-trust-boundary guards from session.ts: `.min(1)`,
// NUL-byte rejection (OpenTelemetry log-injection guard), and whitespace-
// only rejection. The fields are wire input from cross-process / cross-node
// callers — even though clients EMIT these values (rather than humans
// TYPING them), schema-level guards are required because client trust is
// not the wire layer's to assume.

export const DEVICE_ID_MAX_LEN = 256;
export const DEVICE_TYPE_MAX_LEN = 64;

// --------------------------------------------------------------------------
// PresenceHeartbeat — one device reporting its own liveness
// --------------------------------------------------------------------------
//
// Outer fields (2 required): `{deviceId, activityState}`.
//
// Metadata sub-object (all 5 REQUIRED; 2 nullable):
//   `metadata: {
//     deviceType: string;                       // required
//     focusedSessionId: SessionId | null;       // REQUIRED key, nullable value
//     focusedChannelId: ChannelId | null;       // REQUIRED key, nullable value
//     lastActivityAt: string;                   // required, ISO 8601 timestamp
//     appVisible: boolean;                      // required
//   }`
//
// Both outer fields and ALL 5 metadata fields are REQUIRED at parse time —
// the keys MUST be present in every heartbeat payload. The two nullable
// metadata fields (`focusedSessionId`, `focusedChannelId`) encode the no-
// focus case as serialized `null` (the key is present with value `null`),
// NOT as an absent key. Heartbeats fire on the daemon-bound transport
// regardless of whether the device is currently focused on a session or
// channel.
//
// Why nullable, not optional: the FIELD SET is the floor. The `.nullable()`
// shape preserves "5 keys always present" while admitting the no-focus
// runtime case. `.optional()` would let producers omit the key entirely;
// `.nullish()` would re-admit the absent-key case under a different name —
// explicitly NOT used here.
//
// `.strict()` on the outer object AND the nested metadata object rejects
// unknown keys at parse time, surfacing schema drift early.
//
// `lastActivityAt` follows the session.ts ISO 8601 convention (RFC 3339
// — accepts both Z-suffixed UTC and numeric offsets like "+00:00").

export interface PresenceHeartbeat {
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
// Wire shape: `{sessionId: SessionId, awarenessState: Uint8Array}`
//
// `awarenessState` is the serialized Yjs Awareness CRDT (binary format
// owned by `y-protocols/awareness`). At the contract layer we accept any
// `Uint8Array` instance — the CRDT-format validity check belongs to the
// presence service consumer, not the wire schema.
//
// Note on `Buffer`: Node's `Buffer extends Uint8Array`, so `z.instanceof(Uint8Array)`
// accepts `Buffer` instances. This is intentional — daemon-side producers
// frequently emit `Buffer` from the Yjs encoder, and forcing a copy at the
// contract layer would be wasteful. A regression test pins this behavior.
//
// One-way push — no Request/Response split. The daemon initiates each
// `PresenceUpdate` notification independently; there is no client-side
// response payload (the JSON-RPC framing handles ack at the substrate layer).

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
// Request shape:  `{sessionId: SessionId}`
// Response shape: `{devices: Array<{deviceId, deviceType, appVisible, state,
//                 lastSeen}>}`
//
// The reply enumerates the one user's DEVICES bound to the session. There is
// no participant axis: every device belongs to the same user.
//
// `lastSeen` follows the same ISO 8601 wire convention as `lastActivityAt`
// on `PresenceHeartbeat.metadata` (RFC 3339 section 5.6 — accepts Z-suffixed UTC
// and numeric offsets). The presence register service is the authority on
// canonical normalization at projection time.

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

export interface PresenceReadResponseDevice {
  deviceId: string;
  deviceType: string;
  appVisible: boolean;
  state: PresenceState;
  lastSeen: string;
}

export interface PresenceReadResponse {
  devices: PresenceReadResponseDevice[];
}

// Per-device projection element — `.strict()` rejects unknown keys at parse
// time, surfacing schema drift early. Used inline by
// `PresenceReadResponseSchema` below.
const PresenceReadResponseDeviceSchema: z.ZodType<
  PresenceReadResponseDevice,
  PresenceReadResponseDevice
> = z
  .object({
    deviceId: wireFreeFormString(DEVICE_ID_MAX_LEN, "PresenceReadResponseDevice.deviceId"),
    deviceType: wireFreeFormString(DEVICE_TYPE_MAX_LEN, "PresenceReadResponseDevice.deviceType"),
    appVisible: z.boolean(),
    state: PresenceStateSchema,
    lastSeen: z.iso.datetime({ offset: true }),
  })
  .strict();

export const PresenceReadResponseSchema: z.ZodType<PresenceReadResponse, PresenceReadResponse> = z
  .object({
    devices: z.array(PresenceReadResponseDeviceSchema),
  })
  .strict();

// --------------------------------------------------------------------------
// PresenceSubscribe — JSON-RPC local IPC subscribe-init
// --------------------------------------------------------------------------
//
// `presence.subscribe` is the streaming subscribe-init surface for the
// daemon → client presence push. The handler returns a `{subscriptionId}` ack
// synchronously; live Yjs Awareness CRDT deltas then flow as
// `$/subscription/notify` frames carrying `PresenceUpdate` values.

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
 * live in-memory CRDT state; there is no durable cursor to replay, so the
 * request stays minimal.
 */
export interface PresenceSubscribeRequest {
  sessionId: SessionId;
}

// Double-T per this file's uniform annotation convention (cf.
// `PresenceReadRequestSchema`). Note: `presence.subscribe` is a runtime-daemon
// local-IPC JSON-RPC method today, NOT a tRPC procedure — the double-T is for
// file-wide annotation uniformity, not a live tRPC-input requirement.
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
 * plus its own schema — localized here, zero consumer churn, and additive (a
 * MINOR widening, the `subscriptionId` floor preserved).
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

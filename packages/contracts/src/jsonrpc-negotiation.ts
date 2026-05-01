// JSON-RPC protocol-negotiation contracts — `DaemonHello` / `DaemonHelloAck`
// wire envelopes for Plan-007 Phase 2 (T-007p-2-4).
//
// This file owns the CROSS-PACKAGE wire shape every protocol-negotiation
// participant agrees on. The runtime IMPLEMENTATION (the registry registration,
// per-connection state machine, and mutating-op gate) lives in
// `packages/runtime-daemon/src/ipc/protocol-negotiation.ts` (T-007p-2-4
// sibling).
//
// Spec coverage:
//   * Spec-007 §Required Behavior line 47
//     (docs/specs/007-local-ipc-and-daemon-control.md) — "Local IPC must
//     support protocol version negotiation before mutating operations are
//     accepted."
//   * Spec-007 §Fallback Behavior lines 67-68 — "If version negotiation
//     fails, read-only compatibility may continue, but mutating operations
//     must be blocked until versions are compatible."
//   * Spec-007 §Interfaces And Contracts line 73 —
//     "`DaemonHello` and `DaemonHelloAck` must perform version negotiation."
//
// Invariants this file's interface enforces (canonical text in
// docs/plans/007-local-ipc-and-daemon-control.md §Invariants lines 95-117):
//   * I-007-7 — schema validation runs before handler dispatch. The
//     `DaemonHelloRequestSchema` / `DaemonHelloAckSchema` are registered
//     against the registry surface so the standard schema-validates-before-
//     dispatch path applies to the negotiation envelopes themselves.
//
// What this file does NOT define (deferred to sibling files):
//   * Per-connection negotiation state, the mutating-op gate, the
//     `wrap(registry)` middleware, and the `daemon.hello` handler — all
//     owned by `packages/runtime-daemon/src/ipc/protocol-negotiation.ts`.
//   * The negotiation algorithm constants (`DAEMON_SUPPORTED_PROTOCOL_VERSIONS`)
//     — daemon-internal; declared in the runtime file, not exported on the wire.
//   * JSON-RPC numeric error code mapping for negotiation failures — owned
//     by T-007p-2-2 (`jsonrpc-error-mapping.ts`). Per the canonical mapping
//     table at error-contracts.md §JSON-RPC Wire Mapping (BL-103 ratified
//     2026-05-01), `protocol.handshake_required` and `protocol.version_mismatch`
//     ride as `data.type` on a `-32600 InvalidRequest` envelope.
//
// Schema-placement decision (T-007p-2-4 scope extension):
//   The DAG task contract names ONLY
//   `packages/runtime-daemon/src/ipc/protocol-negotiation.ts`. This file is
//   a SCOPE EXTENSION — runtime-daemon's
//   `package.json` deliberately does NOT depend on `zod` (per
//   jsonrpc-registry.ts JSDoc comment "Runtime-daemon's package.json
//   deliberately does NOT list zod"). The negotiation Zod schemas
//   therefore CANNOT live in the daemon package without adding zod as a
//   runtime dep. Cross-package wire-envelope schemas live in
//   `packages/contracts/` alongside `JsonRpcRequest` / `JsonRpcResponse`.
//
// `protocolVersion` ratified as ISO 8601 `YYYY-MM-DD` date-string at
// api-payload-contracts.md §Tier 1 (cont.): Plan-007 (BL-102 closed
// 2026-05-01). The same date-string shape rides on
// `DaemonHello.protocolVersion`, `DaemonHello.supportedProtocols[]`, and
// `DaemonHelloAck.protocolVersion`. Format follows the MCP precedent
// (modelcontextprotocol.io §Architecture overview); the negotiation
// algorithm uses lex-sort to find max version (lex order ≡ chronological
// for ISO 8601).

import { z } from "zod";

// --------------------------------------------------------------------------
// Method-name constant
// --------------------------------------------------------------------------

/**
 * Canonical JSON-RPC method name for the negotiation handshake. The
 * `daemon.hello` string conforms to the dotted-lowercase canonical format
 * ratified at api-payload-contracts.md §JSON-RPC Method-Name Registry
 * (Tier 1 Ratified, 2026-04-30) — registration succeeds against the
 * I-007-9 register-time regex check.
 */
export const DAEMON_HELLO_METHOD = "daemon.hello" as const;
export type DaemonHelloMethod = typeof DAEMON_HELLO_METHOD;

// --------------------------------------------------------------------------
// Per-field length caps — defense-in-depth bounds
// --------------------------------------------------------------------------
//
// The framing layer (`MAX_MESSAGE_BYTES = 1_000_000` in
// `local-ipc-gateway.ts`) is authoritative on overall body size; these
// caps are a SECOND line of defense bounding individual fields. Mirrors
// the pattern in `error.ts` / `event.ts`.

/**
 * Cap on free-form string fields inside the negotiation envelopes
 * (`clientId`, `reason`, capability tags). 256 chars is well above any
 * legitimate identifier (e.g. `cli/0.1.0+a1b2c3d`) but bounded against
 * pathological inputs. Pulled in line with the conservative inline cap
 * pattern in error.ts.
 */
export const NEGOTIATION_FIELD_MAX_LEN = 256;

/**
 * Cap on the size of the `supportedProtocols` array in `DaemonHello`. A
 * client cannot legitimately advertise more than a handful of protocol
 * versions — the cap prevents a pathological client from sending an
 * array large enough to dominate the framing layer's body budget.
 */
export const SUPPORTED_PROTOCOLS_MAX_LEN = 32;

// --------------------------------------------------------------------------
// protocolVersion — ISO 8601 date-string (per api-payload-contracts.md §Tier 1 (cont.): Plan-007)
// --------------------------------------------------------------------------

/**
 * The canonical regex for an ISO 8601 `YYYY-MM-DD` date-string. Exported
 * so the substrate's envelope-level enforcement gate (Spec-007:54 per-
 * request `protocolVersion` field, see `local-ipc-gateway.ts#dispatchFrame`)
 * shares the EXACT shape that `ProtocolVersionSchema` validates inside
 * `daemon.hello` payloads — a single source of truth prevents drift
 * between the wire-frame gate (substrate) and the negotiation handler
 * (registry). The Zod schema below wraps this regex; do not redeclare it.
 */
export const PROTOCOL_VERSION_REGEX: RegExp = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The `protocolVersion` field type — ISO 8601 `YYYY-MM-DD` date-string per
 * api-payload-contracts.md §Tier 1 (cont.): Plan-007 (BL-102 ratified
 * 2026-05-01). The regex (`PROTOCOL_VERSION_REGEX`) enforces the calendar-
 * date shape; the F-007p-2-10 negotiation algorithm uses lex-sort over
 * conforming strings (lex order ≡ chronological for ISO 8601), so no
 * semver parser is needed.
 */
export const ProtocolVersionSchema: z.ZodString = z.string().regex(PROTOCOL_VERSION_REGEX);

// --------------------------------------------------------------------------
// DaemonHello (client → daemon)
// --------------------------------------------------------------------------

/**
 * Free-form bounded string — used for optional `clientId` and capability
 * tags. The per-field length cap is the only defense the wire layer applies;
 * the daemon-side handler MAY apply additional shape-checks (e.g. URL-form
 * for `clientId`) at the application layer.
 */
const NegotiationFreeFormString = z.string().min(1).max(NEGOTIATION_FIELD_MAX_LEN);

/**
 * `DaemonHello` request envelope. Sent by the client (CLI / desktop shell /
 * future SDK consumer) as the FIRST mutating-gated call on every connection.
 *
 * Required fields:
 *   * `protocolVersion` — the client's PRIMARY proposed protocol version
 *     (Spec-007:54 per-request requirement). The daemon uses this as a
 *     fallback when `supportedProtocols` is absent.
 *
 * Optional fields:
 *   * `supportedProtocols` — the full set of protocol versions the client
 *     can speak. Required by F-007p-2-10's negotiation algorithm
 *     (`max(client.supportedProtocols ∩ daemon.supported)`); when absent,
 *     the daemon falls back to treating `protocolVersion` as a singleton
 *     `[protocolVersion]`. Capped at `SUPPORTED_PROTOCOLS_MAX_LEN`
 *     entries.
 *   * `clientId` — opaque client identifier (e.g. `"cli/0.1.0"`,
 *     `"electron/0.1.0"`). The daemon MAY log it; downstream observability
 *     consumers correlate. Free-form bounded string.
 *   * `capabilities` — opaque tag list the client advertises to the daemon
 *     (e.g. feature gates the client supports). The daemon MAY consult to
 *     decide what `serverCapabilities` to advertise back. Each tag is a
 *     bounded string; the array length is capped to mirror
 *     `supportedProtocols`.
 *
 * `.strict()` rejects unknown top-level fields — a client sending an
 * unknown field is a versioning anomaly the daemon should refuse rather
 * than silently ignore.
 */
export const DaemonHelloSchema: z.ZodType<DaemonHello> = z
  .object({
    protocolVersion: ProtocolVersionSchema,
    supportedProtocols: z
      .array(ProtocolVersionSchema)
      .min(1)
      .max(SUPPORTED_PROTOCOLS_MAX_LEN)
      .optional(),
    clientId: NegotiationFreeFormString.optional(),
    capabilities: z.array(NegotiationFreeFormString).max(SUPPORTED_PROTOCOLS_MAX_LEN).optional(),
  })
  .strict() as unknown as z.ZodType<DaemonHello>;

/**
 * The `DaemonHello` request payload. Cast through `unknown` because Zod's
 * inferred type for an object with optional fields under
 * `exactOptionalPropertyTypes: true` does not match the explicit
 * `readonly`-keyed shape we want consumers to see.
 */
export interface DaemonHello {
  readonly protocolVersion: string;
  readonly supportedProtocols?: ReadonlyArray<string>;
  readonly clientId?: string;
  readonly capabilities?: ReadonlyArray<string>;
}

// --------------------------------------------------------------------------
// DaemonHelloAck (daemon → client)
// --------------------------------------------------------------------------

/**
 * Discriminated reason field for an INCOMPATIBLE handshake. F-007p-2-10
 * distinguishes "client too old" (`version.floor_exceeded`) from "client too
 * new" (`version.ceiling_exceeded`). The reason ALSO surfaces if the
 * handshake fired twice on the same connection
 * (`protocol.handshake_already_completed`) — the conservative "fail-second"
 * posture.
 *
 * Strings ratified at error-contracts.md §JSON-RPC Wire Mapping (BL-103
 * closed 2026-05-01). All three are dotted-namespace project codes and
 * surface as `DaemonHelloAck.reason` (NOT as a JSON-RPC numeric — the
 * Ack itself is a successful response that carries `compatible: false`).
 */
export const NEGOTIATION_REASON_FLOOR_EXCEEDED = "version.floor_exceeded" as const;
export const NEGOTIATION_REASON_CEILING_EXCEEDED = "version.ceiling_exceeded" as const;
export const NEGOTIATION_REASON_HANDSHAKE_ALREADY_COMPLETED =
  "protocol.handshake_already_completed" as const;

export type NegotiationIncompatibleReason =
  | typeof NEGOTIATION_REASON_FLOOR_EXCEEDED
  | typeof NEGOTIATION_REASON_CEILING_EXCEEDED
  | typeof NEGOTIATION_REASON_HANDSHAKE_ALREADY_COMPLETED;

/**
 * `DaemonHelloAck` response envelope. The substrate's contract for the
 * mutating-op gate is `compatible: boolean`:
 *
 *   * `compatible === true`  → all dispatches allowed (read + mutating)
 *   * `compatible === false` → read-only dispatches allowed; mutating
 *                              dispatches refused per Spec-007:67-68 + I-007-1
 *
 * Required fields:
 *   * `compatible` — the gate's primary read.
 *   * `protocolVersion` — the daemon's CHOSEN version. On `compatible: true`,
 *     the negotiated `max(client.supportedProtocols ∩ daemon.supported)`.
 *     On `compatible: false`, the daemon's PREFERRED version (the highest
 *     version the daemon supports) so the client can decide whether to
 *     abort or retry.
 *
 * Optional fields:
 *   * `reason` — populated only when `compatible: false`. Names the
 *     specific failure mode (floor/ceiling/repeated-handshake) per the
 *     canonical dotted-namespace strings ratified at error-contracts.md
 *     §JSON-RPC Wire Mapping (BL-103 closed 2026-05-01).
 *   * `serverCapabilities` — opaque tag list mirroring the client's
 *     `capabilities`. Phase 3 handlers populate; Tier 1 substrate emits an
 *     empty array if no capabilities are advertised.
 *   * `daemonSupportedProtocols` — the daemon's full supported-version
 *     list, surfaced to the client when `compatible: false` so the client
 *     can decide which version to retry with. Capped at
 *     `SUPPORTED_PROTOCOLS_MAX_LEN` entries to mirror `DaemonHello`.
 */
export const DaemonHelloAckSchema: z.ZodType<DaemonHelloAck> = z
  .object({
    compatible: z.boolean(),
    protocolVersion: ProtocolVersionSchema,
    reason: z
      .union([
        z.literal(NEGOTIATION_REASON_FLOOR_EXCEEDED),
        z.literal(NEGOTIATION_REASON_CEILING_EXCEEDED),
        z.literal(NEGOTIATION_REASON_HANDSHAKE_ALREADY_COMPLETED),
      ])
      .optional(),
    serverCapabilities: z
      .array(NegotiationFreeFormString)
      .max(SUPPORTED_PROTOCOLS_MAX_LEN)
      .optional(),
    daemonSupportedProtocols: z
      .array(ProtocolVersionSchema)
      .max(SUPPORTED_PROTOCOLS_MAX_LEN)
      .optional(),
  })
  .strict() as unknown as z.ZodType<DaemonHelloAck>;

/**
 * The `DaemonHelloAck` response payload.
 */
export interface DaemonHelloAck {
  readonly compatible: boolean;
  readonly protocolVersion: string;
  readonly reason?: NegotiationIncompatibleReason;
  readonly serverCapabilities?: ReadonlyArray<string>;
  readonly daemonSupportedProtocols?: ReadonlyArray<string>;
}

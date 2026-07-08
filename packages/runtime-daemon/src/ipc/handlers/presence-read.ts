// `presence.read` JSON-RPC handler — Plan-002 Phase 3 (T3.3).
//
// Spec coverage:
//   * Spec-002 §Interfaces And Contracts line 86 — "`PresenceRead`
//     (JSON-RPC, local IPC) — local clients read current presence state
//     for a session." A peer process opens a connection, completes the
//     `daemon.hello` handshake (Plan-007 Phase 2), then dispatches
//     `presence.read` to fetch the per-session participant presence
//     snapshot (`{participants: [{participantId, state, lastSeen}]}`).
//   * Plan-002 §Phase 3 (CP-002-2) — "Local IPC bridge: `presence.*`
//     JSON-RPC method namespace (`PresenceUpdate`, `PresenceRead`)
//     registered under the Plan-007-partial wire substrate." This file is
//     the `read` slice; `presence-subscribe.ts` is the daemon→client push
//     (`presence.subscribe`) slice.
//
// Invariants this module participates in (canonical text in
// docs/plans/007-local-ipc-and-daemon-control.md §Invariants lines 95-117):
//   * I-007-1 / I-007-6 / I-007-7 / I-007-8 — same posture as the
//     `session.read` slice. See `session-create.ts` for the canonical
//     write-up; this file inherits the same registry-side guarantees
//     (load-before-bind, duplicate-registration rejected at register-time,
//     schema-validates-before-dispatch, sanitized error mapping).
//
// Why `mutating: false`: `presence.read` does not mutate domain state — it
// reads the in-memory Yjs Awareness projection (I-002-3: presence is
// ephemeral, in-memory only, never persisted). The pre-handshake
// mutating-op gate's predicate is `isMutating(method) === true`; flagging
// `read` as `false` means a connection in `pre` or `done-incompatible`
// state can still call `presence.read`, matching the read-only-continues
// posture documented for `session.read` (Spec-007 §Fallback Behavior).
//
// I-002-3 — presence is in-memory only:
//   This handler reads presence state through the deps closure; the deps'
//   implementor (Plan-002 Phase 3 `presence-register-service.ts` /
//   Plan-001 Phase 5 bootstrap) sources it from the in-memory Yjs
//   Awareness CRDT, NEVER from a durable `presence_state` table (which
//   does not exist — Plan-002 P10 migration-shape test pins its absence).
//   The `lastSeen` field is projected from the in-memory CRDT's
//   last-update timestamp, not a persisted row.
//
// What this file does NOT do (deferred to siblings):
//   * Yjs Awareness projection — owned by Plan-002 Phase 3's
//     `presence-register-service.ts` (CP-002-1). This file consumes the
//     resulting projection through the `PresenceReadDeps.readPresence`
//     callback.
//   * Durable presence-state-change event emission (`presence.online` etc.)
//     — that is a SUBSCRIBE-side / heartbeat-transition concern documented
//     on `PresenceSubscribeDeps.subscribeToPresence` in `presence-subscribe.ts`.
//     The `read` path is a pure projection query and emits nothing.
//
// Method-name format ratified: dotted-camelCase per
// docs/architecture/contracts/api-payload-contracts.md §JSON-RPC Method-Name
// Registry (Tier 1 Ratified, lines 311-351). The canonical regex
// `/^[a-z][a-z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/` accepts `"presence.read"`. The
// method-name TABLE at lines 327-336 enumerates only Plan-007 Phase 3's
// `session.*` surface; Plan-002 registers the `presence.*` namespace
// against the same ratified FORMAT (Plan-002 line 95 / CP-002-2). The
// method string is derived from the namespace + the canonical
// `PresenceRead` payload type (`Spec-002 §Interfaces And Contracts`) per the
// `session.read` → `session-read.ts` file/payload/method 3-way precedent.

import type {
  Handler,
  MethodRegistry,
  PresenceReadRequest,
  PresenceReadResponse,
} from "@ai-sidekicks/contracts";
import { PresenceReadRequestSchema, PresenceReadResponseSchema } from "@ai-sidekicks/contracts";

/**
 * Dependencies required by `presence.read`'s handler closure.
 *
 * The deps interface mirrors the pattern in `session-read.ts`: a single
 * async callback per handler. The bootstrap orchestrator (Plan-001 Phase
 * 5) supplies the concrete implementation, which sources the projection
 * from the in-memory Yjs Awareness CRDT owned by Plan-002 Phase 3's
 * `presence-register-service.ts` (CP-002-1).
 */
export interface PresenceReadDeps {
  /**
   * Read the current per-session presence projection per the canonical
   * `PresenceReadRequest` (`{sessionId}`). Returns the projection
   * (`PresenceReadResponse` = `{participants: [{participantId, state,
   * lastSeen}]}`) the wire client receives.
   *
   * The projection MUST be derived from the in-memory Yjs Awareness CRDT
   * (I-002-3 — presence is ephemeral, never persisted). `lastSeen` is the
   * CRDT's last-update timestamp for each participant, not a durable row.
   *
   * Domain-side errors MUST surface as thrown `Error` instances — the
   * registry's `dispatch()` wrapper catches them and applies
   * `mapJsonRpcError` per I-007-8. A session with no live presence state
   * SHOULD return `{participants: []}` (an empty roster is a valid
   * projection, not an error).
   */
  readonly readPresence: (request: PresenceReadRequest) => Promise<PresenceReadResponse>;
}

/**
 * Bind the `presence.read` handler onto the supplied method registry.
 *
 * Mutating flag: `mutating: false`. Reading presence does not mutate
 * domain state; see the file header for the full rationale. The handler
 * is a thin delegator — domain logic lives in the deps closure supplied
 * downstream by the bootstrap orchestrator.
 *
 * Idempotency / re-registration: see `registerSessionCreate` JSDoc.
 * I-007-6 rejects duplicate registration at register-time.
 */
export function registerPresenceRead(registry: MethodRegistry, deps: PresenceReadDeps): void {
  const handler: Handler<PresenceReadRequest, PresenceReadResponse> = async (params) => {
    return deps.readPresence(params);
  };

  registry.register(
    "presence.read",
    PresenceReadRequestSchema,
    PresenceReadResponseSchema,
    handler,
    { mutating: false },
  );
}

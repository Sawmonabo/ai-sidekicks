// `presence.read` JSON-RPC handler.
//
// Presence in this runtime is PER-DEVICE liveness of the one user's linked
// devices — a phone, a laptop, a CLI — never a list of people. A local client
// opens a connection, completes the `daemon.hello` handshake, then dispatches
// `presence.read` to fetch the session's current device-presence projection.
// `presence-subscribe.ts` is the daemon-to-client push slice of the same
// `presence.*` namespace; this file is the query slice.
//
// Invariants this module participates in: the same registry-side posture as the
// `session.read` slice (load-before-bind, duplicate registration rejected at
// register-time, schema-validates-before-dispatch, sanitized error mapping).
// See `session-create.ts` for the canonical write-up.
//
// Why `mutating: false`: `presence.read` does not mutate domain state — it
// reads the in-memory Yjs Awareness projection (presence is ephemeral,
// in-memory only, never persisted). The pre-handshake mutating-op gate's
// predicate is `isMutating(method) === true`; flagging `read` as `false` means
// a connection in `pre` or `done-incompatible` state can still call
// `presence.read`, matching the read-only-continues posture documented for
// `session.read`.
//
// Presence is in-memory only:
//   This handler reads presence state through the deps closure; the deps'
//   implementor sources it from the in-memory Yjs Awareness CRDT, NEVER from a
//   durable `presence_state` table (which does not exist — the migration-shape
//   test pins its absence). The liveness timestamp is projected from the
//   in-memory CRDT's last-update time, not a persisted row.
//
// What this file does NOT do (deferred to siblings):
//   * Yjs Awareness projection — owned by `presence-register-service.ts`. This
//     file consumes the resulting projection through the
//     `PresenceReadDeps.readPresence` callback.
//   * Durable presence-state-change event emission (`presence.online` etc.)
//     — that is a SUBSCRIBE-side / heartbeat-transition concern documented on
//     `PresenceSubscribeDeps.subscribeToPresence` in `presence-subscribe.ts`.
//     The `read` path is a pure projection query and emits nothing.
//
// Method-name format: dotted-camelCase. The canonical regex
// `/^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/` accepts `"presence.read"`. The
// method string is derived from the namespace plus the canonical
// `PresenceRead` payload type, per the `session.read` → `session-read.ts`
// file/payload/method 3-way precedent.

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
 * The deps interface mirrors the pattern in `session-read.ts`: a single async
 * callback per handler. The bootstrap orchestrator supplies the concrete
 * implementation, which sources the projection from the in-memory Yjs
 * Awareness CRDT owned by `presence-register-service.ts`.
 */
export interface PresenceReadDeps {
  /**
   * Read the current per-session device-presence projection for the
   * `sessionId` the canonical `PresenceReadRequest` carries. Returns the
   * `PresenceReadResponse` the wire client receives — one entry per live
   * device of the one user, whose member set the contracts package owns.
   *
   * The projection MUST be derived from the in-memory Yjs Awareness CRDT:
   * presence is ephemeral and never persisted, so the liveness timestamp on
   * each entry is the CRDT's last-update time for that device, not a durable
   * row.
   *
   * Domain-side errors MUST surface as thrown `Error` instances — the
   * registry's `dispatch()` wrapper catches them and applies
   * `mapJsonRpcError`. A session with no live presence state SHOULD return an
   * EMPTY list: no device is currently reachable, which is a valid projection
   * rather than an error.
   */
  readonly readPresence: (request: PresenceReadRequest) => Promise<PresenceReadResponse>;
}

/**
 * Bind the `presence.read` handler onto the supplied method registry.
 *
 * Mutating flag: `mutating: false`. Reading presence does not mutate domain
 * state; see the file header for the full rationale. The handler is a thin
 * delegator — domain logic lives in the deps closure supplied downstream by
 * the bootstrap orchestrator.
 *
 * Idempotency / re-registration: see `registerSessionCreate` JSDoc. Duplicate
 * registration is rejected at register-time.
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

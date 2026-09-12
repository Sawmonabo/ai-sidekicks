// `session.create` JSON-RPC handler.
//
//   * "Local IPC must support per-session streaming" + the user-namespace
//     methods listed. `session.create` is the V1 vertical-slice mutating
//     entry-point: a peer process opens a connection, completes the
//     `daemon.hello` handshake, then dispatches `session.create` against the
//     daemon-side method registry.
//   * Bind the four `session.*` handlers (`create` / `read` / `join` /
//     `subscribe`) onto the Phase 2 method registry. This file is the
//     `create` slice.
//   * Verifies handlers are registered against canonical method names
//     (mutating-flag + Zod schema discipline preserved across the binding
//     boundary).
//
// Invariants this module participates in (canonical text through):
//   * Load-before-bind: this file declares the handler shape and a
//     `register*` function the bootstrap orchestrator calls AFTER the
//     registry is loaded. The orchestrator (owned by a downstream PR)
//     supplies the deps; this file only declares the binding contract.
//   * Duplicate-method registration is rejected at register-time.
//     `MethodRegistryImpl.register` throws if the same method name binds
//     twice; calling `registerSessionCreate` twice on the same registry
//     surfaces as a deterministic bootstrap failure.
//   * The registry's standard `safeParse` path runs against
//     `SessionCreateRequestSchema` before this handler's body executes;
//     an envelope that fails validation never reaches `handler(params,
//     ctx)`.
//   * Errors thrown from inside the handler are caught by the
//     registry's `dispatch()` wrapper and mapped to the canonical
//     JSON-RPC error envelope by the `mapJsonRpcError`. This file MUST
//     throw plain `Error` instances (or domain-specific subclasses);
//     it MUST NOT synthesize JSON-RPC envelopes directly.
//
// What this file does NOT do (deferred to siblings):
//   * Domain-side `createSession` business logic — owned by the daemon's
//     session/control-plane bridge (downstream `SessionDirectoryService`
//     integration). This file consumes the resulting projection through
//     the `SessionCreateDeps.createSession` callback; the deps'
//     implementor is responsible for shape-conformant return values.
//   * Persistence / event-append — owned by the daemon's session service
//     (`runtime-daemon/src/session/session-service.ts`). The deps closure
//     typically calls into that service.
//   * This file is production code only.
//
// Method-name format ratified: dotted-camelCase. Canonical regex:
// `/^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/` — the `register` call site below
// passes `"session.create"`, which matches.
//
// Pattern reference: `registerHandshakeMethod` in
// `packages/runtime-daemon/src/ipc/protocol-negotiation.ts` lines 563-659 is
// the canonical precedent — a `register*(registry, deps)` function that
// constructs the handler closure inline, calls `registry.register(...)`
// with the canonical 5-arg signature, and returns. The bootstrap
// orchestrator imports the function and the deps interface, builds the
// deps, and calls `registerSessionCreate(registry, deps)`.

import type {
  Handler,
  MethodRegistry,
  SessionCreateRequest,
  SessionCreateResponse,
} from "@ai-sidekicks/contracts";
import { SessionCreateRequestSchema, SessionCreateResponseSchema } from "@ai-sidekicks/contracts";

/**
 * Dependencies required by `session.create`'s handler closure.
 *
 * Why a deps interface (rather than a free-function closure imported
 * directly): each handler file is registry-binding code that is
 * orthogonal to the daemon's domain implementation. supplies the
 * concrete `createSession` callback during bootstrap; decoupling here
 * lets inject test doubles without monkey-patching, and lets future
 * amendments swap the domain backend (e.g. control-plane bridge)
 * without touching this file.
 */
export interface SessionCreateDeps {
  /**
   * Create a new session per the canonical `SessionCreateRequest`.
   * Returns the projection (`SessionCreateResponse`) the wire client
   * receives. Domain-side errors (resource limits, malformed config,
   * persistence failure) MUST surface as thrown `Error` instances —
   * the registry's `dispatch()` wrapper catches them and applies
   * `mapJsonRpcError`.
   *
   * The implementation MUST assign `sessionId` through the daemon-wide
   * `mintUuidV7` (`runtime-daemon/src/ids/uuid-v7.ts`) — every daemon-side
   * persisted-row and event id mints there, which is what makes the RFC 9562
   * UUIDv7 claim in `contracts/src/session.ts` and `contracts/src/event.ts`
   * true rather than aspirational. The wire schemas still accept any UUID
   * version on purpose, because control-plane-assigned ids are Postgres
   * `gen_random_uuid()` v4; that tolerance is for the OTHER side of the
   * boundary and is not a licence for a daemon id to be v4. It MUST also
   * emit the canonical `session.created` event before returning.
   */
  readonly createSession: (request: SessionCreateRequest) => Promise<SessionCreateResponse>;
}

/**
 * Bind the `session.create` handler onto the supplied method registry.
 * Mirrors `registerHandshakeMethod` (protocol-negotiation.ts lines
 * 563-659) — the function is a pure registration call site that lets
 * the bootstrap orchestrator compose handler binding without each
 * handler manually re-implementing the deps-injection plumbing.
 *
 * Idempotency / re-registration: rejects duplicate registration at
 * register-time. The orchestrator MUST call this function exactly once
 * per registry instance; calling twice surfaces as a deterministic
 * bootstrap failure (the second call throws from
 * `MethodRegistryImpl.register`).
 *
 * Mutating flag: `mutating: true`. `session.create` is the canonical
 * domain mutation — it appends a `session.created` event and materializes
 * a session row. The pre-handshake mutating-op gate refuses dispatch on a
 * connection whose `daemon.hello` exchange has not completed compatibly
 * (per the `ProtocolNegotiator`); the gate predicate is
 * `isMutating(method) === true`, so this flag is what makes the gate
 * refuse pre-handshake `session.create` calls.
 */
export function registerSessionCreate(registry: MethodRegistry, deps: SessionCreateDeps): void {
  const handler: Handler<SessionCreateRequest, SessionCreateResponse> = async (params) => {
    return deps.createSession(params);
  };

  registry.register(
    "session.create",
    SessionCreateRequestSchema,
    SessionCreateResponseSchema,
    handler,
    { mutating: true },
  );
}

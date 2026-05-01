// `session.create` JSON-RPC handler — Plan-007 Phase 3 (T-007p-3-1).
//
// Spec coverage:
//   * Spec-007 §Required Behavior — "Local IPC must support per-session
//     streaming" + the user-namespace methods listed under §Interfaces And
//     Contracts (§71-78). `session.create` is the V1 vertical-slice mutating
//     entry-point: a peer process opens a connection, completes the
//     `daemon.hello` handshake (Plan-007 Phase 2 / T-007p-2-4), then
//     dispatches `session.create` against the daemon-side method registry.
//   * Plan-007 §Tier-1 Implementation Tasks (T-007p-3-1) — bind the four
//     `session.*` handlers (`create` / `read` / `join` / `subscribe`) onto
//     the Phase 2 method registry. This file is the `create` slice.
//   * CP-007-1 — verifies handlers are registered against canonical method
//     names (mutating-flag + Zod schema discipline preserved across the
//     binding boundary).
//
// Invariants this module participates in (canonical text in
// docs/plans/007-local-ipc-and-daemon-control.md §Invariants lines 95-117):
//   * I-007-1 — load-before-bind: this file declares the handler shape and
//     a `register*` function the bootstrap orchestrator calls AFTER the
//     registry is loaded. The orchestrator (Plan-001 Phase 5 — owned by a
//     downstream PR) supplies the deps; this file only declares the
//     binding contract.
//   * I-007-6 — duplicate-method registration is rejected at register-time.
//     `MethodRegistryImpl.register` throws if the same method name binds
//     twice; calling `registerSessionCreate` twice on the same registry
//     surfaces as a deterministic bootstrap failure.
//   * I-007-7 — schema-validates-before-dispatch. The registry's standard
//     `safeParse` path runs against `SessionCreateRequestSchema` before
//     this handler's body executes; an envelope that fails validation
//     never reaches `handler(params, ctx)`.
//   * I-007-8 — sanitized error mapping. Errors thrown from inside the
//     handler are caught by the registry's `dispatch()` wrapper and
//     mapped to the canonical JSON-RPC error envelope by
//     T-007p-2-2's `mapJsonRpcError`. This file MUST throw plain
//     `Error` instances (or domain-specific subclasses); it MUST NOT
//     synthesize JSON-RPC envelopes directly.
//
// What this file does NOT do (deferred to siblings):
//   * Domain-side `createSession` business logic — owned by the daemon's
//     session/control-plane bridge (Plan-001 Phase 5 + downstream
//     `SessionDirectoryService` integration). This file consumes the
//     resulting projection through the `SessionCreateDeps.createSession`
//     callback; the deps' implementor is responsible for shape-conformant
//     return values.
//   * Persistence / event-append — owned by the daemon's session service
//     (Plan-001 Phase 3 `runtime-daemon/src/session/session-service.ts`).
//     The deps closure typically calls into that service.
//   * Test coverage — owned by T-007p-3-4 (sibling task). This file is
//     production code only.
//
// Method-name format ratified: dotted-lowercase per
// docs/architecture/contracts/api-payload-contracts.md §JSON-RPC Method-Name
// Registry (Tier 1 Ratified, lines 291-331). Canonical regex:
// `/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/` — the `register` call site below
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
 * orthogonal to the daemon's domain implementation. Plan-001 Phase 5
 * supplies the concrete `createSession` callback during bootstrap;
 * decoupling here lets T-007p-3-4 (sibling) inject test doubles
 * without monkey-patching, and lets future amendments swap the
 * domain backend (e.g. local SQLite vs. control-plane bridge) without
 * touching this file.
 */
export interface SessionCreateDeps {
  /**
   * Create a new session per the canonical `SessionCreateRequest`.
   * Returns the projection (`SessionCreateResponse`) the wire client
   * receives. Domain-side errors (resource limits, malformed config,
   * persistence failure) MUST surface as thrown `Error` instances —
   * the registry's `dispatch()` wrapper catches them and applies
   * `mapJsonRpcError` per I-007-8.
   *
   * The implementation MUST assign `sessionId` (UUID v7 per Spec-006
   * is recommended; v4 is acceptable per session.ts §Branded ID
   * schemas) and emit the canonical `session.created` event before
   * returning.
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
 * Idempotency / re-registration: I-007-6 rejects duplicate registration
 * at register-time. The orchestrator MUST call this function exactly
 * once per registry instance; calling twice surfaces as a deterministic
 * bootstrap failure (the second call throws from
 * `MethodRegistryImpl.register`).
 *
 * Mutating flag: `mutating: true`. `session.create` is the canonical
 * domain mutation — it appends a `session.created` event, materializes
 * a session row, and emits a `membership.joined` event for the
 * creator. The pre-handshake mutating-op gate refuses dispatch on a
 * connection whose `daemon.hello` exchange has not completed
 * compatibly (per Plan-007 Phase 2's `ProtocolNegotiator`); the gate
 * predicate is `isMutating(method) === true`, so this flag is what
 * makes the gate refuse pre-handshake `session.create` calls.
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

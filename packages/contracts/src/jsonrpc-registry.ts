// JSON-RPC method-namespace registry — cross-package typed surface for
// Plan-007 Phase 2 (T-007p-2-3).
//
// This file owns the CONTRACT SHAPE every consumer of the daemon's
// method-namespace registry agrees on. The runtime IMPLEMENTATION lives in
// `packages/runtime-daemon/src/ipc/registry.ts` (T-007p-2-3 sibling). Per
// CP-007-3 / Plan-002 line 94 / Plan-026 line 236, multiple downstream plans
// register handlers against this surface — typing the interface here lets
// each consumer import the surface without taking a runtime-daemon
// dependency.
//
// Spec coverage:
//   * Spec-007 §Cross-Plan Obligations CP-007-3
//     (docs/specs/007-local-ipc-and-daemon-control.md) — the
//     `router.add(method, handler)` registry surface owed to Plan-026 and
//     Tier 4 namespace plans.
//
// Invariants this file's interface enforces (canonical text in
// docs/plans/007-local-ipc-and-daemon-control.md §Invariants lines 95-117):
//   * I-007-6 — duplicate method-name registration is rejected at
//     register-time (synchronous), not at dispatch-time. Programmer error
//     surfaces during daemon bootstrap.
//   * I-007-7 — schema validation runs before handler dispatch. Every
//     dispatch call MUST Zod-parse the request params against the
//     registered schema before the handler body executes; failures map to
//     `-32602 Invalid Params` at the substrate boundary (T-007p-2-2's
//     mapping).
//   * I-007-9 — method names conform to the canonical format declared in
//     api-payload-contracts.md §Plan-007. The runtime registry validates
//     at register-time via a regex check. (BLOCKED-ON-C6 — the canonical
//     format is undeclared; the runtime ships a conservative inline regex
//     until C-6 lands.)
//
// What this file does NOT define (deferred to sibling tasks):
//   * The runtime registry class implementation (`MethodRegistry implements
//     MethodRegistry`) — owned by T-007p-2-3 in
//     `packages/runtime-daemon/src/ipc/registry.ts`. The interface here
//     is the contract; the class there is the realization.
//   * JSON-RPC numeric error code mapping (`-32601` method not found,
//     `-32602` invalid params, `-32603` internal error) — owned by
//     T-007p-2-2 (`jsonrpc-error-mapping.ts`). The runtime registry
//     throws a daemon-internal `RegistryDispatchError` carrying a
//     stable `registryCode`; T-2's mapping table converts that to the
//     wire numeric code.
//   * Concrete handler shapes for `session.*` / `presence.*` / etc. —
//     owned by Phase 3 + downstream plans. The interface here parameterizes
//     over `<P, R>` so each handler can register with its own typed
//     params/result schemas.

// We import zod's `ZodType` as a type ONLY. This keeps the contract
// package's runtime surface unchanged (zod is already a contracts
// dependency for the existing schemas in error.ts / event.ts / session.ts;
// no new runtime import is added here). Type-only imports satisfy
// `verbatimModuleSyntax: true` from tsconfig.base.json.
import type { ZodType } from "zod";

// Re-export `ZodType` so the daemon's registry implementation
// (`packages/runtime-daemon/src/ipc/registry.ts`) can import it via
// `@ai-sidekicks/contracts` without taking its own dependency on `"zod"`.
// Runtime-daemon's package.json deliberately does NOT list zod — the
// schema instances flow in via the `register()` call from contracts-aware
// callers (Phase 3 `session.*` handlers, Plan-002 `presence.*`, etc.).
// Exposing the type here means the daemon can type-check its
// implementation against `ZodType<T>` while only depending on contracts.
export type { ZodType };

// --------------------------------------------------------------------------
// HandlerContext
// --------------------------------------------------------------------------

/**
 * Per-dispatch context passed to every handler. Tier 1 ships the minimal
 * shape that the substrate has the data to populate; downstream phases
 * widen as new handler capabilities (auth principal, telemetry span,
 * cancellation signal) come online.
 *
 * Tier 1 fields:
 *   * `transportId` — the per-connection identity assigned by the gateway
 *     (`SupervisionTransport["id"]` in
 *     `packages/runtime-daemon/src/ipc/local-ipc-gateway.ts`). Optional
 *     because the registry must remain testable without a wire substrate
 *     attached: unit tests construct contexts with no transport at all.
 *
 * Recommendation: minimal `{ readonly transportId?: number }`.
 * Alternative considered: empty `interface HandlerContext {}`.
 * Why this wins: an empty placeholder offers nothing, while the
 *   transport id is a real concept Phase 3 handlers will need to correlate
 *   subscriptions with the connection that opened them (T-5's
 *   `LocalSubscription` cleanup path keys off transport identity).
 *   `transportId` is `readonly` so handlers cannot rebind it; optional so
 *   non-wire callers (tests, future direct-bind consumers) can still
 *   dispatch.
 * Trade-off accepted: the shape will widen in later phases. We commit to
 *   ADDITIVE evolution — fields are added, never removed/renamed without a
 *   spec edit (api-payload-contracts.md §Plan-007 governance route).
 */
export interface HandlerContext {
  readonly transportId?: number;
}

// --------------------------------------------------------------------------
// Handler
// --------------------------------------------------------------------------

/**
 * The handler function shape registered against a method name. The
 * `register<P, R>(...)` call binds:
 *   * `P` (params type) — derived from the registered `paramsSchema`'s
 *     output. The handler is GUARANTEED to receive a value that has
 *     already passed `paramsSchema.safeParse` (per I-007-7); a malformed
 *     payload is rejected by the registry before the handler body runs.
 *   * `R` (result type) — derived from the registered `resultSchema`'s
 *     output. The handler MUST resolve to a value that conforms; the
 *     registry validates the resolved value against `resultSchema` after
 *     the handler returns (defensive: a handler bug returning malformed
 *     data is a programmer error, not a client-facing one).
 *
 * Async-only by design. Synchronous handlers don't exist at this layer —
 * the dispatcher always returns a `Promise`, and a handler that doesn't
 * need awaitable work just `return`s a value (which the `Promise` chain
 * wraps). One shape simplifies T-007p-2-2's wiring.
 */
export type Handler<P, R> = (params: P, ctx: HandlerContext) => Promise<R>;

// --------------------------------------------------------------------------
// MethodRegistry
// --------------------------------------------------------------------------

/**
 * Optional registration flags. The single Tier 1 flag is `mutating`,
 * declared per F-007p-2-06 — the substrate uses it for the version-
 * mismatch gate at `protocol-negotiation.ts` (T-007p-2-4): when
 * `DaemonHelloAck.compatible === false`, the gateway refuses dispatch of
 * any registered method whose `mutating` flag is `true` and allows
 * read-only methods through.
 *
 * `mutating` defaults to `false`. The default is "read-only" because the
 * version-gate's failure mode for an UN-flagged method is "blocked when it
 * shouldn't be" rather than "let through when it shouldn't be" — the
 * latter is a security regression, the former is a correctness regression.
 * Fail-closed is the correct posture for the gate.
 */
export interface RegisterOptions {
  readonly mutating?: boolean;
}

/**
 * The method-namespace registry typed surface. Implementations:
 *   * `packages/runtime-daemon/src/ipc/registry.ts` — daemon-side runtime
 *     (T-007p-2-3); the substrate the daemon's bootstrap consumes.
 *   * Future control-plane / sidecar registries may share the interface;
 *     the contract is intentionally cross-package.
 *
 * Lifecycle:
 *   1. Bootstrap constructs a registry instance (`new MethodRegistry()`).
 *   2. Each Phase 3 / downstream plan calls `register(method, ...)` for
 *      the methods it owns. Duplicate names throw at this step (I-007-6).
 *   3. The IPC substrate routes incoming JSON-RPC requests through
 *      `dispatch(method, params, ctx)`. The dispatch path validates
 *      params against the registered schema (I-007-7), invokes the
 *      handler, validates the result, and returns the value.
 *
 * The interface is INSTANTIABLE — multiple registries per process are
 * plausible (test isolation, future Tier-4 surfaces). Mirrors the
 * `LocalIpcGateway` instantiable shape (T-007p-2-1's same rationale).
 */
export interface MethodRegistry {
  /**
   * Register a typed handler against a method name.
   *
   * @param method - The dotted-namespace method name (e.g. `session.create`).
   *   Format is governed by I-007-9 + canonical regex (BLOCKED-ON-C6;
   *   conservative inline regex in the runtime implementation).
   * @param paramsSchema - Zod schema validating the request `params`.
   *   Runs before handler dispatch (I-007-7).
   * @param resultSchema - Zod schema validating the handler's resolved
   *   result. Runs after the handler returns (defensive — programmer-
   *   error surface).
   * @param handler - The async function that produces the result given
   *   validated params + dispatch context.
   * @param opts - Optional registration flags (`mutating` for the
   *   version-mismatch gate per F-007p-2-06).
   * @throws RegistryRegistrationError synchronously when:
   *   * `method` is already registered (I-007-6 — duplicate at register-
   *     time, not dispatch-time).
   *   * `method` does not match the canonical format regex (I-007-9).
   */
  register<P, R>(
    method: string,
    paramsSchema: ZodType<P>,
    resultSchema: ZodType<R>,
    handler: Handler<P, R>,
    opts?: RegisterOptions,
  ): void;

  /**
   * Dispatch an incoming JSON-RPC request to its registered handler.
   *
   * Order of operations (canonical per JSDoc on the runtime
   * implementation; mirrored here for cross-package consumers):
   *   1. `has(method)` check — unregistered methods throw
   *      `RegistryDispatchError(registryCode: "method_not_found")`. T-2
   *      maps to JSON-RPC `-32601`.
   *   2. `paramsSchema.safeParse(params)` — failures throw
   *      `RegistryDispatchError(registryCode: "invalid_params")`. T-2
   *      maps to JSON-RPC `-32602`. The handler is NEVER invoked on a
   *      malformed payload (I-007-7).
   *   3. Handler invocation — the typed `params` are passed alongside
   *      the dispatch `ctx`. Handler-thrown errors propagate as-is; T-2
   *      sanitizes and maps via `error-contracts.md`'s table.
   *   4. `resultSchema.safeParse(result)` — failures throw
   *      `RegistryDispatchError(registryCode: "invalid_result")`. T-2
   *      maps to JSON-RPC `-32603` (programmer error, not client error).
   *
   * Returns the handler's resolved result on success. The return type is
   * `unknown` because the dispatcher is generic over all registered
   * methods; the per-method `R` is recovered downstream by the typed
   * client SDK (Phase 3, T-007p-3-*).
   */
  dispatch(method: string, params: unknown, ctx: HandlerContext): Promise<unknown>;

  /**
   * Test whether a method name is currently registered. Used by the
   * substrate's `local-ipc-gateway` dispatch path before invoking
   * `dispatch()`, and by tests / observability tooling that wants to
   * inspect the registry's surface area.
   */
  has(method: string): boolean;

  /**
   * Test whether a registered method was registered with `mutating: true`.
   * Returns `undefined` for unregistered methods (caller distinguishes
   * "unknown method" from "known read-only method" before consulting the
   * version-mismatch gate).
   *
   * Per F-007p-2-06 + I-007-1 fail-closed posture, T-007p-2-4's
   * version-gate uses this query to decide whether to allow a method
   * through when `DaemonHelloAck.compatible === false`. Mutating ops are
   * refused; read-only ops pass.
   */
  isMutating(method: string): boolean | undefined;
}

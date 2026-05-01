// MethodRegistryImpl — runtime realization of the method-namespace registry
// interface declared in `@ai-sidekicks/contracts/src/jsonrpc-registry.ts`
// (Plan-007 Phase 2, T-007p-2-3).
//
// Spec coverage:
//   * Spec-007 §Cross-Plan Obligations CP-007-3
//     (docs/specs/007-local-ipc-and-daemon-control.md) — the
//     `router.add(method, handler)` registry surface owed to Plan-026 and
//     Tier 4 namespace plans. The interface is the cross-package contract;
//     this file is the daemon-side implementation that the bootstrap
//     orchestrator constructs and wires into `LocalIpcGateway` dispatch.
//
// Invariants this module owns (canonical text in
// docs/plans/007-local-ipc-and-daemon-control.md §Invariants lines 95-117):
//
//   * I-007-6 — duplicate method-name registration MUST be rejected at
//     register-time (synchronously), not at dispatch-time. The registry
//     here throws `RegistryRegistrationError("duplicate_method", ...)` on
//     any second `register(method, ...)` call with an already-registered
//     name. The throw surfaces during daemon bootstrap before any
//     listener binds, making the failure deterministic for the operator
//     and for tests.
//
//   * I-007-7 — schema validation runs BEFORE handler dispatch. The
//     `dispatch()` order is exactly: (1) `has(method)` check; (2)
//     `paramsSchema.safeParse(params)`; (3) handler invocation only on
//     `success: true`; (4) `resultSchema.safeParse(result)` on the
//     handler's resolved value. The handler is NEVER invoked on a
//     malformed payload — `safeParse` returns a structured failure that
//     short-circuits dispatch with `RegistryDispatchError(registryCode:
//     "invalid_params")`.
//
//   * I-007-9 — method names conform to the canonical format declared in
//     docs/architecture/contracts/api-payload-contracts.md §JSON-RPC
//     Method-Name Registry (Tier 1 Ratified, lines 291-331). The dotted-
//     lowercase regex `/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/` is canonical;
//     LSP-style `$/`-prefixed names remain enforced via a sibling regex
//     pending a follow-up decision. The regex check runs at `register()`
//     time per I-007-9.
//
// What this module does NOT do (deferred to sibling tasks):
//   * JSON-RPC numeric error code mapping (`-32601` method not found,
//     `-32602` invalid params, `-32603` internal error) — owned by
//     T-007p-2-2 (`jsonrpc-error-mapping.ts`). The registry throws a
//     daemon-internal `RegistryDispatchError` carrying a stable
//     `registryCode`; T-2 catches it and selects the wire numeric code.
//   * Outbound emission / framing — owned by T-007p-2-1
//     (`local-ipc-gateway.ts`). The registry returns plain values; the
//     gateway wraps them in `JsonRpcResponse` envelopes.
//   * Version-mismatch gate enforcement — owned by T-007p-2-4
//     (`protocol-negotiation.ts`). The registry merely EXPOSES
//     `isMutating(method)` for T-2-4 to consult; the registry itself does
//     not refuse dispatch based on version state.
//
// `METHOD_NAME_DOTTED_REGEX` is canonical per
// docs/architecture/contracts/api-payload-contracts.md §JSON-RPC Method-Name
// Registry (Tier 1 Ratified, lines 291-331). `METHOD_NAME_LSP_REGEX` enforces
// the LSP-style `$/`-prefixed system-method shape used by the streaming
// primitive (T-007p-2-5); the LSP shape is not addressed by the §Method-Name
// Registry ratification and remains a separate follow-up.

import type {
  Handler,
  HandlerContext,
  MethodRegistry,
  RegisterOptions,
  ZodType,
} from "@ai-sidekicks/contracts";

// --------------------------------------------------------------------------
// Method-name format regexes
// --------------------------------------------------------------------------

/**
 * Canonical dotted-lowercase namespace.method shape per F-007p-3-01
 * leaning: lowercase identifier, dotted separator, at least one dot
 * (i.e. `namespace.method` minimum, not bare `method`).
 *
 * Examples that match: `session.create`, `presence.subscribe`,
 *   `run.stream.notify`.
 * Examples that don't match: `Session.create` (uppercase),
 *   `sessionCreate` (no dot), `session/create` (slash separator),
 *   `session.` (trailing dot), `.create` (leading dot).
 *
 * Canonical regex per docs/architecture/contracts/api-payload-contracts.md
 * §JSON-RPC Method-Name Registry (Tier 1 Ratified, lines 291-331):
 * `/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/`.
 */
const METHOD_NAME_DOTTED_REGEX = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/;

/**
 * LSP-style `$/`-prefixed system method shape. Used by the streaming
 * primitive (T-007p-2-5) for `$/subscription/notify` and
 * `$/subscription/cancel`. The method names inside the streaming
 * primitive's frames are NOT user-namespace registrations, but the
 * registry must still be able to register handlers for them when the
 * substrate routes inbound notifications back through the same dispatch
 * surface (e.g. server-initiated subscription cancellation acks).
 *
 * Pattern: literal `$/` + lowercase-leading identifier + zero or more
 * `/`-separated identifiers. Identifiers permit camelCase after the
 * leading lowercase letter to match LSP convention (`$/cancelRequest`,
 * `$/subscription/notify`).
 *
 * Examples that match: `$/subscription/notify`, `$/subscription/cancel`,
 *   `$/cancelRequest`.
 * Examples that don't match: `$cancel` (no slash), `/subscribe` (no
 *   dollar), `$/Subscription/notify` (uppercase head), `$//notify`
 *   (empty segment).
 *
 * The LSP-style shape is not addressed by api-payload-contracts.md §JSON-RPC
 * Method-Name Registry (which ratifies dotted-lowercase only); whether the
 * LSP form remains accepted, gets re-homed under a separate namespace, or is
 * subsumed into a unified canonical taxonomy is a separate follow-up.
 */
const METHOD_NAME_LSP_REGEX = /^\$\/[a-z][a-zA-Z0-9]*(?:\/[a-z][a-zA-Z0-9]*)*$/;

/**
 * Test a method-name string against the registry's accepted shapes.
 * Returns `true` if the name matches EITHER the canonical dotted-lowercase
 * pattern (per api-payload-contracts.md §JSON-RPC Method-Name Registry,
 * lines 291-331) OR the LSP `$/`-prefixed system-method pattern (separate
 * follow-up). Exported only for test reach — production callers go through
 * `register()`.
 */
export function isCanonicalMethodName(method: string): boolean {
  return METHOD_NAME_DOTTED_REGEX.test(method) || METHOD_NAME_LSP_REGEX.test(method);
}

// --------------------------------------------------------------------------
// Registry error classes (daemon-internal)
// --------------------------------------------------------------------------

/**
 * Stable string codes for registration-time failures. Surfaced via the
 * thrown `RegistryRegistrationError`'s `registryCode` field so test
 * assertions and bootstrap log lines can discriminate without parsing
 * the human-readable message.
 *
 *   * `"duplicate_method"` — I-007-6 enforcement: a second `register()`
 *     call with the same method name. Synchronous throw at register-time.
 *   * `"invalid_method_name"` — I-007-9 enforcement: the method-name
 *     string did not match the canonical dotted-lowercase regex (per
 *     api-payload-contracts.md §JSON-RPC Method-Name Registry, lines
 *     291-331) OR the sibling LSP-style `$/`-prefixed regex.
 */
export type RegistryRegistrationCode = "duplicate_method" | "invalid_method_name";

/**
 * Error thrown synchronously from `register()`. A registration error is a
 * PROGRAMMER ERROR — the bootstrap orchestrator is misconfigured. The
 * daemon SHOULD let this propagate up the call stack and refuse to start;
 * the operator's reaction is "fix the registration site," not "retry the
 * call." This is intentionally distinct from `RegistryDispatchError`
 * (which is a per-request failure surface).
 *
 * Subclassing `Error`:
 *   * `name` is set so stack traces / `instanceof` discrimination works
 *     uniformly across the daemon's error-handling surfaces.
 *   * `registryCode` is a stable string consumers compare against
 *     without parsing `message`.
 *   * `message` is human-readable, includes the offending method name,
 *     and is safe to print to operator logs (no secrets, no path leaks
 *     — the only inputs are the developer-supplied method-name string).
 */
export class RegistryRegistrationError extends Error {
  readonly registryCode: RegistryRegistrationCode;

  constructor(registryCode: RegistryRegistrationCode, message: string) {
    super(message);
    this.name = "RegistryRegistrationError";
    this.registryCode = registryCode;
  }
}

/**
 * Stable string codes for dispatch-time failures. Surfaced via the thrown
 * `RegistryDispatchError`'s `registryCode` field so T-007p-2-2's
 * error-mapping table can select the JSON-RPC numeric code without
 * inspecting the human-readable message.
 *
 *   * `"method_not_found"` — `dispatch(method, ...)` was called for a
 *     method name not present in the registry. T-2 maps to JSON-RPC
 *     `-32601 Method Not Found`.
 *   * `"invalid_params"` — `paramsSchema.safeParse(params)` failed.
 *     I-007-7 enforcement: handler NOT invoked. T-2 maps to JSON-RPC
 *     `-32602 Invalid Params`.
 *   * `"invalid_result"` — `resultSchema.safeParse(result)` failed
 *     against the handler's resolved value. This is a PROGRAMMER ERROR
 *     (the handler returned malformed data); T-2 maps to JSON-RPC
 *     `-32603 Internal Error` rather than `-32602` because the client is
 *     not at fault. The asymmetry between "params validation failure
 *     blames the client" and "result validation failure blames the
 *     daemon" is deliberate per the registry's defensive posture.
 */
export type RegistryDispatchCode = "method_not_found" | "invalid_params" | "invalid_result";

/**
 * Error thrown from `dispatch()`. A dispatch error is a per-request
 * failure surface; T-007p-2-2's mapping table converts the
 * `registryCode` into the JSON-RPC numeric code that lands on the wire.
 *
 * `issues` carries the raw `ZodIssue[]` array produced by `safeParse` for
 * `"invalid_params"` / `"invalid_result"` codes. Type erased to
 * `ReadonlyArray<unknown>` here so the registry doesn't take a runtime
 * dependency on zod's issue shape — T-2 will narrow the type when
 * constructing the wire `error.data` payload (T-2 already imports zod).
 */
export class RegistryDispatchError extends Error {
  readonly registryCode: RegistryDispatchCode;
  readonly issues: ReadonlyArray<unknown> | undefined;

  constructor(
    registryCode: RegistryDispatchCode,
    message: string,
    issues?: ReadonlyArray<unknown>,
  ) {
    super(message);
    this.name = "RegistryDispatchError";
    this.registryCode = registryCode;
    this.issues = issues;
  }
}

// --------------------------------------------------------------------------
// Internal: per-method entry
// --------------------------------------------------------------------------

/**
 * Storage shape for a single registered method. The generic params/result
 * types are erased to `unknown` at storage time — `register<P, R>(...)`
 * narrows the call-site types via the function signature, but the
 * internal map is monomorphic on `unknown` so a single `Map<string, ...>`
 * can hold every registered method regardless of `P` / `R`.
 *
 * The schemas remain typed as `ZodType<unknown>` because `safeParse`'s
 * runtime contract is independent of the static `T` parameter — the
 * parser inspects the runtime value either way. The `as ZodType<unknown>`
 * cast at storage time is sound because `register<P, R>` constrains the
 * caller to pass schemas matching the handler's input/output, so any
 * `safeParse` success at runtime is necessarily a value the handler
 * accepts.
 */
interface RegistryEntry {
  readonly paramsSchema: ZodType<unknown>;
  readonly resultSchema: ZodType<unknown>;
  readonly handler: Handler<unknown, unknown>;
  readonly mutating: boolean;
}

// --------------------------------------------------------------------------
// MethodRegistryImpl
// --------------------------------------------------------------------------

/**
 * Runtime realization of the `MethodRegistry` interface. Instantiable —
 * the bootstrap orchestrator constructs ONE registry instance and wires
 * it into `LocalIpcGateway`'s dispatch path. Multiple registries per
 * process are plausible (test isolation, future Tier-4 surfaces); the
 * instantiable shape mirrors `LocalIpcGateway`'s same decision.
 *
 * Recommendation: instantiable class, internal `Map<string, RegistryEntry>`.
 * Alternative considered: module-singleton pattern matching `SecureDefaults`.
 * Why this wins: registries are CAPABILITY surfaces (per-process, per-bind,
 *   potentially per-test). `SecureDefaults` is a CONFIGURATION singleton
 *   (one validated bind config per process). Map a singleton onto a per-
 *   registry contract and tests need a `__resetForTest()` hook that the
 *   capability domain doesn't naturally have.
 * Trade-off accepted: the bootstrap orchestrator must plumb the registry
 *   instance to dispatch consumers. Tier 1 has exactly one consumer (the
 *   gateway), which makes the plumbing trivial.
 */
export class MethodRegistryImpl implements MethodRegistry {
  // Private storage. `#methods` is a `Map<string, RegistryEntry>` — string
  // method-name keys, monomorphic-on-unknown entries. The generic params/
  // result types narrow at the `register<P, R>` call site only.
  readonly #methods: Map<string, RegistryEntry>;

  constructor() {
    this.#methods = new Map();
  }

  /**
   * Register a typed handler against a method name (I-007-6 + I-007-9
   * enforcement).
   *
   * Order of validation:
   *   1. Method-name format check (I-007-9 — runs FIRST so a malformed
   *      name doesn't first cross the duplicate check).
   *   2. Duplicate-method check (I-007-6 — synchronous throw).
   *   3. Storage.
   *
   * Flag handling: per `RegisterOptions` JSDoc, `mutating` defaults to
   * `false`. The `opts?.mutating === true` check honors
   * `exactOptionalPropertyTypes: true` from tsconfig.base.json — we never
   * compare against `undefined` literally; we compare against `true`.
   */
  register<P, R>(
    method: string,
    paramsSchema: ZodType<P>,
    resultSchema: ZodType<R>,
    handler: Handler<P, R>,
    opts?: RegisterOptions,
  ): void {
    // I-007-9: method-name format check at register-time.
    if (!isCanonicalMethodName(method)) {
      throw new RegistryRegistrationError(
        "invalid_method_name",
        `MethodRegistry.register: method name ${JSON.stringify(method)} does not match the canonical dotted-lowercase format 'namespace.method' (per api-payload-contracts.md §JSON-RPC Method-Name Registry) or the LSP-style '$/segment[/segment]*' system-method shape`,
      );
    }

    // I-007-6: duplicate-method check. The throw surfaces synchronously
    // during daemon bootstrap, before any listener binds — the operator
    // sees a deterministic failure rather than a non-deterministic
    // dispatch-time shadowing.
    if (this.#methods.has(method)) {
      throw new RegistryRegistrationError(
        "duplicate_method",
        `MethodRegistry.register: method ${JSON.stringify(method)} is already registered (duplicate registrations are rejected at register-time, not dispatch-time, per I-007-6)`,
      );
    }

    const entry: RegistryEntry = {
      // The cast to `ZodType<unknown>` is sound because the function
      // signature constrains `paramsSchema` to `ZodType<P>` and the
      // handler to `Handler<P, R>` — at storage time we erase `P` to
      // `unknown` because the `Map` value type is monomorphic. The
      // runtime contract (`safeParse` + handler call) preserves the
      // type relationship: any value `safeParse` accepts is by
      // construction a `P`, and the handler is typed `Handler<P, R>`.
      paramsSchema: paramsSchema as ZodType<unknown>,
      resultSchema: resultSchema as ZodType<unknown>,
      handler: handler as Handler<unknown, unknown>,
      // `opts?.mutating === true` (not `?? false`) — `exactOptionalPropertyTypes`
      // forbids assigning `undefined` to optional fields, and this comparison
      // explicitly produces a `boolean` regardless of `opts` shape.
      mutating: opts?.mutating === true,
    };
    this.#methods.set(method, entry);
  }

  /**
   * Dispatch an incoming request to its registered handler. See the
   * cross-package interface JSDoc in `jsonrpc-registry.ts` for the
   * canonical order-of-operations description; this implementation
   * mirrors it verbatim:
   *   1. `has(method)` — unregistered → throw `method_not_found`.
   *   2. `paramsSchema.safeParse(params)` — failure → throw
   *      `invalid_params` BEFORE handler invocation (I-007-7).
   *   3. Handler invocation with the parsed params + ctx.
   *   4. `resultSchema.safeParse(result)` — failure → throw
   *      `invalid_result` (programmer error; T-2 maps to `-32603`).
   */
  async dispatch(method: string, params: unknown, ctx: HandlerContext): Promise<unknown> {
    // Step 1: method-existence check. `Map.get` returns `T | undefined`
    // under `noUncheckedIndexedAccess: true`; we test for `undefined`
    // directly rather than chaining a separate `has()` call (single Map
    // lookup, single branch).
    const entry = this.#methods.get(method);
    if (entry === undefined) {
      throw new RegistryDispatchError(
        "method_not_found",
        `MethodRegistry.dispatch: method ${JSON.stringify(method)} is not registered`,
      );
    }

    // Step 2: schema-validates-before-dispatch (I-007-7). `safeParse`
    // returns `{ success: false, error }` on failure rather than
    // throwing — this lets us short-circuit dispatch with a structured
    // throw of our own type (`RegistryDispatchError`) that T-007p-2-2's
    // mapping table can convert to the wire `-32602` envelope.
    const parsedParams = entry.paramsSchema.safeParse(params);
    if (!parsedParams.success) {
      throw new RegistryDispatchError(
        "invalid_params",
        `MethodRegistry.dispatch: params validation failed for method ${JSON.stringify(method)}`,
        // `error.issues` is the canonical zod issue array. Erased to
        // `ReadonlyArray<unknown>` at the registry boundary so we don't
        // re-export zod's `ZodIssue` type out of the daemon.
        parsedParams.error.issues,
      );
    }

    // Step 3: handler invocation. `parsedParams.data` is the
    // (zod-narrowed) `unknown` shape — handlers are typed
    // `Handler<P, R>` at registration so the runtime value satisfies
    // the registered handler's input contract.
    const result = await entry.handler(parsedParams.data, ctx);

    // Step 4: result-schema validation. Defensive check for handler
    // bugs; not a client-facing failure surface. T-2's mapping table
    // routes `invalid_result` to JSON-RPC `-32603` because the client
    // did nothing wrong — the daemon's handler returned malformed data.
    const parsedResult = entry.resultSchema.safeParse(result);
    if (!parsedResult.success) {
      throw new RegistryDispatchError(
        "invalid_result",
        `MethodRegistry.dispatch: result validation failed for method ${JSON.stringify(method)} (handler returned a value that does not match the registered resultSchema; programmer error)`,
        parsedResult.error.issues,
      );
    }
    return parsedResult.data;
  }

  /**
   * Test whether a method name is currently registered. Single Map
   * lookup. Used by `LocalIpcGateway` dispatch path before invoking
   * `dispatch()` (so the gateway can choose to emit `-32601` directly
   * rather than catching the `method_not_found` throw — both shapes
   * are valid; T-2's mapping unifies them).
   */
  has(method: string): boolean {
    return this.#methods.has(method);
  }

  /**
   * Test whether a registered method was registered with `mutating: true`.
   * Returns `undefined` for unregistered methods — the caller (T-007p-2-4
   * version-gate) needs to distinguish "unknown method" (let dispatch
   * surface the `method_not_found` error) from "known read-only method"
   * (allow through despite version mismatch) from "known mutating
   * method" (refuse with version-mismatch error).
   *
   * Per F-007p-2-06, this query is the version-gate's primary read.
   */
  isMutating(method: string): boolean | undefined {
    const entry = this.#methods.get(method);
    if (entry === undefined) {
      return undefined;
    }
    return entry.mutating;
  }
}

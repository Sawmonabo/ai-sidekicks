// Protocol negotiation — `DaemonHello` / `DaemonHelloAck` exchange + the
// per-connection mutating-op gate (Plan-007 Phase 2, T-007p-2-4).
//
// Spec coverage:
//   * Spec-007 §Required Behavior line 47
//     (docs/specs/007-local-ipc-and-daemon-control.md) — "Local IPC must
//     support protocol version negotiation before mutating operations are
//     accepted."
//   * Spec-007 §Fallback Behavior lines 67-68 — "If version negotiation
//     fails, read-only compatibility may continue, but mutating operations
//     must be blocked until versions are compatible."
//   * Spec-007 §Interfaces And Contracts line 73 — "`DaemonHello` and
//     `DaemonHelloAck` must perform version negotiation."
//
// Invariants this module owns at the negotiation boundary (canonical text in
// docs/plans/007-local-ipc-and-daemon-control.md §Invariants lines 95-117):
//   * I-007-7 — schema validation runs before handler dispatch. Achieved by
//     registering `DaemonHelloSchema` against the registry surface; the
//     standard schema-validates-before-dispatch path applies to the
//     handshake envelopes themselves.
//   * I-007-1 (fail-closed) — pre-handshake mutating dispatch is refused,
//     post-handshake-incompatible mutating dispatch is refused, read-only
//     dispatch is always allowed. The gate's predicate is `isMutating
//     (method) === true` (strict equality with `true`); `undefined`
//     (unregistered) and `false` (read-only registered) pass through to
//     inner dispatch.
//
// Plan citations:
//   * F-007p-2-06 — read-vs-mutating classification is the registry's
//     `mutating: boolean` flag at registration time; the gate consults
//     `registry.isMutating(method)`.
//   * F-007p-2-10 — negotiation algorithm:
//     `max(client.supportedProtocols ∩ daemon.supported)` with floor/ceiling
//     refusal when intersection is empty.
//
// What this module does NOT do (deferred to sibling tasks):
//   * Cross-package wire-envelope schemas (`DaemonHelloSchema` /
//     `DaemonHelloAckSchema`) — owned by `packages/contracts/src/jsonrpc-
//     negotiation.ts`. The runtime-daemon's `package.json` deliberately
//     does NOT depend on `zod`, so the Zod schemas live in the contracts
//     package; this module IMPORTS them.
//   * Substrate framing / per-connection lifecycle eventing — owned by
//     T-007p-2-1 (`local-ipc-gateway.ts`). This module wraps the registry
//     dispatch surface; the gateway is unaware of the wrap.
//   * JSON-RPC numeric error code mapping for negotiation refusal — owned
//     by T-007p-2-2 (`jsonrpc-error-mapping.ts`). Negotiation-refusal
//     `NegotiationError` throws collapse to `-32603 InternalError` at the
//     substrate boundary until C-7 lands the canonical mapping
//     (BLOCKED-ON-C7).
//
// Architectural shape — gate-as-wrapper (NOT gate-as-function):
//   This module exports a `ProtocolNegotiator` class whose `wrap(registry)`
//   method returns a `MethodRegistry`-shaped proxy that intercepts
//   `dispatch()` to consult per-connection negotiation state. The wrapper
//   pattern is FORCED by the task contract's "out of scope:
//   local-ipc-gateway.ts modification" directive — the gate cannot live
//   inside `#dispatchFrame`, so it must wrap the registry that gateway
//   already injects. The bootstrap orchestrator constructs the negotiator,
//   wraps the registry, and passes the wrapped instance to the gateway.
//
// BLOCKED-ON-C6 — `protocolVersion: number | string` parameterization is
// inherited from the contracts package's `DaemonHello` / `DaemonHelloAck`
// shapes. This module's negotiation algorithm operates on the runtime
// types and does NOT narrow.
//
// BLOCKED-ON-C7 — every place where a project dotted-namespace error code
// would normally land carries a `// BLOCKED-ON-C7` comment marking the
// mechanical replacement site. Until error-contracts.md §Plan-007 lands,
// gate-refusal errors collapse to `-32603 InternalError` at
// `mapJsonRpcError`; the canonical mapping table replaces the inline
// `NegotiationError` throws with the table-driven dotted-namespace code at
// C-7-land time.

import type {
  DaemonHello,
  DaemonHelloAck,
  Handler,
  HandlerContext,
  MethodRegistry,
  NegotiationIncompatibleReason,
  RegisterOptions,
  ZodType,
} from "@ai-sidekicks/contracts";
import {
  DAEMON_HELLO_METHOD,
  DaemonHelloAckSchema,
  DaemonHelloSchema,
  NEGOTIATION_REASON_CEILING_EXCEEDED,
  NEGOTIATION_REASON_FLOOR_EXCEEDED,
  NEGOTIATION_REASON_HANDSHAKE_ALREADY_COMPLETED,
} from "@ai-sidekicks/contracts";

// --------------------------------------------------------------------------
// Daemon-supported protocol versions
// --------------------------------------------------------------------------

/**
 * The protocol versions THIS daemon build can speak. Tier 1 ships exactly
 * one (`1`); future amendments add additional versions as the JSON-RPC
 * envelope shape evolves.
 *
 * The list is daemon-internal — clients learn the daemon's full set via the
 * `DaemonHelloAck.daemonSupportedProtocols` field on a refused handshake.
 *
 * Stored as a `readonly number[]` rather than `readonly string[]` because
 * the canonical wire-shape per Spec-007:54 is integer (BLOCKED-ON-C6 for
 * the parametric reading; the substrate accepts both runtime types). The
 * negotiation algorithm uses numeric `Math.max` against the intersection;
 * cross-form comparison (number ↔ string) yields the empty intersection
 * per the documented convention in `intersectAndMax`.
 */
export const DAEMON_SUPPORTED_PROTOCOL_VERSIONS: readonly number[] = [1];

// --------------------------------------------------------------------------
// NegotiationError — gate-refusal failure surface
// --------------------------------------------------------------------------

/**
 * Stable string codes for negotiation-time failures surfaced by the gate.
 * Distinct from the `NegotiationIncompatibleReason` strings (which ride
 * inside a successful `DaemonHelloAck` envelope) — these codes are for
 * gate-refusal THROWS, not for handshake-completion ACKs.
 *
 *   * `"pre_handshake_mutating_refused"` — a mutating method was dispatched
 *     before any `daemon.hello` completed on this connection. I-007-1
 *     fail-closed enforcement: the gate refuses rather than letting the
 *     dispatch flow through to the registry.
 *   * `"version_mismatch_mutating_refused"` — a mutating method was
 *     dispatched after a `daemon.hello` that yielded `compatible: false`.
 *     Spec-007:67-68 enforcement: read-only methods continue working;
 *     mutating methods are blocked until versions are compatible.
 *
 * BLOCKED-ON-C7 — when error-contracts.md §Plan-007 lands the canonical
 * project dotted-namespace code table, these strings are replaced by the
 * canonical equivalents (likely `version.mutating_refused` and
 * `protocol.handshake_required`). Test code asserting on these codes
 * remains valid because the inline form is a strict subset of any post-C-7
 * expansion (we keep the same code, possibly add a canonical alias).
 */
export type NegotiationErrorCode =
  | "pre_handshake_mutating_refused"
  | "version_mismatch_mutating_refused";

/**
 * Error thrown from the gate-as-wrapper's `dispatch` proxy when a mutating
 * method is refused. The throw flows out of the wrapped registry's
 * `dispatch()`, through the gateway's `mapJsonRpcError`, and reaches the
 * wire as `-32603 InternalError` at Tier 1 (BLOCKED-ON-C7 transitional
 * shape — when the canonical mapping table lands, the discriminator at
 * `mapJsonRpcError` adds an explicit `instanceof NegotiationError` branch
 * that selects the correct numeric code).
 *
 * Subclassing `Error`:
 *   * `name` is set so stack traces / `instanceof` discrimination works
 *     uniformly across the daemon's error-handling surfaces. Mirrors the
 *     pattern in `RegistryDispatchError` and `FramingError`.
 *   * `negotiationCode` is a stable string consumers compare against
 *     without parsing `message`.
 *   * `message` is human-readable, includes the offending method name,
 *     and is safe to print to operator logs (no secrets, no path leaks).
 */
export class NegotiationError extends Error {
  readonly negotiationCode: NegotiationErrorCode;

  constructor(negotiationCode: NegotiationErrorCode, message: string) {
    super(message);
    this.name = "NegotiationError";
    this.negotiationCode = negotiationCode;
  }
}

// --------------------------------------------------------------------------
// NegotiationState — per-connection state machine
// --------------------------------------------------------------------------

/**
 * The negotiation state for a single connection (keyed by `transportId` in
 * the negotiator's per-connection map).
 *
 * Three states (advisor-pinned simplification — no `handshake-pending`):
 *
 *   * `"pre"` — no `daemon.hello` has yet completed for this connection.
 *     Mutating dispatch is refused with `pre_handshake_mutating_refused`;
 *     the only method that escapes is `daemon.hello` itself (registered
 *     with `mutating: false`).
 *   * `"done-compatible"` — a `daemon.hello` completed and the daemon
 *     selected a compatible protocol version. All dispatches allowed
 *     (read + mutating) — the gate's `isMutating(method) === true` check
 *     does not refuse.
 *   * `"done-incompatible"` — a `daemon.hello` completed but the daemon
 *     could not find a compatible protocol version. Mutating dispatch is
 *     refused with `version_mismatch_mutating_refused`; read-only
 *     dispatches continue to flow through (Spec-007:67-68).
 *
 * State transitions:
 *
 *   pre  --hello compatible--> done-compatible
 *   pre  --hello incompatible--> done-incompatible
 *   done-compatible  --hello (any)--> done-compatible (FAIL-SECOND posture
 *                                      — see "Fail-second on repeated
 *                                      handshake" below; the state is
 *                                      LATCHED, not re-evaluated)
 *   done-incompatible  --hello (any)--> done-incompatible (latched)
 *
 * Fail-second on repeated handshake:
 *   A second `daemon.hello` on a connection that has already completed
 *   one (compatible or incompatible) returns an ack with
 *   `reason: handshake_already_completed`. The state DOES NOT change —
 *   the FIRST handshake's outcome is latched for the connection's
 *   lifetime. Rationale: a client that sends a second hello is either
 *   buggy (duplicate boot) or hostile (probing the gate); refusing the
 *   second protects the gate from race-condition shape changes mid-
 *   connection.
 *
 * The state is a discriminated union on `kind` so the gate's predicate
 * narrows the carry fields (the negotiated `protocolVersion` is only
 * available in `done-compatible` / `done-incompatible`).
 */
export type NegotiationState =
  | { readonly kind: "pre" }
  | {
      readonly kind: "done-compatible";
      readonly negotiatedProtocolVersion: number | string;
    }
  | {
      readonly kind: "done-incompatible";
      readonly preferredProtocolVersion: number | string;
      readonly reason: NegotiationIncompatibleReason;
    };

// --------------------------------------------------------------------------
// Negotiation algorithm — F-007p-2-10
// --------------------------------------------------------------------------

/**
 * Result of the F-007p-2-10 negotiation algorithm against a `DaemonHello`
 * payload. Three shapes:
 *
 *   * `{ kind: "compatible", negotiated }` — `max(client ∩ daemon)` is
 *     defined; `negotiated` is that value.
 *   * `{ kind: "floor", daemonPreferred }` — every client-advertised
 *     version is BELOW the daemon's lowest supported version. Client too
 *     old. The daemon's preferred version is the highest the daemon
 *     supports (so the client can decide whether to retry against it).
 *   * `{ kind: "ceiling", daemonPreferred }` — every client-advertised
 *     version is ABOVE the daemon's highest supported version. Client too
 *     new.
 *
 * Cross-form convention (advisor-pinned): `number` only intersects
 * `number`; `string` only intersects `string`. A client advertising
 * `["1"]` against a daemon supporting `[1]` produces an empty intersection
 * — discriminated as `"floor"` because string-form versions cannot be
 * compared numerically against integer-form versions and the daemon's
 * conservative posture treats "uncomparable" as "client too old to
 * understand the daemon's preferred form". When C-6 lands the canonical
 * `protocolVersion` type, the cross-form ambiguity disappears and this
 * function narrows.
 */
type NegotiationOutcome =
  | { readonly kind: "compatible"; readonly negotiated: number | string }
  | { readonly kind: "floor"; readonly daemonPreferred: number }
  | { readonly kind: "ceiling"; readonly daemonPreferred: number };

/**
 * Run the F-007p-2-10 negotiation algorithm against a `DaemonHello` and
 * the daemon's supported-version list.
 *
 * Algorithm (per F-007p-2-10):
 *   1. Build the client's advertised set: `supportedProtocols` if present,
 *      else fall back to a singleton `[protocolVersion]`.
 *   2. Filter to numeric entries; cross-form (string) entries are
 *      discarded per the convention above.
 *   3. Intersect with `DAEMON_SUPPORTED_PROTOCOL_VERSIONS`.
 *   4. If non-empty: return `Math.max(intersection)` as compatible.
 *   5. If empty: discriminate floor (max(client) < min(daemon)) vs
 *      ceiling (min(client) > max(daemon)).
 *
 * The daemon's preferred version on refusal is the highest the daemon
 * supports — `Math.max(DAEMON_SUPPORTED_PROTOCOL_VERSIONS)` — surfaced to
 * the client via the ack.
 */
function negotiateProtocol(hello: DaemonHello): NegotiationOutcome {
  const daemonSupported = DAEMON_SUPPORTED_PROTOCOL_VERSIONS;
  // Cast to mutable for spread-into-Math.max; the array itself is not
  // mutated. `as readonly number[]` is preserved at the binding level.
  // Math.max argument type accepts (...values: number[]).
  const daemonMax = Math.max(...daemonSupported);
  const daemonMin = Math.min(...daemonSupported);

  // Step 1: build client-advertised set with singleton fallback.
  // `supportedProtocols` is optional per the contract; when absent,
  // `protocolVersion` itself is the singleton.
  const clientAdvertised: ReadonlyArray<number | string> =
    hello.supportedProtocols !== undefined ? hello.supportedProtocols : [hello.protocolVersion];

  // Step 2: filter to numeric entries. Cross-form (string) entries are
  // discarded per the cross-form convention. If every advertised entry
  // is non-numeric, `clientNumeric` is empty — falls through to the
  // floor/ceiling discrimination as "client below daemon's lowest" by
  // the conservative convention.
  const clientNumeric: number[] = [];
  for (const v of clientAdvertised) {
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
      clientNumeric.push(v);
    }
  }

  if (clientNumeric.length === 0) {
    // No comparable client versions. The conservative posture is to treat
    // this as `floor_exceeded` ("client too old to speak the daemon's
    // numeric protocol version"). The client receives the daemon's
    // preferred version and can retry with a numeric value.
    return { kind: "floor", daemonPreferred: daemonMax };
  }

  // Step 3: intersect with daemon-supported.
  const daemonSet = new Set(daemonSupported);
  const intersection = clientNumeric.filter((v) => daemonSet.has(v));

  if (intersection.length > 0) {
    // Step 4: max-of-intersection is the negotiated version.
    return { kind: "compatible", negotiated: Math.max(...intersection) };
  }

  // Step 5: empty intersection. Discriminate floor vs ceiling on the
  // client's MAX advertised version against the daemon's MIN/MAX.
  const clientMax = Math.max(...clientNumeric);
  if (clientMax < daemonMin) {
    return { kind: "floor", daemonPreferred: daemonMax };
  }
  // clientMax >= daemonMin AND no overlap means clientMin > daemonMax
  // (every client version is above the daemon's range). Catches the
  // ceiling case AND any pathological mixed range that has no overlap
  // (which the conservative convention treats as ceiling — the client
  // is advertising versions newer than this daemon understands).
  return { kind: "ceiling", daemonPreferred: daemonMax };
}

// --------------------------------------------------------------------------
// daemon.hello result schema (registered alongside the request schema)
// --------------------------------------------------------------------------

/**
 * Re-export the contracts-side `DaemonHelloAckSchema` cast through
 * `ZodType<DaemonHelloAck>` so `register<DaemonHello, DaemonHelloAck>(...)`
 * narrows correctly at the call site. The contracts file casts through
 * `unknown` to satisfy `exactOptionalPropertyTypes: true` on the explicit
 * interface; this binding makes the `ZodType<DaemonHelloAck>` shape
 * available to TypeScript's inference at the registration site below.
 */
const DaemonHelloAckResultSchema: ZodType<DaemonHelloAck> = DaemonHelloAckSchema;

/**
 * Re-bind for symmetry with the result schema. The registry's `register
 * <P, R>(...)` signature wants `paramsSchema: ZodType<P>` and the
 * contract file's cast satisfies the call.
 */
const DaemonHelloRequestSchema: ZodType<DaemonHello> = DaemonHelloSchema;

// --------------------------------------------------------------------------
// MethodRegistry wrapper (gate-as-wrapper architecture)
// --------------------------------------------------------------------------

/**
 * Internal: the wrapper is a `MethodRegistry` proxy. `register`, `has`, and
 * `isMutating` delegate UNCHANGED to the inner registry; only `dispatch`
 * inserts the gate predicate.
 *
 * The wrapper does NOT subclass `MethodRegistryImpl` — that would couple
 * us to the runtime implementation file rather than the cross-package
 * `MethodRegistry` interface. Composition over inheritance, and the
 * `MethodRegistry` typed surface is the only contract the gateway and
 * downstream registrants depend on.
 */
class WrappedRegistry implements MethodRegistry {
  readonly #inner: MethodRegistry;
  readonly #negotiator: ProtocolNegotiator;

  constructor(inner: MethodRegistry, negotiator: ProtocolNegotiator) {
    this.#inner = inner;
    this.#negotiator = negotiator;
  }

  register<P, R>(
    method: string,
    paramsSchema: ZodType<P>,
    resultSchema: ZodType<R>,
    handler: Handler<P, R>,
    opts?: RegisterOptions,
  ): void {
    // Pass through. Forwarding `opts` only when present mirrors
    // exactOptionalPropertyTypes — we never assign `undefined` to an
    // optional positional argument. The conditional spread is the
    // canonical pattern; here we have a positional signature, so we
    // discriminate on `opts === undefined`.
    if (opts === undefined) {
      this.#inner.register(method, paramsSchema, resultSchema, handler);
    } else {
      this.#inner.register(method, paramsSchema, resultSchema, handler, opts);
    }
  }

  async dispatch(method: string, params: unknown, ctx: HandlerContext): Promise<unknown> {
    // Gate predicate: refuse mutating dispatch on `pre` or
    // `done-incompatible` state. Order:
    //   1. Determine whether the method is mutating. `isMutating` returns
    //      `boolean | undefined`:
    //        * `undefined` (unregistered) → pass through; the inner
    //          dispatch will throw `RegistryDispatchError("method_not_
    //          found")` which surfaces the canonical -32601. Refusing
    //          here would mask the not-found error as a version-mismatch
    //          error — Acceptance test W-007p-2-T7 would fail.
    //        * `false` (registered read-only) → pass through; read-only
    //          methods are always allowed per Spec-007:67-68.
    //        * `true` (registered mutating) → consult negotiation state
    //          to decide.
    //   2. If mutating, look up the negotiation state for this transport.
    //      No transport id (e.g. unit-test direct dispatch) means no per-
    //      connection state; pass through. The contract is "the gate
    //      enforces over the wire boundary, not over direct dispatch".
    //   3. State `pre` → throw NegotiationError(pre_handshake_...).
    //      State `done-incompatible` → throw NegotiationError(version_mismatch_...).
    //      State `done-compatible` → pass through.
    const isMutating = this.#inner.isMutating(method);
    if (isMutating === true) {
      // Tighten on the strict equality with `true` (advisor-pinned). Both
      // `false` and `undefined` pass through.
      const transportId = ctx.transportId;
      if (transportId !== undefined) {
        const state = this.#negotiator.getState(transportId);
        if (state.kind === "pre") {
          throw new NegotiationError(
            "pre_handshake_mutating_refused",
            // Sanitization at the gateway boundary covers any path leak
            // that might enter via `method`; here the only inputs are the
            // method name string (developer-supplied) and a static
            // sentence — neither carries sensitive data.
            `protocol-negotiation: mutating method ${JSON.stringify(method)} refused before \`${DAEMON_HELLO_METHOD}\` completed (I-007-1 fail-closed; per Spec-007:47)`,
          );
        }
        if (state.kind === "done-incompatible") {
          throw new NegotiationError(
            "version_mismatch_mutating_refused",
            `protocol-negotiation: mutating method ${JSON.stringify(method)} refused because the connection's prior handshake was incompatible (reason=${JSON.stringify(state.reason)}; per Spec-007:67-68)`,
          );
        }
        // state.kind === "done-compatible" → pass through.
      }
      // No transportId → pass through (no wire boundary to enforce
      // against). Direct-dispatch test code is exempt.
    }
    return this.#inner.dispatch(method, params, ctx);
  }

  has(method: string): boolean {
    return this.#inner.has(method);
  }

  isMutating(method: string): boolean | undefined {
    return this.#inner.isMutating(method);
  }
}

// --------------------------------------------------------------------------
// ProtocolNegotiator — the public class
// --------------------------------------------------------------------------

/**
 * Per-connection negotiation state-keeper + registry wrapper. The bootstrap
 * orchestrator constructs ONE `ProtocolNegotiator`, calls
 * `negotiator.wrap(rawRegistry)` to get a gated registry, registers
 * downstream Phase 3 handlers against the GATED registry (or the raw
 * registry — both work; `register` is a pass-through), and constructs
 * `LocalIpcGateway` with the gated registry.
 *
 * Per-connection lifecycle:
 *   * `cleanupTransport(transportId)` MUST be called on every connection
 *     close, otherwise the negotiator's per-connection map leaks one
 *     entry per closed connection. The bootstrap orchestrator composes
 *     this into the gateway's `SupervisionHooks.onDisconnect`.
 *   * `daemon.hello` is registered against the gated registry by
 *     `registerHandshakeMethod()`. It MUST be called by the bootstrap
 *     after `wrap()` returns and before the gateway starts listening.
 *
 * SupervisionHooks composition note:
 *   The gateway's `SupervisionHooks` slot is single-consumer (Tier 4
 *   desktop-shell). The negotiator therefore EXPOSES `cleanupTransport`
 *   for the bootstrap to compose into a future combined hook (the
 *   bootstrap's `onDisconnect` calls both the desktop-shell hook AND
 *   `negotiator.cleanupTransport`). The negotiator does NOT install
 *   itself into the hooks slot directly.
 */
export class ProtocolNegotiator {
  // Per-connection state map. Keyed by `transportId`, populated lazily
  // on first lookup (every `getState` call returns `pre` for an unknown
  // id). This avoids requiring `onConnect` notification — the per-
  // connection state is implicit in "no entry for this id" === "pre-
  // handshake".
  readonly #states: Map<number, NegotiationState>;

  constructor() {
    this.#states = new Map();
  }

  /**
   * Look up the current negotiation state for a transport. Returns the
   * canonical `pre` state if the transport id has never been seen — this
   * is the lazy-initialization seam (no `onConnect` plumbing required).
   *
   * Exported for the wrapper's gate predicate; not part of the public
   * orchestrator API. (TypeScript visibility: `public` so the wrapper can
   * call it from a sibling class. The negotiator's external surface is
   * `wrap`, `cleanupTransport`, and `registerHandshakeMethod`.)
   */
  getState(transportId: number): NegotiationState {
    const existing = this.#states.get(transportId);
    if (existing !== undefined) {
      return existing;
    }
    return { kind: "pre" };
  }

  /**
   * Wrap a raw `MethodRegistry` so its `dispatch()` consults the
   * negotiator's per-connection state before delegating. The returned
   * registry has identical `register` / `has` / `isMutating` semantics
   * to the inner — only `dispatch` is gated.
   *
   * Idempotency: each call returns a fresh wrapper around the same
   * inner. Multiple wraps of the same inner are observationally
   * indistinguishable; the negotiator state is shared because it lives
   * on `this`.
   */
  wrap(inner: MethodRegistry): MethodRegistry {
    return new WrappedRegistry(inner, this);
  }

  /**
   * Register the `daemon.hello` handler against the supplied registry.
   * MUST be called once during bootstrap, after `wrap()` and before the
   * gateway starts listening. Re-registration on the same registry
   * throws (per I-007-6 — duplicate-method registration is rejected at
   * register-time).
   *
   * Why register against `mutating: false` (advisor-pinned):
   *   The gate refuses mutating dispatch on `pre` state. If
   *   `daemon.hello` were classified mutating, the connection could
   *   never escape pre-handshake — the only call that escapes WOULD be
   *   refused by the gate. Two solutions are observationally equivalent:
   *     (a) name-bypass in the gate: `if (method === DAEMON_HELLO_METHOD)
   *         skipGate()`.
   *     (b) classify `daemon.hello` as non-mutating: the gate's predicate
   *         is `isMutating(method) === true`, which is false for
   *         `daemon.hello`, so it passes through.
   *   Choice: (b). Rationale: `daemon.hello` mutates PROTOCOL state, not
   *   DOMAIN state. The `mutating` flag's contract per
   *   `RegisterOptions.mutating` JSDoc is "domain mutation requiring
   *   compatible negotiation"; the protocol-negotiation handshake is the
   *   bootstrap of THAT compatibility, not a domain mutation. Choosing
   *   (b) keeps the gate's logic uniform — every method goes through the
   *   same predicate; no special-case method-name list to maintain.
   */
  registerHandshakeMethod(registry: MethodRegistry): void {
    const handler: Handler<DaemonHello, DaemonHelloAck> = async (params, ctx) => {
      // Per the advisor-pinned contract: `daemon.hello` MUST require
      // ctx.transportId. No transport id means the call originated from
      // direct test code with no per-connection state to track — refuse
      // explicitly so a test misconfiguration surfaces as a clear
      // failure rather than silently corrupting the negotiator's map.
      if (ctx.transportId === undefined) {
        throw new NegotiationError(
          "pre_handshake_mutating_refused",
          `${DAEMON_HELLO_METHOD}: handler requires ctx.transportId (per-connection negotiation state requires a transport identity)`,
        );
      }
      const transportId = ctx.transportId;

      // Fail-second posture: a second
      // `daemon.hello` on a connection with prior state returns an ack
      // with `reason: handshake_already_completed`. The state is NOT
      // re-evaluated — the first handshake's outcome is latched.
      const existing = this.#states.get(transportId);
      if (existing !== undefined) {
        const priorVersion =
          existing.kind === "done-compatible"
            ? existing.negotiatedProtocolVersion
            : existing.kind === "done-incompatible"
              ? existing.preferredProtocolVersion
              : // existing.kind === "pre" — only possible if a future
                // amendment introduces a "pending" sub-state; today the
                // map only stores `done-*` entries (see lazy-init seam
                // in getState). Defensive fallback returns the caller's
                // protocolVersion.
                params.protocolVersion;
        // The ack carries the connection's PRIOR negotiated/preferred
        // version so the client can correlate. The optional
        // `daemonSupportedProtocols` field is OMITTED on this path
        // (under exactOptionalPropertyTypes, optional fields are not
        // assigned `undefined`); the client already knows the daemon's
        // supported set from the first handshake's ack.
        return {
          compatible: false,
          protocolVersion: priorVersion,
          reason: NEGOTIATION_REASON_HANDSHAKE_ALREADY_COMPLETED,
        };
      }

      // First handshake on this connection — run the negotiation.
      const outcome = negotiateProtocol(params);

      if (outcome.kind === "compatible") {
        const newState: NegotiationState = {
          kind: "done-compatible",
          negotiatedProtocolVersion: outcome.negotiated,
        };
        this.#states.set(transportId, newState);
        return {
          compatible: true,
          protocolVersion: outcome.negotiated,
        };
      }

      // Incompatible — floor or ceiling.
      const reason: NegotiationIncompatibleReason =
        outcome.kind === "floor"
          ? NEGOTIATION_REASON_FLOOR_EXCEEDED
          : NEGOTIATION_REASON_CEILING_EXCEEDED;
      const newState: NegotiationState = {
        kind: "done-incompatible",
        preferredProtocolVersion: outcome.daemonPreferred,
        reason,
      };
      this.#states.set(transportId, newState);
      // The ack surfaces `daemonSupportedProtocols` so the client can
      // decide whether to abort or retry against a different version.
      // The `as readonly (number | string)[]` widens the daemon-internal
      // `readonly number[]` to the contract's `ReadonlyArray<number |
      // string>` shape; the runtime values are unchanged.
      return {
        compatible: false,
        protocolVersion: outcome.daemonPreferred,
        reason,
        daemonSupportedProtocols: DAEMON_SUPPORTED_PROTOCOL_VERSIONS as ReadonlyArray<
          number | string
        >,
      };
    };

    // Register with `mutating: false` per the rationale above. The gate
    // predicate's `isMutating(DAEMON_HELLO_METHOD) === true` evaluates
    // to `false`, so the handshake call escapes the gate.
    registry.register(
      DAEMON_HELLO_METHOD,
      DaemonHelloRequestSchema,
      DaemonHelloAckResultSchema,
      handler,
      { mutating: false },
    );
  }

  /**
   * Drop the per-connection state for a closed transport. MUST be called
   * by the bootstrap orchestrator from whichever supervision hook
   * composes the gateway's `onDisconnect`. The gateway's hook slot is
   * single-consumer (Tier 4 desktop-shell), so the bootstrap composes
   * a combined hook that calls both this method and the desktop-shell
   * hook.
   *
   * Idempotent: cleanup of an unknown transport id is a no-op.
   */
  cleanupTransport(transportId: number): void {
    this.#states.delete(transportId);
  }
}

// --------------------------------------------------------------------------
// Zod runtime usage note
// --------------------------------------------------------------------------
//
// This module imports `ZodType` AS A TYPE ONLY, and routes the import
// through `@ai-sidekicks/contracts` (which re-exports `ZodType` for exactly
// this purpose — see `packages/contracts/src/jsonrpc-registry.ts` line 65).
// Under `verbatimModuleSyntax: true` the type-only import is erased at
// emit time, so there is no runtime dependency on `zod` from this file.
// The runtime-daemon's package.json deliberately omits `zod` — the schemas
// (`DaemonHelloSchema`, `DaemonHelloAckSchema`) live in
// `@ai-sidekicks/contracts` which DOES depend on `zod`. The runtime-daemon
// receives them as opaque `ZodType<DaemonHello>` / `ZodType<DaemonHelloAck>`
// values, passes them to the registry's `register()`, and never invokes the
// Zod runtime API directly. This routing pattern mirrors `registry.ts`
// line 66 — the daemon never imports from `"zod"` itself.

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
//     by T-007p-2-2 (`jsonrpc-error-mapping.ts`). The dispatcher
//     discriminates `instanceof NegotiationError` and projects
//     `negotiationCode` into `error.data.type` per error-contracts.md
//     §JSON-RPC Wire Mapping (BL-103 closed 2026-05-01).
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
 * The protocol versions THIS daemon build can speak. V1 ships exactly
 * one (`"2026-05-01"`); future amendments append further ISO 8601
 * `YYYY-MM-DD` strings as the JSON-RPC envelope shape evolves.
 *
 * The list is daemon-internal — clients learn the daemon's full set via
 * the `DaemonHelloAck.daemonSupportedProtocols` field on a refused
 * handshake.
 *
 * Stored as `readonly string[]` per the BL-102 ratification at
 * api-payload-contracts.md §Tier 1 (cont.): Plan-007 (2026-05-01). The
 * negotiation algorithm uses lex-sort to find the max version — ISO 8601
 * lex order ≡ chronological order — so no separate semver parser is
 * needed.
 */
export const DAEMON_SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = ["2026-05-01"];

// --------------------------------------------------------------------------
// NegotiationError — gate-refusal failure surface
// --------------------------------------------------------------------------

/**
 * Stable string codes for negotiation-time failures surfaced by the gate.
 * Distinct from the `NegotiationIncompatibleReason` strings (which ride
 * inside a successful `DaemonHelloAck` envelope) — these codes are for
 * gate-refusal THROWS, not for handshake-completion ACKs.
 *
 *   * `"protocol.handshake_required"` — a mutating method was dispatched
 *     before any `daemon.hello` completed on this connection. I-007-1
 *     fail-closed enforcement: the gate refuses rather than letting the
 *     dispatch flow through to the registry. Maps to JSON-RPC `-32600`
 *     per error-contracts.md §JSON-RPC Wire Mapping.
 *   * `"protocol.version_mismatch"` — a mutating method was dispatched
 *     after a `daemon.hello` that yielded `compatible: false`.
 *     Spec-007:67-68 enforcement: read-only methods continue working;
 *     mutating methods are blocked until versions are compatible. Maps
 *     to JSON-RPC `-32600` per error-contracts.md §JSON-RPC Wire Mapping.
 *
 * Both strings are the canonical project dotted-namespace identifiers
 * registered at error-contracts.md §JSON-RPC Wire Mapping (BL-103 closed
 * 2026-05-01); `mapJsonRpcError` projects `negotiationCode` directly into
 * the JSON-RPC envelope's `error.data.type`.
 */
export type NegotiationErrorCode = "protocol.handshake_required" | "protocol.version_mismatch";

/**
 * Error thrown from the gate-as-wrapper's `dispatch` proxy when a mutating
 * method is refused. The throw flows out of the wrapped registry's
 * `dispatch()` and reaches `mapJsonRpcError`, which discriminates
 * `instanceof NegotiationError` and projects `negotiationCode` into
 * `error.data.type` (and `fields`, when present, into `error.data.fields`)
 * per error-contracts.md §JSON-RPC Wire Mapping.
 *
 * Subclassing `Error`:
 *   * `name` is set so stack traces / `instanceof` discrimination works
 *     uniformly across the daemon's error-handling surfaces. Mirrors the
 *     pattern in `RegistryDispatchError` and `FramingError`.
 *   * `negotiationCode` is the canonical project dotted-namespace
 *     identifier consumers compare against without parsing `message`.
 *   * `fields` carries optional structured detail (e.g. `{ reason }` for
 *     `protocol.version_mismatch` so observers can correlate the prior
 *     handshake's incompatibility reason).
 *   * `message` is human-readable, includes the offending method name,
 *     and is safe to print to operator logs (no secrets, no path leaks).
 */
export class NegotiationError extends Error {
  readonly negotiationCode: NegotiationErrorCode;
  readonly fields?: Record<string, unknown>;

  constructor(
    negotiationCode: NegotiationErrorCode,
    message: string,
    fields?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "NegotiationError";
    this.negotiationCode = negotiationCode;
    if (fields !== undefined) {
      this.fields = fields;
    }
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
 *     Mutating dispatch is refused with `protocol.handshake_required`;
 *     the only method that escapes is `daemon.hello` itself (registered
 *     with `mutating: false`).
 *   * `"done-compatible"` — a `daemon.hello` completed and the daemon
 *     selected a compatible protocol version. All dispatches allowed
 *     (read + mutating) — the gate's `isMutating(method) === true` check
 *     does not refuse.
 *   * `"done-incompatible"` — a `daemon.hello` completed but the daemon
 *     could not find a compatible protocol version. Mutating dispatch is
 *     refused with `protocol.version_mismatch`; read-only
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
      readonly negotiatedProtocolVersion: string;
    }
  | {
      readonly kind: "done-incompatible";
      readonly preferredProtocolVersion: string;
      readonly reason: NegotiationIncompatibleReason;
    };

// --------------------------------------------------------------------------
// Negotiation algorithm — F-007p-2-10
// --------------------------------------------------------------------------

/**
 * Result of the F-007p-2-10 negotiation algorithm against a `DaemonHello`
 * payload. Three shapes:
 *
 *   * `{ kind: "compatible", negotiated }` — lex-max of `client ∩ daemon`
 *     is defined; `negotiated` is that value.
 *   * `{ kind: "floor", daemonPreferred }` — every client-advertised
 *     version is BELOW the daemon's lowest supported version. Client too
 *     old. The daemon's preferred version is the highest the daemon
 *     supports (so the client can decide whether to retry against it).
 *   * `{ kind: "ceiling", daemonPreferred }` — every client-advertised
 *     version is ABOVE the daemon's highest supported version. Client too
 *     new.
 *
 * All values are ISO 8601 `YYYY-MM-DD` date-strings per the BL-102
 * ratification (api-payload-contracts.md §Tier 1 (cont.): Plan-007).
 * Comparisons rely on lex order ≡ chronological order.
 */
type NegotiationOutcome =
  | { readonly kind: "compatible"; readonly negotiated: string }
  | { readonly kind: "floor"; readonly daemonPreferred: string }
  | { readonly kind: "ceiling"; readonly daemonPreferred: string };

/**
 * Run the F-007p-2-10 negotiation algorithm against a `DaemonHello` and
 * the daemon's supported-version list.
 *
 * Algorithm (per F-007p-2-10):
 *   1. Build the client's advertised set: `supportedProtocols` if present,
 *      else fall back to a singleton `[protocolVersion]`.
 *   2. Intersect with `DAEMON_SUPPORTED_PROTOCOL_VERSIONS`.
 *   3. If non-empty: return the lex-max of the intersection as compatible.
 *   4. If empty: discriminate floor (lex-max(client) < lex-min(daemon))
 *      vs ceiling (lex-max(client) >= lex-min(daemon) but no overlap).
 *
 * The daemon's preferred version on refusal is the lex-max of the daemon's
 * supported set, surfaced to the client via the ack so the client can
 * decide whether to retry against a different version.
 *
 * ISO 8601 `YYYY-MM-DD` lex order is identical to chronological order, so
 * `[...].sort().at(-1)!` is the max-version primitive — no separate
 * semver parser is required. Schema validation upstream guarantees every
 * advertised string conforms to the regex and `supportedProtocols` (when
 * present) carries at least one entry.
 */
function negotiateProtocol(hello: DaemonHello): NegotiationOutcome {
  const daemonSupported = DAEMON_SUPPORTED_PROTOCOL_VERSIONS;
  const daemonSorted = [...daemonSupported].sort();
  const daemonMin = daemonSorted.at(0)!;
  const daemonMax = daemonSorted.at(-1)!;

  const clientAdvertised: ReadonlyArray<string> =
    hello.supportedProtocols !== undefined ? hello.supportedProtocols : [hello.protocolVersion];

  const daemonSet = new Set<string>(daemonSupported);
  const intersection = clientAdvertised.filter((v) => daemonSet.has(v));

  if (intersection.length > 0) {
    return { kind: "compatible", negotiated: [...intersection].sort().at(-1)! };
  }

  const clientMax = [...clientAdvertised].sort().at(-1)!;
  if (clientMax < daemonMin) {
    return { kind: "floor", daemonPreferred: daemonMax };
  }
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
            "protocol.handshake_required",
            // Sanitization at the gateway boundary covers any path leak
            // that might enter via `method`; here the only inputs are the
            // method name string (developer-supplied) and a static
            // sentence — neither carries sensitive data.
            `protocol-negotiation: mutating method ${JSON.stringify(method)} refused before \`${DAEMON_HELLO_METHOD}\` completed (I-007-1 fail-closed; per Spec-007:47)`,
          );
        }
        if (state.kind === "done-incompatible") {
          throw new NegotiationError(
            "protocol.version_mismatch",
            `protocol-negotiation: mutating method ${JSON.stringify(method)} refused because the connection's prior handshake was incompatible (reason=${JSON.stringify(state.reason)}; per Spec-007:67-68)`,
            { reason: state.reason },
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
      // `daemon.hello` MUST require ctx.transportId. A missing transport
      // id means the call originated from direct test code (or a daemon-
      // bootstrap bug) — neither is a client protocol violation, so we
      // throw a plain Error which `mapJsonRpcError` collapses to `-32603
      // InternalError` (the honest mapping for a substrate-internal
      // invariant violation per error-contracts.md §JSON-RPC Wire
      // Mapping). Refuse explicitly so the misconfiguration surfaces as
      // a clear failure rather than silently corrupting the negotiator's
      // map.
      if (ctx.transportId === undefined) {
        throw new Error(
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
      return {
        compatible: false,
        protocolVersion: outcome.daemonPreferred,
        reason,
        daemonSupportedProtocols: DAEMON_SUPPORTED_PROTOCOL_VERSIONS,
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

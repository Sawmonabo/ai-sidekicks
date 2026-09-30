// Protocol negotiation: the `daemon.hello` exchange and the per-connection gate that blocks
// mutating methods until a compatible handshake has completed.
//
// * Read-only methods are always allowed; an unregistered method (`isMutating` is `undefined`)
//   falls through to the inner not-found error.
// * The wire schemas live in `@ai-sidekicks/contracts` because this package has no `zod`
//   dependency.
// * The agreed version is the highest one both sides support.
// * The gate wraps a `MethodRegistry`, so the gateway knows nothing about negotiation.

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

/**
 * The protocol versions this daemon speaks, as `YYYY-MM-DD` strings; lexical order is
 * chronological order.
 */
export const DAEMON_SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = ["2026-05-01"];

/**
 * Codes for gate refusals: a mutating method before any `daemon.hello` completed
 * (`handshake_required`), or after one that returned `compatible: false` (`version_mismatch`).
 */
export type NegotiationErrorCode = "protocol.handshake_required" | "protocol.version_mismatch";

/**
 * Thrown by the wrapped registry's `dispatch` when a mutating method is refused;
 * `mapJsonRpcError` copies `negotiationCode` into `error.data.type` and `fields` into
 * `error.data.fields`.
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

/**
 * The negotiation state of one connection: `pre` (no handshake yet), `done-compatible` or
 * `done-incompatible`. The first outcome is latched, so a repeated or hostile `daemon.hello`
 * cannot flip the gate mid-connection.
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

// `floor`: every client version is below the daemon's lowest; `ceiling`: no overlap otherwise.
// `daemonPreferred` is the daemon's highest version, for the client to retry against.
type NegotiationOutcome =
  | { readonly kind: "compatible"; readonly negotiated: string }
  | { readonly kind: "floor"; readonly daemonPreferred: string }
  | { readonly kind: "ceiling"; readonly daemonPreferred: string };

// Schema validation upstream guarantees every version is a date string and the list is non-empty.
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

// Typed as `ZodType<...>` so `register` infers its parameter and result types.
const DaemonHelloAckResultSchema: ZodType<DaemonHelloAck> = DaemonHelloAckSchema;

const DaemonHelloRequestSchema: ZodType<DaemonHello> = DaemonHelloSchema;

// Delegates everything to the inner registry; only `dispatch` applies the gate.
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
    // `opts` is forwarded only when present (exactOptionalPropertyTypes).
    if (opts === undefined) {
      this.#inner.register(method, paramsSchema, resultSchema, handler);
    } else {
      this.#inner.register(method, paramsSchema, resultSchema, handler, opts);
    }
  }

  async dispatch(method: string, params: unknown, ctx: HandlerContext): Promise<unknown> {
    // An unregistered method passes through so the inner dispatch reports `method_not_found`.
    const isMutating = this.#inner.isMutating(method);
    if (isMutating === true) {
      // A call without a transport id is direct dispatch, not over the wire, and is not gated.
      const transportId = ctx.transportId;
      if (transportId !== undefined) {
        const state = this.#negotiator.getState(transportId);
        if (state.kind === "pre") {
          throw new NegotiationError(
            "protocol.handshake_required",
            `protocol-negotiation: mutating method ${JSON.stringify(method)} refused before \`${DAEMON_HELLO_METHOD}\` completed (fail-closed)`,
          );
        }
        if (state.kind === "done-incompatible") {
          throw new NegotiationError(
            "protocol.version_mismatch",
            `protocol-negotiation: mutating method ${JSON.stringify(method)} refused because the connection's prior handshake was incompatible (reason=${JSON.stringify(state.reason)})`,
            { reason: state.reason },
          );
        }
      }
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

/**
 * Keeps per-connection negotiation state and wraps a registry with the gate. The caller must call
 * `cleanupTransport` on every connection close, or the state map leaks one entry per connection.
 */
export class ProtocolNegotiator {
  // Only completed handshakes are stored; an id with no entry is in `pre`.
  readonly #states: Map<number, NegotiationState>;

  constructor() {
    this.#states = new Map();
  }

  /** Returns the state for a transport, or `pre` when the id has no entry. */
  getState(transportId: number): NegotiationState {
    const existing = this.#states.get(transportId);
    if (existing !== undefined) {
      return existing;
    }
    return { kind: "pre" };
  }

  /** Returns a registry whose `dispatch` is gated by this negotiator; wrappers share its state. */
  wrap(inner: MethodRegistry): MethodRegistry {
    return new WrappedRegistry(inner, this);
  }

  /**
   * Registers the `daemon.hello` handler on `registry`; a second registration on the same
   * registry throws. It is non-mutating, or the gate would refuse the call that leaves `pre`.
   */
  registerHandshakeMethod(registry: MethodRegistry): void {
    const handler: Handler<DaemonHello, DaemonHelloAck> = async (params, ctx) => {
      // A missing transport id is a wiring bug, not a client violation, so a plain Error.
      if (ctx.transportId === undefined) {
        throw new Error(
          `${DAEMON_HELLO_METHOD}: handler requires ctx.transportId (per-connection negotiation state requires a transport identity)`,
        );
      }
      const transportId = ctx.transportId;

      // A repeated hello is refused and the first outcome stays latched.
      const existing = this.#states.get(transportId);
      if (existing !== undefined) {
        const priorVersion =
          existing.kind === "done-compatible"
            ? existing.negotiatedProtocolVersion
            : existing.kind === "done-incompatible"
              ? existing.preferredProtocolVersion
              : // The map holds only `done-*` entries.
                params.protocolVersion;
        // The ack repeats the first handshake's version; the client already has the supported list.
        return {
          compatible: false,
          protocolVersion: priorVersion,
          reason: NEGOTIATION_REASON_HANDSHAKE_ALREADY_COMPLETED,
        };
      }

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
      return {
        compatible: false,
        protocolVersion: outcome.daemonPreferred,
        reason,
        daemonSupportedProtocols: DAEMON_SUPPORTED_PROTOCOL_VERSIONS,
      };
    };

    registry.register(
      DAEMON_HELLO_METHOD,
      DaemonHelloRequestSchema,
      DaemonHelloAckResultSchema,
      handler,
      { mutating: false },
    );
  }

  /** Drops the state for a closed transport; a no-op for an unknown id. */
  cleanupTransport(transportId: number): void {
    this.#states.delete(transportId);
  }
}

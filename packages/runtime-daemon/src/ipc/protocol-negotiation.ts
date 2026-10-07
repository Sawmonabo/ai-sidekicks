// Protocol negotiation: the `daemon.hello` exchange and the per-connection gate. A connection is
// served nothing until a hello carrying this start's session token has completed, and mutating
// methods only after a compatible one.
//
// * The token is checked in constant time; a hello without it or with a wrong one latches the
//   connection refused, so nothing more is served on it, a second guess included.
// * After the handshake read-only methods are always allowed; an unregistered method
//   (`isMutating` is `undefined`) falls through to the inner not-found error.
// * The wire schemas live in `@ai-sidekicks/contracts` because this package has no `zod`
//   dependency.
// * The agreed version is the highest one both sides support.
// * The gate wraps a `MethodRegistry`, so the gateway knows nothing about negotiation.

import type {
  DaemonHello,
  DaemonHelloAck,
  NegotiationIncompatibleReason,
} from "@ai-sidekicks/contracts/jsonrpc/negotiation";
import type {
  Handler,
  HandlerContext,
  MethodRegistry,
  RegisterOptions,
  ZodType,
} from "@ai-sidekicks/contracts/jsonrpc/registry";
import { timingSafeEqual } from "node:crypto";

import {
  DAEMON_HELLO_METHOD,
  DaemonHelloAckSchema,
  DaemonHelloSchema,
  NEGOTIATION_REASON_CEILING_EXCEEDED,
  NEGOTIATION_REASON_FLOOR_EXCEEDED,
  NEGOTIATION_REASON_HANDSHAKE_ALREADY_COMPLETED,
  NEGOTIATION_TOKEN_INVALID_CODE,
  NEGOTIATION_VERSION_MISMATCH_CODE,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "@ai-sidekicks/contracts/jsonrpc/negotiation";

/**
 * Codes for gate refusals: any method but `daemon.hello` before a hello completed
 * (`handshake_required`), a mutating method after one that returned `compatible: false`
 * (`version_mismatch`), and anything on a connection whose hello lacked the right session token
 * (`auth.token_invalid`).
 */
export type NegotiationErrorCode =
  | "protocol.handshake_required"
  | typeof NEGOTIATION_VERSION_MISMATCH_CODE
  | typeof NEGOTIATION_TOKEN_INVALID_CODE;

/**
 * Thrown by the wrapped registry's `dispatch` when the gate refuses a call, and by `daemon.hello`
 * for a missing or wrong session token; `mapJsonRpcError` copies `negotiationCode` into
 * `error.data.type` and `fields` into `error.data.fields`.
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
 * The negotiation state of one connection: `pre` (no handshake yet), `refused` (a hello without
 * the right session token), `done-compatible` or `done-incompatible`. The first outcome is
 * latched, so a repeated or hostile `daemon.hello` cannot flip the gate mid-connection.
 */
export type NegotiationState =
  | { readonly kind: "pre" }
  | { readonly kind: "refused" }
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
function negotiateProtocol(
  hello: DaemonHello,
  daemonSupported: readonly string[],
): NegotiationOutcome {
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
    // A call without a transport id is direct dispatch, not over the wire, and is not gated.
    const transportId = ctx.transportId;
    if (transportId !== undefined) {
      const state = this.#negotiator.getState(transportId);
      if (state.kind === "refused") {
        throw sessionTokenRefusal();
      }
      if (state.kind === "pre" && method !== DAEMON_HELLO_METHOD) {
        throw new NegotiationError(
          "protocol.handshake_required",
          `protocol-negotiation: method ${JSON.stringify(method)} refused before ` +
            `\`${DAEMON_HELLO_METHOD}\` completed (fail-closed)`,
        );
      }
      // An unregistered method passes through so the inner dispatch reports `method_not_found`.
      if (state.kind === "done-incompatible" && this.#inner.isMutating(method) === true) {
        throw new NegotiationError(
          NEGOTIATION_VERSION_MISMATCH_CODE,
          `protocol-negotiation: mutating method ${JSON.stringify(method)} refused because ` +
            `the connection's prior handshake was incompatible (reason=` +
            `${JSON.stringify(state.reason)})`,
          { reason: state.reason },
        );
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
  // Only latched outcomes are stored; an id in neither is in `pre`. A refusal is held apart from
  // the handshakes, since the gate answers it before the hello handler runs.
  readonly #refusedTransports: Set<number>;
  readonly #handshakes: Map<
    number,
    Exclude<NegotiationState, { readonly kind: "pre" | "refused" }>
  >;
  readonly #sessionToken: Buffer;

  /** `sessionToken` is the token this daemon start wrote to its token file. */
  constructor(sessionToken: string) {
    this.#refusedTransports = new Set();
    this.#handshakes = new Map();
    this.#sessionToken = Buffer.from(sessionToken, "utf8");
  }

  /** Returns the state for a transport, or `pre` when the id has no entry. */
  getState(transportId: number): NegotiationState {
    if (this.#refusedTransports.has(transportId)) {
      return { kind: "refused" };
    }
    return this.#handshakes.get(transportId) ?? { kind: "pre" };
  }

  /** Returns a registry whose `dispatch` is gated by this negotiator; wrappers share its state. */
  wrap(inner: MethodRegistry): MethodRegistry {
    return new WrappedRegistry(inner, this);
  }

  /**
   * Registers the `daemon.hello` handler on `registry`; a second registration on the same
   * registry throws. It is non-mutating, so a client whose handshake was incompatible can still
   * repeat it and read the latched answer.
   */
  registerHandshakeMethod(registry: MethodRegistry): void {
    const handler: Handler<DaemonHello, DaemonHelloAck> = async (params, ctx) => {
      // A missing transport or device id is a wiring bug, not a client violation, so a plain Error.
      const { transportId, deviceId } = ctx;
      if (transportId === undefined || deviceId === undefined) {
        const missing = transportId === undefined ? "ctx.transportId" : "ctx.deviceId";
        throw new Error(`${DAEMON_HELLO_METHOD}: handler requires ${missing}`);
      }

      // A repeated hello is refused and the first outcome stays latched. The ack repeats the first
      // handshake's version; the client already has the supported list.
      const existing = this.#handshakes.get(transportId);
      if (existing !== undefined) {
        return {
          compatible: false,
          protocolVersion:
            existing.kind === "done-compatible"
              ? existing.negotiatedProtocolVersion
              : existing.preferredProtocolVersion,
          deviceId,
          reason: NEGOTIATION_REASON_HANDSHAKE_ALREADY_COMPLETED,
        };
      }

      if (!this.#isSessionToken(params.sessionToken)) {
        this.#refusedTransports.add(transportId);
        throw sessionTokenRefusal();
      }

      const outcome = negotiateProtocol(params, SUPPORTED_PROTOCOL_VERSIONS);

      if (outcome.kind === "compatible") {
        const newState: NegotiationState = {
          kind: "done-compatible",
          negotiatedProtocolVersion: outcome.negotiated,
        };
        this.#handshakes.set(transportId, newState);
        return {
          compatible: true,
          protocolVersion: outcome.negotiated,
          deviceId,
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
      this.#handshakes.set(transportId, newState);
      return {
        compatible: false,
        protocolVersion: outcome.daemonPreferred,
        deviceId,
        reason,
        daemonSupportedProtocols: SUPPORTED_PROTOCOL_VERSIONS,
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

  // Constant-time, after a length check, since `timingSafeEqual` throws on unequal lengths.
  #isSessionToken(presented: string | undefined): boolean {
    if (presented === undefined) {
      return false;
    }
    const presentedBytes = Buffer.from(presented, "utf8");
    return (
      presentedBytes.byteLength === this.#sessionToken.byteLength &&
      timingSafeEqual(presentedBytes, this.#sessionToken)
    );
  }

  /** Drops the state for a closed transport; a no-op for an unknown id. */
  cleanupTransport(transportId: number): void {
    this.#refusedTransports.delete(transportId);
    this.#handshakes.delete(transportId);
  }
}

// One message for a missing and a wrong token, so a refusal says nothing about the token.
function sessionTokenRefusal(): NegotiationError {
  return new NegotiationError(
    NEGOTIATION_TOKEN_INVALID_CODE,
    `protocol-negotiation: the connection's \`${DAEMON_HELLO_METHOD}\` lacked this daemon's ` +
      "session token, so nothing is served on it",
  );
}

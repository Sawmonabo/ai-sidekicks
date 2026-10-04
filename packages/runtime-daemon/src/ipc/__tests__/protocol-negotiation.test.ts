// `ProtocolNegotiator`: the `daemon.hello` handshake picks a protocol version, and the gated
// registry refuses mutating methods on a connection until that handshake has succeeded, while an
// unregistered method still answers method_not_found.

import { describe, expect, it } from "vitest";

import type { DaemonHello, DaemonHelloAck } from "@ai-sidekicks/contracts/jsonrpc-negotiation";
import type { Handler, HandlerContext } from "@ai-sidekicks/contracts/jsonrpc-registry";
import {
  DAEMON_HELLO_METHOD,
  NEGOTIATION_REASON_CEILING_EXCEEDED,
  NEGOTIATION_REASON_FLOOR_EXCEEDED,
  NEGOTIATION_REASON_HANDSHAKE_ALREADY_COMPLETED,
} from "@ai-sidekicks/contracts/jsonrpc-negotiation";

import { MethodRegistryImpl, RegistryDispatchError } from "../registry.js";
import {
  DAEMON_SUPPORTED_PROTOCOL_VERSIONS,
  NegotiationError,
  ProtocolNegotiator,
} from "../protocol-negotiation.js";

import { passthroughSchema } from "../__fixtures__/zod-schemas.js";
import { captureRejection } from "../../__fixtures__/capture-failure.js";

// A negotiator with its raw and gated registries; `daemon.hello` is registered on the gated one,
// as bootstrap does.
interface NegotiatorFixture {
  readonly negotiator: ProtocolNegotiator;
  readonly raw: MethodRegistryImpl;
  readonly gated: ReturnType<ProtocolNegotiator["wrap"]>;
}

function makeFixture(): NegotiatorFixture {
  const negotiator = new ProtocolNegotiator();
  const raw = new MethodRegistryImpl();
  const gated = negotiator.wrap(raw);
  negotiator.registerHandshakeMethod(gated);
  return { negotiator, raw, gated };
}

describe("daemon.hello version negotiation", () => {
  it("a compatible handshake selects the newest version client and daemon share", async () => {
    const { gated } = makeFixture();
    // Only the newest version is common to client and daemon.
    const params: DaemonHello = {
      protocolVersion: "2026-05-01",
      supportedProtocols: ["2025-12-31", "2026-05-01"],
    };
    const ctx: HandlerContext = { transportId: 101 };
    const ack = (await gated.dispatch(DAEMON_HELLO_METHOD, params, ctx)) as DaemonHelloAck;
    expect(ack.compatible).toBe(true);
    expect(ack.protocolVersion).toBe("2026-05-01");
    expect(ack.reason).toBeUndefined();
  });

  it("an incompatible handshake from a client too old answers the floor reason and the daemon's versions", async () => {
    const { gated } = makeFixture();
    // The client's only version is older than the daemon's oldest.
    const params: DaemonHello = {
      protocolVersion: "2025-12-31",
      supportedProtocols: ["2025-12-31"],
    };
    const ctx: HandlerContext = { transportId: 102 };
    const ack = (await gated.dispatch(DAEMON_HELLO_METHOD, params, ctx)) as DaemonHelloAck;
    expect(ack.compatible).toBe(false);
    expect(ack.reason).toBe(NEGOTIATION_REASON_FLOOR_EXCEEDED);
    // The daemon's versions are returned so the client can decide whether to retry.
    expect(ack.daemonSupportedProtocols).toBeDefined();
    expect(ack.daemonSupportedProtocols).toStrictEqual(DAEMON_SUPPORTED_PROTOCOL_VERSIONS);
  });

  it("an incompatible handshake from a client too new answers the ceiling reason", async () => {
    const { gated } = makeFixture();
    // Every client version is newer than the daemon's newest.
    const params: DaemonHello = {
      protocolVersion: "2026-06-01",
      supportedProtocols: ["2026-06-01", "2026-07-01"],
    };
    const ctx: HandlerContext = { transportId: 103 };
    const ack = (await gated.dispatch(DAEMON_HELLO_METHOD, params, ctx)) as DaemonHelloAck;
    expect(ack.compatible).toBe(false);
    expect(ack.reason).toBe(NEGOTIATION_REASON_CEILING_EXCEEDED);
  });

  it("a repeated handshake on one connection is refused and echoes the first version", async () => {
    const { gated } = makeFixture();
    const ctx: HandlerContext = { transportId: 104 };
    const params: DaemonHello = {
      protocolVersion: "2026-05-01",
      supportedProtocols: ["2026-05-01"],
    };
    const first = (await gated.dispatch(DAEMON_HELLO_METHOD, params, ctx)) as DaemonHelloAck;
    expect(first.compatible).toBe(true);
    const second = (await gated.dispatch(DAEMON_HELLO_METHOD, params, ctx)) as DaemonHelloAck;
    expect(second.compatible).toBe(false);
    expect(second.reason).toBe(NEGOTIATION_REASON_HANDSHAKE_ALREADY_COMPLETED);
    // The version negotiated by the first hello is echoed back.
    expect(second.protocolVersion).toBe("2026-05-01");
  });

  it("`cleanupTransport` clears the connection's state, and ignores an unknown connection", async () => {
    const { gated, negotiator } = makeFixture();
    const ctx: HandlerContext = { transportId: 105 };
    const params: DaemonHello = {
      protocolVersion: "2026-05-01",
      supportedProtocols: ["2026-05-01"],
    };
    await gated.dispatch(DAEMON_HELLO_METHOD, params, ctx);
    expect(negotiator.getState(105).kind).toBe("done-compatible");
    negotiator.cleanupTransport(105);
    // An unknown transport reads as `pre`.
    expect(negotiator.getState(105).kind).toBe("pre");
    expect(() => negotiator.cleanupTransport(999)).not.toThrow();
  });
});

describe("the mutating-method gate", () => {
  it("before a handshake, passes a read and refuses a mutating method as handshake_required", async () => {
    const { raw, gated } = makeFixture();
    const handler: Handler<unknown, { ok: true }> = async () => ({ ok: true });
    raw.register(
      "math.read",
      passthroughSchema<unknown>(),
      passthroughSchema<{ ok: true }>(),
      handler,
      { mutating: false },
    );
    raw.register(
      "math.write",
      passthroughSchema<unknown>(),
      passthroughSchema<{ ok: true }>(),
      handler,
      { mutating: true },
    );
    const ctx: HandlerContext = { transportId: 201 };
    const result = await gated.dispatch("math.read", {}, ctx);
    expect(result).toStrictEqual({ ok: true });
    const caught = await captureRejection(gated.dispatch("math.write", {}, ctx));
    expect(caught).toBeInstanceOf(NegotiationError);
    if (caught instanceof NegotiationError) {
      expect(caught.negotiationCode).toBe("protocol.handshake_required");
    }
  });

  it("unregistered methods bypass the gate predicate and surface `method_not_found` from the inner registry", async () => {
    const { gated } = makeFixture();
    const ctx: HandlerContext = { transportId: 204 };
    // With no handshake, the gate must still let an unregistered method reach the inner
    // registry; refusing it would hide the not-found error behind a handshake error.
    const caught = await captureRejection(gated.dispatch("not.registered", {}, ctx));
    expect(caught).toBeInstanceOf(RegistryDispatchError);
    if (caught instanceof RegistryDispatchError) {
      expect(caught.registryCode).toBe("method_not_found");
    }
  });

  it("after a compatible handshake, a mutating method passes", async () => {
    const { raw, gated } = makeFixture();
    const handler: Handler<unknown, { ok: true }> = async () => ({ ok: true });
    raw.register(
      "math.write",
      passthroughSchema<unknown>(),
      passthroughSchema<{ ok: true }>(),
      handler,
      { mutating: true },
    );
    const ctx: HandlerContext = { transportId: 202 };
    const params: DaemonHello = {
      protocolVersion: "2026-05-01",
      supportedProtocols: ["2026-05-01"],
    };
    const ack = (await gated.dispatch(DAEMON_HELLO_METHOD, params, ctx)) as DaemonHelloAck;
    expect(ack.compatible).toBe(true);
    const result = await gated.dispatch("math.write", {}, ctx);
    expect(result).toStrictEqual({ ok: true });
  });

  it("after an incompatible handshake, a read passes and a mutating method is refused", async () => {
    const { raw, gated } = makeFixture();
    raw.register(
      "math.read",
      passthroughSchema<unknown>(),
      passthroughSchema<{ ok: true }>(),
      async () => ({ ok: true }),
      { mutating: false },
    );
    raw.register(
      "math.write",
      passthroughSchema<unknown>(),
      passthroughSchema<{ ok: true }>(),
      async () => ({ ok: true }),
      { mutating: true },
    );
    const ctx: HandlerContext = { transportId: 203 };
    const params: DaemonHello = {
      protocolVersion: "2026-06-01",
      supportedProtocols: ["2026-06-01", "2026-07-01"],
    };
    const ack = (await gated.dispatch(DAEMON_HELLO_METHOD, params, ctx)) as DaemonHelloAck;
    expect(ack.compatible).toBe(false);
    const readResult = await gated.dispatch("math.read", {}, ctx);
    expect(readResult).toStrictEqual({ ok: true });
    const caught = await captureRejection(gated.dispatch("math.write", {}, ctx));
    expect(caught).toBeInstanceOf(NegotiationError);
    if (caught instanceof NegotiationError) {
      expect(caught.negotiationCode).toBe("protocol.version_mismatch");
    }
  });
});

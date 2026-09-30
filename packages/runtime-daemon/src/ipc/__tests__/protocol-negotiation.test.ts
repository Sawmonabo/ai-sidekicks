// Tests `ProtocolNegotiator`: the `daemon.hello` handshake picks a protocol version, and the
// gate around the registry refuses mutating methods on a connection until that handshake has
// succeeded. Read-only methods are always allowed.
//
// The tests bind no listener; they call `dispatch` on the gated registry with a hand-built
// `HandlerContext { transportId }`.

import { describe, expect, it } from "vitest";

import type { DaemonHello, DaemonHelloAck, Handler, HandlerContext } from "@ai-sidekicks/contracts";
import {
  DAEMON_HELLO_METHOD,
  NEGOTIATION_REASON_CEILING_EXCEEDED,
  NEGOTIATION_REASON_FLOOR_EXCEEDED,
  NEGOTIATION_REASON_HANDSHAKE_ALREADY_COMPLETED,
} from "@ai-sidekicks/contracts";

import { MethodRegistryImpl, RegistryDispatchError } from "../registry.js";
import {
  DAEMON_SUPPORTED_PROTOCOL_VERSIONS,
  NegotiationError,
  ProtocolNegotiator,
} from "../protocol-negotiation.js";

import { passthroughSchema } from "./__fixtures__/zod-schemas.js";

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

describe("handshake + version-negotiation compatibility", () => {
  it("compatible handshake (intersection non-empty) → `compatible: true` + max-of-intersection", async () => {
    const { gated } = makeFixture();
    const params: DaemonHello = {
      protocolVersion: "2026-05-01",
      supportedProtocols: ["2026-05-01"],
    };
    const ctx: HandlerContext = { transportId: 100 };
    const ack = (await gated.dispatch(DAEMON_HELLO_METHOD, params, ctx)) as DaemonHelloAck;
    expect(ack.compatible).toBe(true);
    expect(ack.protocolVersion).toBe("2026-05-01");
    expect(ack.reason).toBeUndefined();
  });

  it("compatible handshake selects max(client ∩ daemon)", async () => {
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
  });

  it("incompatible handshake (client too old) → `compatible: false` + `version.floor_exceeded` + daemonSupportedProtocols", async () => {
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

  it("incompatible handshake (client too new) → `compatible: false` + `version.ceiling_exceeded`", async () => {
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

  it("repeated handshake on same connection → `compatible: false` + `handshake_already_completed` (latched)", async () => {
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

  it("daemon.hello requires ctx.transportId — refusing direct dispatch with no wire boundary", async () => {
    const { gated } = makeFixture();
    const params: DaemonHello = {
      protocolVersion: "2026-05-01",
      supportedProtocols: ["2026-05-01"],
    };
    let caught: unknown = null;
    try {
      await gated.dispatch(DAEMON_HELLO_METHOD, params, {});
    } catch (err) {
      caught = err;
    }
    // A missing transportId is a daemon bug, not a client protocol violation: the handler throws
    // a plain Error, which is -32603 InternalError on the wire. Every `NegotiationError` is an
    // `Error`, so the negative check is the one that pins this.
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(NegotiationError);
    expect((caught as Error).message).toContain("ctx.transportId");
  });

  it("`cleanupTransport` clears the per-transport state (idempotent on unknown id)", async () => {
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

describe("mutating-op gate when version-mismatch", () => {
  it("read methods pass through in `pre` state (no handshake yet)", async () => {
    const { raw, gated } = makeFixture();
    const handler: Handler<unknown, { ok: true }> = async () => ({ ok: true });
    raw.register(
      "math.read",
      passthroughSchema<unknown>(),
      passthroughSchema<{ ok: true }>(),
      handler,
      { mutating: false },
    );
    const ctx: HandlerContext = { transportId: 200 };
    const result = await gated.dispatch("math.read", {}, ctx);
    expect(result).toStrictEqual({ ok: true });
  });

  it("mutating methods are refused in `pre` state with `protocol.handshake_required`", async () => {
    const { raw, gated } = makeFixture();
    const handler: Handler<unknown, { ok: true }> = async () => ({ ok: true });
    raw.register(
      "math.write",
      passthroughSchema<unknown>(),
      passthroughSchema<{ ok: true }>(),
      handler,
      { mutating: true },
    );
    const ctx: HandlerContext = { transportId: 201 };
    let caught: unknown = null;
    try {
      await gated.dispatch("math.write", {}, ctx);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NegotiationError);
    if (caught instanceof NegotiationError) {
      expect(caught.negotiationCode).toBe("protocol.handshake_required");
    }
  });

  it("after compatible handshake, mutating methods pass through", async () => {
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

  it("after INCOMPATIBLE handshake, read methods still pass + mutating methods refused", async () => {
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
    let caught: unknown = null;
    try {
      await gated.dispatch("math.write", {}, ctx);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NegotiationError);
    if (caught instanceof NegotiationError) {
      expect(caught.negotiationCode).toBe("protocol.version_mismatch");
    }
  });

  it("unregistered methods bypass the gate predicate and surface `method_not_found` from the inner registry", async () => {
    const { gated } = makeFixture();
    const ctx: HandlerContext = { transportId: 204 };
    // With no handshake, the gate must still let an unregistered method reach the inner
    // registry; refusing it would hide the not-found error behind a handshake error.
    let caught: unknown = null;
    try {
      await gated.dispatch("not.registered", {}, ctx);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RegistryDispatchError);
    if (caught instanceof RegistryDispatchError) {
      expect(caught.registryCode).toBe("method_not_found");
    }
  });

  it("daemon.hello escapes the gate (registered `mutating: false` per protocol-negotiation.ts:649-658)", async () => {
    const { gated } = makeFixture();
    // `daemon.hello` must be callable before any handshake; if it were mutating, no connection
    // could leave the pre-handshake state.
    const ctx: HandlerContext = { transportId: 205 };
    const params: DaemonHello = {
      protocolVersion: "2026-05-01",
      supportedProtocols: ["2026-05-01"],
    };
    await expect(gated.dispatch(DAEMON_HELLO_METHOD, params, ctx)).resolves.toBeDefined();
  });

  it("direct dispatch (no transportId) bypasses the gate — test-only seam per protocol-negotiation.ts:447-450", async () => {
    const { raw, gated } = makeFixture();
    raw.register(
      "math.write",
      passthroughSchema<unknown>(),
      passthroughSchema<{ ok: true }>(),
      async () => ({ ok: true }),
      { mutating: true },
    );
    // The gate enforces only over the wire boundary; a context with no transportId is exempt.
    const result = await gated.dispatch("math.write", {}, {});
    expect(result).toStrictEqual({ ok: true });
  });
});

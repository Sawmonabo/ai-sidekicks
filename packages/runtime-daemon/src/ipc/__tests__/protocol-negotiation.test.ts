// W-007p-2-T1 + T8 — ProtocolNegotiator test suite (T-007p-2-6).
//
// Spec coverage:
//   * Spec-007 §Required Behavior line 47
//     (docs/specs/007-local-ipc-and-daemon-control.md) — "Local IPC must
//     support protocol version negotiation before mutating operations
//     are accepted."
//   * Spec-007 §Fallback Behavior lines 67-68 — "If version negotiation
//     fails, read-only compatibility may continue, but mutating
//     operations must be blocked until versions are compatible."
//   * Spec-007 §Interfaces And Contracts line 73 — "`DaemonHello` and
//     `DaemonHelloAck` must perform version negotiation."
//
// Invariants verified here (canonical text in
// docs/plans/007-local-ipc-and-daemon-control.md §Invariants lines
// 95-117):
//   * I-007-1 (fail-closed) — pre-handshake mutating dispatch is
//     refused; read-only dispatch is always allowed.
//   * I-007-7 — the handshake envelopes themselves go through the
//     standard schema-validates-before-dispatch path (registered with
//     `DaemonHelloSchema` / `DaemonHelloAckSchema`).
//
// W-tests covered here (per Plan-007 §Phase 2 lines 373 + 380):
//   * W-007p-2-T1 — Handshake + version-negotiation compatibility.
//                   `DaemonHello` / `DaemonHelloAck` exchange yields
//                   `compatible: true` when intersection is non-empty;
//                   yields `compatible: false` with `reason:
//                   version.floor_exceeded` (client too old) or
//                   `version.ceiling_exceeded` (client too new) when
//                   intersection is empty.
//   * W-007p-2-T8 — Mutating-op gate when `DaemonHelloAck.compatible
//                   === false`. Read methods pass through; mutating
//                   methods refused per the registry's `mutating:
//                   boolean` flag.
//
// The negotiator tests run synchronously without binding any listener
// — dispatch is a direct method call against the gated registry with a
// hand-built `HandlerContext { transportId }`.

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

// ----------------------------------------------------------------------------
// Test fixtures
// ----------------------------------------------------------------------------

/**
 * Build a fresh negotiator + raw + gated registry pair. The handshake
 * handler is registered against the GATED registry per the negotiator's
 * lifecycle contract (the bootstrap orchestrator wraps the registry,
 * registers `daemon.hello`, then constructs the gateway with the
 * gated wrapper).
 */
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

// ----------------------------------------------------------------------------
// W-007p-2-T1 — Handshake + version-negotiation compatibility
// ----------------------------------------------------------------------------

describe("W-007p-2-T1 — handshake + version-negotiation compatibility", () => {
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
    // No reason on success.
    expect(ack.reason).toBeUndefined();
  });

  it("compatible handshake selects max(client ∩ daemon) — F-007p-2-10", async () => {
    const { gated } = makeFixture();
    // Client supports both 0 and 1; daemon supports [1]. Intersection
    // is {1}; max is 1.
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
    // Client only advertises 0; daemon supports [1]. Client is below
    // daemon's floor.
    const params: DaemonHello = {
      protocolVersion: "2025-12-31",
      supportedProtocols: ["2025-12-31"],
    };
    const ctx: HandlerContext = { transportId: 102 };
    const ack = (await gated.dispatch(DAEMON_HELLO_METHOD, params, ctx)) as DaemonHelloAck;
    expect(ack.compatible).toBe(false);
    expect(ack.reason).toBe(NEGOTIATION_REASON_FLOOR_EXCEEDED);
    // daemonSupportedProtocols is surfaced so the client can decide
    // whether to retry.
    expect(ack.daemonSupportedProtocols).toBeDefined();
    expect(ack.daemonSupportedProtocols).toStrictEqual(DAEMON_SUPPORTED_PROTOCOL_VERSIONS);
  });

  it("incompatible handshake (client too new) → `compatible: false` + `version.ceiling_exceeded`", async () => {
    const { gated } = makeFixture();
    // Client advertises [2, 3]; daemon supports [1]. Client is above
    // daemon's ceiling.
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
    // Second hello on the same transport → returns latched
    // `handshake_already_completed` reason.
    const second = (await gated.dispatch(DAEMON_HELLO_METHOD, params, ctx)) as DaemonHelloAck;
    expect(second.compatible).toBe(false);
    expect(second.reason).toBe(NEGOTIATION_REASON_HANDSHAKE_ALREADY_COMPLETED);
    // Prior negotiated version is echoed back so the client can
    // correlate.
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
    // The handler throws a plain Error when no transportId is present —
    // a substrate-internal invariant violation (test misconfiguration
    // or daemon-bootstrap bug), NOT a client protocol violation. On the
    // wire this collapses to `-32603 InternalError` per
    // error-contracts.md §JSON-RPC Wire Mapping. The not.toBeInstanceOf
    // (NegotiationError) check is the discriminating assertion — every
    // NegotiationError IS an Error, so the negative is what pins the
    // posture.
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
    // Verify the state is `done-compatible` before cleanup.
    expect(negotiator.getState(105).kind).toBe("done-compatible");
    negotiator.cleanupTransport(105);
    // Post-cleanup the lazy-init seam returns `pre`.
    expect(negotiator.getState(105).kind).toBe("pre");
    // Idempotent on unknown id.
    expect(() => negotiator.cleanupTransport(999)).not.toThrow();
  });
});

// ----------------------------------------------------------------------------
// W-007p-2-T8 — Mutating-op gate (Spec-007:67-68)
// ----------------------------------------------------------------------------

describe("W-007p-2-T8 — mutating-op gate when version-mismatch", () => {
  it("read methods pass through in `pre` state (no handshake yet) per I-007-1", async () => {
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
    // No handshake — state is `pre`. Read passes.
    const result = await gated.dispatch("math.read", {}, ctx);
    expect(result).toStrictEqual({ ok: true });
  });

  it("mutating methods are refused in `pre` state with `protocol.handshake_required` (I-007-1)", async () => {
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
    // Compatible handshake.
    const params: DaemonHello = {
      protocolVersion: "2026-05-01",
      supportedProtocols: ["2026-05-01"],
    };
    const ack = (await gated.dispatch(DAEMON_HELLO_METHOD, params, ctx)) as DaemonHelloAck;
    expect(ack.compatible).toBe(true);
    // Mutating call now passes.
    const result = await gated.dispatch("math.write", {}, ctx);
    expect(result).toStrictEqual({ ok: true });
  });

  it("after INCOMPATIBLE handshake, read methods still pass + mutating methods refused (Spec-007:67-68)", async () => {
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
    // Incompatible handshake (ceiling exceeded).
    const params: DaemonHello = {
      protocolVersion: "2026-06-01",
      supportedProtocols: ["2026-06-01", "2026-07-01"],
    };
    const ack = (await gated.dispatch(DAEMON_HELLO_METHOD, params, ctx)) as DaemonHelloAck;
    expect(ack.compatible).toBe(false);
    // Read still passes (Spec-007:67-68).
    const readResult = await gated.dispatch("math.read", {}, ctx);
    expect(readResult).toStrictEqual({ ok: true });
    // Mutating refused with `protocol.version_mismatch`.
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
    // No handshake — but the method is unregistered. The gate must
    // pass through to the inner dispatch so the canonical -32601 path
    // surfaces (per protocol-negotiation.ts:407-414 — refusing here
    // would mask the not-found error as a version-mismatch error).
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
    // No handshake — but daemon.hello itself must be callable; if it
    // were classified mutating, the connection could never escape
    // pre-handshake.
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
    // No transportId in ctx — direct dispatch path. The gate's
    // contract is "enforce over the wire boundary, not over direct
    // dispatch" (the "no wire boundary" early return).
    const result = await gated.dispatch("math.write", {}, {});
    expect(result).toStrictEqual({ ok: true });
  });
});

// `presence.read` JSON-RPC handler test suite.
//
// `presence.read` answers the devices connected to this machine. This suite
// exercises the handler's registry-binding boundary: round-trip through
// `MethodRegistry.dispatch`, the correct `mutating` flag, and
// schema-validates-before-dispatch (a request that names a session is refused).
//
// Invariants verified:
//   * Duplicate `registerPresenceRead` throws
//     `RegistryRegistrationError("duplicate_method")` at register-time.
//   * Schema-validates-before-dispatch: a malformed `presence.read` payload
//     short-circuits at the registry's `safeParse(params)` step and the
//     handler closure is NEVER invoked (verified via spy call count).
//
// Test-fixture posture (mirrors session-handlers.test.ts):
//   The round-trip + mutating arms register against the REAL contract schemas
//   (`PresenceReadRequestSchema` / `MachinePresenceSchema`) because the
//   registry's `safeParse` machinery delegates to each schema's native runtime
//   `safeParse`. The runtime-daemon does NOT depend on zod; the contract
//   schemas already implement the duck-typed interface.

import { describe, expect, it, vi } from "vitest";

import type { HandlerContext, MachinePresence, SessionId } from "@ai-sidekicks/contracts";

import {
  MethodRegistryImpl,
  RegistryDispatchError,
  RegistryRegistrationError,
} from "../../registry.js";

import { registerPresenceRead, type PresenceReadDeps } from "../presence-read.js";

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------
//
// Static literal UUIDs chosen for human-readable failure output; their byte
// values are otherwise meaningless beyond passing the branded-UUID parse.

const TEST_SESSION_ID = "550e8400-e29b-41d4-a716-446655440000" as SessionId;
const TEST_DEVICE_ID = "660e8400-e29b-41d4-a716-446655440001";

/**
 * Build a canonical-shape `MachinePresence` matching every required field
 * on `MachinePresenceSchema`. The mock `readPresence` returns this
 * verbatim so the registry's step-4 `safeParse(result)` succeeds and the
 * dispatched value reaches the test assertion intact.
 */
function buildMachinePresence(): MachinePresence {
  return {
    devices: [
      {
        deviceId: TEST_DEVICE_ID,
        deviceType: "desktop",
        appVisible: true,
        state: "online",
      },
    ],
  };
}

// ----------------------------------------------------------------------------
// Round-trip through MethodRegistry dispatch + mutating flag
// ----------------------------------------------------------------------------

describe("presence.read — round-trip through MethodRegistry dispatch", () => {
  it("dispatches `presence.read` to the deps' readPresence; returns the canonical response shape", async () => {
    const registry = new MethodRegistryImpl();
    const expectedResponse = buildMachinePresence();
    const mockReadPresence = vi.fn<() => Promise<MachinePresence>>(async () => expectedResponse);
    const deps: PresenceReadDeps = { readPresence: mockReadPresence };
    registerPresenceRead(registry, deps);

    const directCtx: HandlerContext = {};
    const result = await registry.dispatch("presence.read", {}, directCtx);

    expect(mockReadPresence).toHaveBeenCalledTimes(1);

    // The dispatched result equals the deps' return value verbatim (the
    // registry's step-4 `safeParse(result)` re-parses but does not mutate).
    expect(result).toStrictEqual(expectedResponse);
  });

  it("returns an empty projection unchanged — no reachable device is a valid answer, not an error", async () => {
    const registry = new MethodRegistryImpl();
    const noLiveDevices: MachinePresence = { devices: [] };
    const deps: PresenceReadDeps = { readPresence: async () => noLiveDevices };
    registerPresenceRead(registry, deps);

    const result = await registry.dispatch("presence.read", {}, {});
    expect(result).toStrictEqual(noLiveDevices);
  });

  it("registers `presence.read` with mutating: false (read-only; pre-handshake gate lets it through)", () => {
    // Sanity check — the slice contract names mutating: false. The
    // negotiation gate predicate is `isMutating(method) === true`, so
    // flipping this flag would wrongly refuse `presence.read` in a
    // `done-incompatible` negotiation state.
    const registry = new MethodRegistryImpl();
    const deps: PresenceReadDeps = { readPresence: async () => buildMachinePresence() };
    registerPresenceRead(registry, deps);
    expect(registry.isMutating("presence.read")).toBe(false);
  });
});

// ----------------------------------------------------------------------------
// Schema-validates-before-dispatch (the handler NEVER runs on a malformed
// payload)
// ----------------------------------------------------------------------------

describe("presence.read — schema-validates-before-dispatch", () => {
  it("a request that names a session rejects with `RegistryDispatchError(invalid_params)`; handler is NEVER invoked", async () => {
    const registry = new MethodRegistryImpl();
    const mockReadPresence = vi.fn<() => Promise<MachinePresence>>(async () =>
      buildMachinePresence(),
    );
    const deps: PresenceReadDeps = { readPresence: mockReadPresence };
    registerPresenceRead(registry, deps);

    // Presence is the machine's: `PresenceReadRequestSchema` is the empty strict
    // object, so a `sessionId` is an unknown key and fails the registry's
    // `safeParse` before the handler runs.
    let caught: unknown = null;
    try {
      await registry.dispatch("presence.read", { sessionId: TEST_SESSION_ID }, {});
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(RegistryDispatchError);
    if (caught instanceof RegistryDispatchError) {
      expect(caught.registryCode).toBe("invalid_params");
      expect(caught.issues).toBeDefined();
      expect((caught.issues ?? []).length).toBeGreaterThan(0);
    }

    // THE CRITICAL ASSERTION — the handler closure must NEVER have run. A
    // regression that moved the schema check after handler invocation would
    // fail this assertion.
    expect(mockReadPresence).not.toHaveBeenCalled();
  });
});

// ----------------------------------------------------------------------------
// Duplicate registration rejected at register-time
// ----------------------------------------------------------------------------

describe("presence.read — duplicate registration rejected at register-time", () => {
  it("calling registerPresenceRead twice on the same registry throws `RegistryRegistrationError(duplicate_method)`", () => {
    const registry = new MethodRegistryImpl();
    const deps: PresenceReadDeps = { readPresence: async () => buildMachinePresence() };
    registerPresenceRead(registry, deps);

    let caught: unknown = null;
    try {
      registerPresenceRead(registry, deps);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RegistryRegistrationError);
    if (caught instanceof RegistryRegistrationError) {
      expect(caught.registryCode).toBe("duplicate_method");
    }
  });
});

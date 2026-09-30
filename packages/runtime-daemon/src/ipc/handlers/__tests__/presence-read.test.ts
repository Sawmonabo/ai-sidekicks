// `presence.read` through the method registry: the round trip, the `mutating` flag, a request
// that names a session is refused before the handler runs, and a second registration throws.
// The suite registers against the real contract schemas, so the registry's `safeParse` calls
// run on them.

import { describe, expect, it, vi } from "vitest";

import type { HandlerContext, MachinePresence, SessionId } from "@ai-sidekicks/contracts";

import {
  MethodRegistryImpl,
  RegistryDispatchError,
  RegistryRegistrationError,
} from "../../registry.js";

import { registerPresenceRead, type PresenceReadDeps } from "../presence-read.js";

// Fixed UUIDs, so a failure prints the same ids every run.

const TEST_SESSION_ID = "550e8400-e29b-41d4-a716-446655440000" as SessionId;
const TEST_DEVICE_ID = "660e8400-e29b-41d4-a716-446655440001";

/** A `MachinePresence` with every required field, so the registry accepts the handler's result. */
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

    // The registry re-parses the result but does not change it.
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
    // The version-mismatch gate refuses only methods that `isMutating` reports as true, so a
    // mutating `presence.read` would be refused after an incompatible handshake.
    const registry = new MethodRegistryImpl();
    const deps: PresenceReadDeps = { readPresence: async () => buildMachinePresence() };
    registerPresenceRead(registry, deps);
    expect(registry.isMutating("presence.read")).toBe(false);
  });
});

describe("presence.read — schema-validates-before-dispatch", () => {
  it("a request that names a session rejects with `RegistryDispatchError(invalid_params)`; handler is NEVER invoked", async () => {
    const registry = new MethodRegistryImpl();
    const mockReadPresence = vi.fn<() => Promise<MachinePresence>>(async () =>
      buildMachinePresence(),
    );
    const deps: PresenceReadDeps = { readPresence: mockReadPresence };
    registerPresenceRead(registry, deps);

    // Presence belongs to the machine: the request schema is an empty strict object, so a
    // `sessionId` is an unknown key and fails validation before the handler runs.
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

    // Validation must come before the handler; a check moved after it would fail here.
    expect(mockReadPresence).not.toHaveBeenCalled();
  });
});

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

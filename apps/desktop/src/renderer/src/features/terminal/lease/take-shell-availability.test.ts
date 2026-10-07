// When the lease line draws no take control. A control drawn before the app knows
// which device is asking would produce a take it cannot recognize as its own.

import { describe, expect, it } from "vitest";

import { resolveTakeShellAvailability } from "./take-shell-availability.js";
import type { TerminalLeaseHolder } from "./state.js";
import type { TerminalDeviceIdentity } from "./hooks/useTerminalDeviceIdentity.js";
import { THIS_DEVICE_ID } from "./state.test-support.js";

const IDENTITY_READ: TerminalDeviceIdentity = { status: "read", deviceId: THIS_DEVICE_ID };

function resolve(holder: TerminalLeaseHolder, deviceIdentity: TerminalDeviceIdentity) {
  return resolveTakeShellAvailability({ holder, deviceIdentity });
}

describe("the take control is absent", () => {
  it("offers nothing to the device that already holds the shell", () => {
    expect(resolve("held-by-this-device", IDENTITY_READ)).toStrictEqual({ control: "none" });
  });

  it("offers nothing while a run holds the shell, which only stopping the run ends", () => {
    expect(resolve("held-by-run", IDENTITY_READ)).toStrictEqual({ control: "none" });
  });

  it("offers nothing while nobody holds the shell, which the first keystroke takes", () => {
    expect(resolve("unheld", IDENTITY_READ)).toStrictEqual({ control: "none" });
  });
});

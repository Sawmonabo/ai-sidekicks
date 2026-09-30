// Which control the lease line may draw, per holding and identity reading. A control drawn
// before the console knows which device is asking would produce a take it cannot recognize
// as its own.

import { describe, expect, it } from "vitest";

import { resolveTakeShellAvailability } from "./take-shell-availability.js";
import type { TerminalLeaseHolder } from "./lease-model.js";
import type { TerminalDeviceIdentity } from "./hooks/useTerminalDeviceIdentity.js";
import { THIS_DEVICE_ID } from "./lease-model.test-support.js";

const IDENTITY_READ: TerminalDeviceIdentity = { status: "read", userId: THIS_DEVICE_ID };

function resolve(holding: TerminalLeaseHolder, deviceIdentity: TerminalDeviceIdentity) {
  return resolveTakeShellAvailability({ holding, deviceIdentity });
}

describe("the acquisition control is offered on the identity alone", () => {
  it("offers it to any device that knows which device it is", () => {
    // No entitlement axis: the shell belongs to the one person using this machine.
    expect(resolve("unheld", IDENTITY_READ)).toStrictEqual({ control: "acquire" });
    expect(resolve("held-by-another-device", IDENTITY_READ)).toStrictEqual({ control: "acquire" });
    expect(resolve("not-checked", IDENTITY_READ)).toStrictEqual({ control: "acquire" });
  });

  it("offers nothing while the identity read is still out", () => {
    expect(resolve("unheld", { status: "not-loaded" })).toStrictEqual({ control: "none" });
  });

  it("offers nothing to the device that already holds the shell", () => {
    expect(resolve("held-by-this-device", IDENTITY_READ)).toStrictEqual({ control: "none" });
  });

  it("offers nothing while a run holds the shell, which only stopping the run ends", () => {
    expect(resolve("held-by-run", IDENTITY_READ)).toStrictEqual({ control: "none" });
  });
});

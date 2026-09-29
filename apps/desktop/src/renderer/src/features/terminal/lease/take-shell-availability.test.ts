// Which control the lease line may draw.
//
// The failure this fold prevents is the quiet kind: a control rendered before the
// console knows which device is asking, so a take comes back as a hold the lease line
// cannot recognize as its own. Every case below is one identity reading, one holding, and
// the single control the lease line may draw.

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
    // No entitlement axis, and that is the design: the shell belongs to the one person
    // using this machine, so there is nothing to ask permission of.
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
});

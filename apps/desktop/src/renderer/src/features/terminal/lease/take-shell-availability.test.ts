// Which control the lease surface may draw.
//
// The defect this fold replaces is the quiet kind: the control rendered before the
// console knew which device was asking, so a take came back as a hold the surface could
// not recognize as its own. Every case below is one identity reading, one holding, and the single
// control the surface may draw.

import { describe, expect, it } from "vitest";

import { resolveTerminalClaimAffordance } from "./take-shell-availability.js";
import type { TerminalLeaseHolding } from "./lease-model.js";
import type { TerminalViewerIdentity } from "./hooks/useTerminalDeviceIdentity.js";
import { VIEWER_USER } from "./lease-model.test-support.js";

const IDENTITY_READ: TerminalViewerIdentity = { status: "read", userId: VIEWER_USER };

function resolve(holding: TerminalLeaseHolding, viewerIdentity: TerminalViewerIdentity) {
  return resolveTerminalClaimAffordance({ holding, viewerIdentity });
}

describe("the acquisition control is offered on the identity alone", () => {
  it("offers it to any device that knows which device it is", () => {
    // No entitlement axis, and that is the design: the shell belongs to the one person
    // using this machine, so there is nothing to ask permission of.
    expect(resolve("unheld", IDENTITY_READ)).toStrictEqual({ control: "acquire" });
    expect(resolve("held-by-another", IDENTITY_READ)).toStrictEqual({ control: "acquire" });
    expect(resolve("not-checked", IDENTITY_READ)).toStrictEqual({ control: "acquire" });
  });

  it("offers nothing while the identity read is still out", () => {
    expect(resolve("unheld", { status: "not-loaded" })).toStrictEqual({ control: "none" });
  });

  it("offers nothing to the device that already holds the shell", () => {
    expect(resolve("held-by-you", IDENTITY_READ)).toStrictEqual({ control: "none" });
  });
});

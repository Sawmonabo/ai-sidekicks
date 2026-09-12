// Which control the lease surface may draw, and what stands where it may not.
//
// The defect this fold replaces is the quiet kind: the control rendered before the
// console knew which window was asking, so a take came back as a hold the surface could
// not recognise as its own — the button still read Claim and there was no way to
// release. Every case below is one identity reading, one holding, and the single
// control the surface may draw.

import { describe, expect, it } from "vitest";

import { refuse, type ConsoleRefusal } from "../../core/index.js";
import { resolveTerminalClaimAffordance } from "./lease-acquisition.js";
import type { TerminalLeaseHolding } from "./lease-model.js";
import type { TerminalViewerIdentity } from "./viewer-identity.js";
import { VIEWER_PARTICIPANT } from "./lease-model.test-support.js";

const IDENTITY_READ: TerminalViewerIdentity = { status: "read", participantId: VIEWER_PARTICIPANT };
const READ_REFUSAL: ConsoleRefusal = refuse("terminal-viewer-identity", "wire-unregistered", "No.");

function resolve(holding: TerminalLeaseHolding, viewerIdentity: TerminalViewerIdentity) {
  return resolveTerminalClaimAffordance({ holding, viewerIdentity });
}

describe("the acquisition control is offered on the identity alone", () => {
  it("offers it to any window that knows which window it is", () => {
    // No entitlement axis, and that is the design: the shell belongs to the one person
    // using this machine, so there is nothing to ask permission of.
    expect(resolve("unheld", IDENTITY_READ)).toStrictEqual({ control: "acquire" });
    expect(resolve("held-by-another", IDENTITY_READ)).toStrictEqual({ control: "acquire" });
    expect(resolve("not-checked", IDENTITY_READ)).toStrictEqual({ control: "acquire" });
  });

  it("withholds it while the identity read is still out", () => {
    expect(resolve("unheld", { status: "not-loaded" })).toStrictEqual({
      control: "none",
      withheld: { reason: "identity-not-read" },
    });
  });

  it("withholds it when the identity read was refused, carrying the wire's own refusal", () => {
    expect(resolve("unheld", { status: "refused", refusal: READ_REFUSAL })).toStrictEqual({
      control: "none",
      withheld: { reason: "identity-refused", refusal: READ_REFUSAL },
    });
  });
});

describe("release is not gated at all", () => {
  it("keeps the handback whatever the identity read says", () => {
    // A window that holds the shell holds it until a transition says otherwise, and
    // taking the release control away in any interval strands the keyboard with no way
    // to hand it back.
    expect(resolve("held-by-you", IDENTITY_READ)).toStrictEqual({ control: "release" });
    expect(resolve("held-by-you", { status: "not-loaded" })).toStrictEqual({ control: "release" });
    expect(resolve("held-by-you", { status: "refused", refusal: READ_REFUSAL })).toStrictEqual({
      control: "release",
    });
  });

  it("negative control: a holding that is not this window's is not a release", () => {
    // Without it every case above would pass against a fold that answered `release`
    // for everything, which offers a handback for a shell this window does not hold.
    expect(resolve("held-by-another", IDENTITY_READ)).toStrictEqual({ control: "acquire" });
  });
});

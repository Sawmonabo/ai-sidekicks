// The claim control, from the surface's side: one press is one acquire, the control is
// disabled while a call is out, and a served call moves no holder. The hook that makes
// a rebound pane get its own control is `lease-claim.test.tsx`.

import { fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { claimControl, leaseState, renderLease } from "./LeaseLine.test-support.js";
import { OTHER_USER } from "../lease-model.test-support.js";

describe("the claim control", () => {
  it("makes one acquire per press", () => {
    const acquire = vi.fn();
    const { container } = renderLease(leaseState({ holding: "unheld" }), {
      isInFlight: false,
      acquire,
    });
    fireEvent.click(claimControl(container));
    expect(acquire).toHaveBeenCalledTimes(1);
  });

  it("is disabled while a call is out", () => {
    const { container } = renderLease(leaseState({ holding: "unheld" }), {
      isInFlight: true,
      acquire: vi.fn(),
    });
    expect(claimControl(container).disabled).toBe(true);
  });

  it("never moves the holder on a press — the holder is the wire's field", () => {
    const { container } = renderLease(leaseState({ holding: "unheld" }));
    fireEvent.click(claimControl(container));
    // The holder moves when a `pty.control_changed` transition reaches the fold, not here.
    expect(container.textContent).toContain("Nobody holds the shell.");
    expect(container.textContent).toContain("Free");
  });

  it("negative control: a hold this window does not have calls acquire", () => {
    const acquire = vi.fn();
    const { container } = renderLease(
      leaseState({ holding: "held-by-another", holderUserId: OTHER_USER }),
      { isInFlight: false, acquire },
    );
    fireEvent.click(claimControl(container));
    expect(acquire).toHaveBeenCalledTimes(1);
  });
});

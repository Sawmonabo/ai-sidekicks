// The take control, from the surface's side: one press is one acquire, the control is
// disabled while a call is out, and a served call moves no holder. The hook that makes
// a rebound pane get its own control is `useTakeShell.test.tsx`.

import { fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { takeShellButton, leaseState, renderLease } from "./LeaseLine.test-support.js";
import { OTHER_DEVICE_ID } from "../lease-model.test-support.js";

describe("the take control", () => {
  it("makes one acquire per press", () => {
    const take = vi.fn();
    const { container } = renderLease(leaseState({ holding: "unheld" }), {
      isInFlight: false,
      take,
    });
    fireEvent.click(takeShellButton(container));
    expect(take).toHaveBeenCalledTimes(1);
  });

  it("is disabled while a call is out", () => {
    const { container } = renderLease(leaseState({ holding: "unheld" }), {
      isInFlight: true,
      take: vi.fn(),
    });
    expect(takeShellButton(container).disabled).toBe(true);
  });

  it("never moves the holder on a press — the holder is the wire's field", () => {
    const { container } = renderLease(leaseState({ holding: "unheld" }));
    fireEvent.click(takeShellButton(container));
    // The holder moves when a `pty.control_changed` transition reaches the fold, not here.
    expect(container.textContent).toContain("Nobody holds the shell.");
    expect(container.textContent).toContain("Free");
  });

  it("negative control: a hold this device does not have calls acquire", () => {
    const take = vi.fn();
    const { container } = renderLease(
      leaseState({ holding: "held-by-another-device", holderUserId: OTHER_DEVICE_ID }),
      { isInFlight: false, take },
    );
    fireEvent.click(takeShellButton(container));
    expect(take).toHaveBeenCalledTimes(1);
  });
});

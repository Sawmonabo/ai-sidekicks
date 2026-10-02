// The take control, from the lease line's side: one press is one acquire.

import { fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { takeShellButton, leaseState, renderLease } from "./LeaseLine.test-support.js";

describe("the take control", () => {
  it("makes one acquire per press", () => {
    const take = vi.fn();
    const { container } = renderLease(leaseState({ holder: "unheld" }), {
      isInFlight: false,
      take,
    });
    fireEvent.click(takeShellButton(container));
    expect(take).toHaveBeenCalledTimes(1);
  });
});

// The holding line in the one state the design draws with no way to take the shell: a running
// command holds it, and no device can take it from the command.

import { describe, expect, it } from "vitest";

import { leaseState, renderLease } from "./LeaseLine.test-support.js";
import { COMMAND_ID, RUN_ID, THIS_DEVICE_ID } from "../lease-model.test-support.js";

describe("the holding line — a running command holds the shell", () => {
  it("says the command holds it, offers no take, and never tells this device it may type", () => {
    const { container } = renderLease(
      leaseState({
        holding: "held-by-run",
        holderDeviceId: THIS_DEVICE_ID,
        holderRunId: RUN_ID,
        holderCommandId: COMMAND_ID,
      }),
    );
    expect(container.textContent).toContain("Running command holds the shell.");
    expect(container.querySelector(".meridian-lease-line__take")).toBeNull();
    // The run's machine is the holding device, and that may be this one; the line still never
    // tells it that it may type.
    expect(container.textContent).not.toContain("You may type into the shared shell.");
  });
});

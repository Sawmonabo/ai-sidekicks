// The holder line in the one state the design draws with no way to take the shell: a running
// command holds it, and no device can take it from the command.

import { describe, expect, it } from "vitest";

import { leaseState, renderLease } from "./LeaseLine.test-support.js";
import { COMMAND_ID, RUN_ID, THIS_DEVICE_ID } from "../lease-model.test-support.js";

describe("the holder line — a running command holds the shell", () => {
  it("says the command holds it and offers no take, even on the run's own device", () => {
    const { container } = renderLease(
      leaseState({
        holder: "held-by-run",
        holderDeviceId: THIS_DEVICE_ID,
        holderRunId: RUN_ID,
        holderCommandId: COMMAND_ID,
      }),
    );
    // The run's machine is the holding device, and that may be this one; the line still draws
    // the run's hold rather than nothing.
    expect(container.textContent).toMatch(/running command holds the shell\./i);
    expect(container.querySelector(".meridian-lease-line__take")).toBeNull();
  });
});

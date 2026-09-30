// The take control is gated on knowing which device this is.
//
// The last of the line's prohibitions, and its own file because it is the one that
// withholds the control entirely: the control acts on this device's behalf and the fold
// names the holder by user id, so until that identity has been READ there is no
// control here at all, and no sentence standing where it would be. A control offered
// without it is one the daemon will honor and this line will then report as a hold
// from somewhere else.
//
// Nothing else gates it. The shell belongs to the one person using this machine.

import { describe, expect, it } from "vitest";

import { IDLE_TAKE, leaseState, renderLease } from "./LeaseLine.test-support.js";
import { OTHER_DEVICE_ID } from "../lease-model.test-support.js";

describe("the take control is gated on knowing which device this is", () => {
  /** The take control, or `null` — the shape the withheld cases need. */
  function offeredTakeControl(container: HTMLElement): Element | null {
    return container.querySelector(".meridian-lease-line__take");
  }

  const HELD_BY_SOMEBODY = leaseState({
    holding: "held-by-another-device",
    holderDeviceId: OTHER_DEVICE_ID,
  });

  it("offers no control while the identity read is still out", () => {
    const { container } = renderLease(HELD_BY_SOMEBODY, IDLE_TAKE, {
      status: "not-loaded",
    });
    expect(offeredTakeControl(container)).toBeNull();
  });

  it("negative control: a read identity DOES get the control", () => {
    // Without this the withheld case would pass against a line that had simply
    // stopped rendering the take control at all.
    const { container } = renderLease(HELD_BY_SOMEBODY);
    expect(offeredTakeControl(container)?.textContent).toBe("Take the shell");
  });
});

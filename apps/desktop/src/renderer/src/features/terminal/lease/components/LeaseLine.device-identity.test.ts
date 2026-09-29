// The claim control is gated on knowing which device this is.
//
// The last of the line's prohibitions, and its own file because it is the one that
// withholds the control entirely: the surface acts on this device's behalf and the fold
// names the holder by user id, so until that identity has been READ there is no
// control here at all, and no sentence standing where it would be. A control offered
// without it is one the daemon will honor and this line will then report as a hold
// from somewhere else.
//
// Nothing else gates it. The shell belongs to the one person using this machine.

import { describe, expect, it } from "vitest";

import { IDLE_CLAIM, leaseState, renderLease } from "./LeaseLine.test-support.js";
import { OTHER_DEVICE_ID } from "../lease-model.test-support.js";

describe("the claim control is gated on knowing which device this is", () => {
  /** The claim control, or `null` — the shape the withheld cases need. */
  function offeredClaimControl(container: HTMLElement): Element | null {
    return container.querySelector(".meridian-lease-line__claim");
  }

  const HELD_BY_SOMEBODY = leaseState({
    holding: "held-by-another-device",
    holderUserId: OTHER_DEVICE_ID,
    transitionCount: 1,
  });

  it("offers no control while the identity read is still out", () => {
    const { container } = renderLease(HELD_BY_SOMEBODY, IDLE_CLAIM, {
      status: "not-loaded",
    });
    expect(offeredClaimControl(container)).toBeNull();
  });

  it("negative control: a read identity DOES get the control", () => {
    // Without this the withheld case would pass against a line that had simply
    // stopped rendering the claim control at all.
    const { container } = renderLease(HELD_BY_SOMEBODY);
    expect(offeredClaimControl(container)?.textContent).toBe("Take the shell");
  });
});

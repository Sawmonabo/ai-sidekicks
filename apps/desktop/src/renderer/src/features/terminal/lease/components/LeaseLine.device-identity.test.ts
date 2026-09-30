// The take control is gated on knowing which device this is. The control acts on this device's
// behalf and the fold names holders by user id, so until the identity has been read there is no
// control and no sentence where it would be: offered without it, the daemon would honor a take
// that the line then reports as a hold from elsewhere. Nothing else gates it, because the
// shell belongs to one person.

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

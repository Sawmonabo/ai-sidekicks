// No capability answer stands for the window's life. Two features gate controls on
// `driver.listCapabilities`, and a latched read would let one transient refusal hide Steer, Rewind
// and the compaction popover. Calls are counted on a bridge that records them, on a frozen clock
// advanced explicitly.

import { describe, expect, it } from "vitest";
import { act, render } from "@testing-library/react";

import { settleScheduledRead } from "@test/helpers/scheduled-read.js";
import { bridgeWrapper } from "@test/helpers/app-frame-fixtures.js";
import {
  CapabilityProbe,
  answeringCapabilityReads,
  capabilityCallCount,
  reportFor,
} from "./useDriverCapabilities.test-support.js";
import {
  neverRead,
  settledRefusalOf,
} from "@renderer/store/driver-capabilities/driver-capability-readout.test-support.js";
import { type DriverCapabilityReadout } from "@renderer/store/driver-capabilities/driver-capability-readout.js";
import { declaredFlagsForDriver } from "@renderer/store/driver-capabilities/driver-capability-readings.js";

describe("useDriverCapabilities — a settlement is never terminal", () => {
  it("settles a reply that does not parse fail-closed, then re-reads on window focus", async () => {
    // The first read is refused and the second answers: a daemon not ready when the window opened.
    const counted = answeringCapabilityReads(
      { drivers: [{ driverName: "claude" }] },
      { drivers: [reportFor("claude", ["steer", "rollback"])] },
    );
    let readout: DriverCapabilityReadout | undefined = neverRead();
    await act(async () => {
      render(
        <CapabilityProbe
          bridge={counted.bridge}
          onReadout={(value) => {
            readout = value;
          }}
        />,
        { wrapper: bridgeWrapper(counted.bridge, counted.clock) },
      );
    });
    await settleScheduledRead(counted.clock);

    // Gating stays fail-closed and the reason is on the reading so a view can say why.
    expect(declaredFlagsForDriver(readout, "claude")).toBeUndefined();
    expect(settledRefusalOf(readout).code).toBe("reply-unreadable");
    expect(capabilityCallCount(counted)).toBe(1);

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await settleScheduledRead(counted.clock);

    expect(capabilityCallCount(counted)).toBe(2);
    expect(declaredFlagsForDriver(readout, "claude")?.steer).toBe(true);
    expect(readout?.readRefusal).toBeUndefined();
  });
});

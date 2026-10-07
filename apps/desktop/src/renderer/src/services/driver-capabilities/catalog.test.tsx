// The catalog read takes its capability report from the bridge's one capability reading, so the
// pickers and a view gating on the flags never cost two `driver.listCapabilities` calls, and a
// refused reading fails the catalog with the daemon's own code.

import { describe, expect, it } from "vitest";
import { act, render } from "@testing-library/react";
import { SessionIdSchema } from "@ai-sidekicks/contracts/session/id";

import { settleScheduledRead } from "#test/helpers/scheduled-read.js";
import { bridgeWrapper } from "#test/helpers/app/frame-fixtures.js";
import { declaredFlagsForDriver } from "#renderer/store/driver-capabilities/readings.js";
import { type DriverCapabilityReadout } from "#renderer/store/driver-capabilities/readout.js";
import { neverRead } from "#renderer/store/driver-capabilities/readout.test-support.js";
import {
  CapabilityProbe,
  answeringCapabilityReads,
  capabilityCallCount,
  reportFor,
} from "./hooks/useDriverCapabilities.test-support.js";
import { createDriverCatalogRead } from "./catalog.js";

const SESSION_ID = SessionIdSchema.parse("019b7892-1a00-7c31-8110-cca0117a0a01");

describe("createDriverCatalogRead — the capability report comes from the shared reading", () => {
  it("settles beside a mounted capability view on one call and carries the served report", async () => {
    const servedReport = { drivers: [reportFor("claude", ["steer"])] };
    const counted = answeringCapabilityReads(servedReport);
    let readout: DriverCapabilityReadout | undefined = neverRead();
    const catalogRead = createDriverCatalogRead(counted.bridge, counted.clock, SESSION_ID);
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
    // Started after the view's mount effect, so the view's read is on the wire when the catalog
    // asks: the catalog must take that answer rather than queue a second call behind it.
    catalogRead.start();
    await settleScheduledRead(counted.clock);
    // A second window lets a read queued behind the view's one reach the wire.
    await settleScheduledRead(counted.clock);

    expect(capabilityCallCount(counted)).toBe(1);
    expect(declaredFlagsForDriver(readout, "claude")?.steer).toBe(true);
    const { state } = catalogRead;
    if (state.kind !== "loaded") {
      throw new Error(`the catalog read settled ${state.kind}, not loaded`);
    }
    expect(state.value.capabilities).toEqual(servedReport);
    expect(state.value.models.drivers.map((report) => report.driverName)).toEqual(["claude"]);
  });

  it("fails with the daemon's refusal code when the capability reading is refused", async () => {
    // A report missing its flags does not parse, so the reading settles refused.
    const counted = answeringCapabilityReads({ drivers: [{ driverName: "claude" }] });
    const catalogRead = createDriverCatalogRead(counted.bridge, counted.clock, SESSION_ID);
    catalogRead.start();
    await settleScheduledRead(counted.clock);

    expect(capabilityCallCount(counted)).toBe(1);
    const { state } = catalogRead;
    if (state.kind !== "failed") {
      throw new Error(`the catalog read settled ${state.kind}, not failed`);
    }
    expect(state.refusal.code).toBe("reply-unreadable");
  });
});

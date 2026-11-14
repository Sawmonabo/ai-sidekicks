// A row whose agent stopped renewing its activity must stop saying it is working once the lapse
// passes, or the person waits on work no one is doing; a renewal before the lapse keeps it working.

import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SESSION_ACTIVITY_STALE_AFTER_MS } from "@ai-sidekicks/contracts/session/directory";
import { ManualClock } from "#renderer/lib/clock.js";
import { PlatformBridgeProvider } from "#renderer/services/platform/PlatformBridgeProvider.js";
import { bridgeOnClock } from "#test/helpers/fixture/bridge.js";
import type { SessionListRow } from "../rows/list-row.js";
import { NO_PINS } from "../rows/pins.js";
import { SessionList } from "./SessionList.js";

/** `2026-10-06T12:00:00.000Z`, the first renewal, in epoch milliseconds. */
const FIRST_RENEWAL_MS = 1_791_288_000_000;

/** A renewal thirty seconds after the first, before the first one lapses. */
const SECOND_RENEWAL_ISO = "2026-10-06T12:00:30.000Z";
const SECOND_RENEWAL_MS = FIRST_RENEWAL_MS + 30_000;

function workingRow(activityRenewedAt: string): SessionListRow {
  return {
    sessionId: "session-working",
    name: "Fix the login flow",
    firstMessagePreview: undefined,
    shape: "project",
    state: "active",
    listedActivity: { activity: "running", activityRenewedAt },
    // No age is drawn, so the only timer the list arms is the activity's lapse.
    touchedAtIso: undefined,
    userIds: [],
  };
}

describe("a session row's activity ages on the list's clock", () => {
  it("draws idle once renewals stop, and a renewal before the lapse keeps it working", () => {
    const clock = new ManualClock(FIRST_RENEWAL_MS);
    const bridge = bridgeOnClock("session-list-activity", clock).bridge;
    const mount = (row: SessionListRow): React.JSX.Element => (
      <PlatformBridgeProvider bridge={bridge} clock={clock}>
        <SessionList rows={[row]} pinned={NO_PINS} onOpen={() => undefined} />
      </PlatformBridgeProvider>
    );
    const { rerender } = render(mount(workingRow("2026-10-06T12:00:00.000Z")));
    expect(screen.getByRole("button", { name: "Fix the login flow Working" })).toBeDefined();

    // A renewal arrives before the first lapse: the list arms again for the new one.
    act(() => {
      clock.advance(SECOND_RENEWAL_MS - FIRST_RENEWAL_MS);
    });
    rerender(mount(workingRow(SECOND_RENEWAL_ISO)));
    act(() => {
      clock.advance(FIRST_RENEWAL_MS + SESSION_ACTIVITY_STALE_AFTER_MS + 1 - clock.now());
    });
    expect(screen.getByRole("button", { name: "Fix the login flow Working" })).toBeDefined();
    const pendingWhileWorking = clock.pendingCount;

    // At the stale bound the reading still stands.
    act(() => {
      clock.advance(SECOND_RENEWAL_MS + SESSION_ACTIVITY_STALE_AFTER_MS - clock.now());
    });
    expect(screen.getByRole("button", { name: "Fix the login flow Working" })).toBeDefined();

    // The millisecond after it, with no renewal, the row draws idle and arms nothing more.
    act(() => {
      clock.advance(1);
    });
    expect(screen.getByRole("button", { name: "Fix the login flow Idle" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Fix the login flow Working" })).toBeNull();
    expect(clock.pendingCount).toBe(pendingWhileWorking - 1);
  });
});

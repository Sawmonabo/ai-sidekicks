// Overlapping probes of one machine's permission, and which answer is allowed to show. The
// probes are held by hand; the scheduler keeps a second reason from becoming a concurrent call,
// and the generation latch keeps a settlement that outlived its round from installing.

import { describe, expect, it } from "vitest";

import { ManualClock } from "@renderer/lib/clock.js";
import { REFRESH_MAX_WAIT_MS } from "@renderer/lib/reads/refresh-caps.js";
import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";
import {
  OsNotificationPermissionRead,
  type OsNotificationPermissionState,
} from "./os-notification-permission.js";

interface HeldProbe {
  serve(state: OsNotificationPermissionState): void;
}

interface ProbeHarness {
  readonly read: OsNotificationPermissionRead;
  readonly held: readonly HeldProbe[];
  readonly clock: ManualClock;
}

/** A reading whose permission probe is answered by hand. */
function probeHarness(): ProbeHarness {
  const held: HeldProbe[] = [];
  const clock = new ManualClock();
  const probe = async (): Promise<OsNotificationPermissionState> =>
    await new Promise((resolve) => {
      held.push({ serve: resolve });
    });
  return { read: new OsNotificationPermissionRead({ probe, clock }), held, clock };
}

/** Let the scheduler's window elapse and whatever it fired reach the wire. */
async function performScheduledProbe(harness: ProbeHarness): Promise<void> {
  harness.clock.advance(REFRESH_MAX_WAIT_MS);
  await crossMacrotaskBoundary();
}

/** The state a view would render from the reading as it stands. */
function shownState(read: OsNotificationPermissionRead): OsNotificationPermissionState | undefined {
  const reading = read.snapshot();
  return reading.kind === "read" ? reading.state : undefined;
}

/** One held probe, by position. Throws rather than reading past the end. */
function probeAt(harness: ProbeHarness, index: number): HeldProbe {
  const probe = harness.held[index];
  if (probe === undefined) {
    throw new Error(`no permission probe was dispatched at position ${String(index)}`);
  }
  return probe;
}

describe("the OS permission probe — a stale answer never overwrites a fresh one", () => {
  it("collapses the burst a returning window raises into one probe", () => {
    // Mount, focus and reconnect all reach `requestRead`; the scheduler must keep them from
    // being three concurrent probes.
    const harness = probeHarness();
    harness.read.requestRead("subscribe");
    harness.read.requestRead("window-focus");
    harness.read.requestRead("reconnect");
    expect(harness.held).toHaveLength(0);
  });

  it("puts no second probe on the wire while one is still outstanding", async () => {
    // Two concurrent probes let an older `denied` answer after a newer `granted`. Returning
    // from the OS permission dialog raises a focus, which must become the next probe and not a
    // second concurrent call.
    const harness = probeHarness();
    harness.read.requestRead("subscribe");
    await performScheduledProbe(harness);
    expect(harness.held).toHaveLength(1);

    harness.read.requestRead("window-focus");
    await performScheduledProbe(harness);
    expect(harness.held).toHaveLength(1);
  });

  it("shows the answer taken last when a person grants the permission and comes back", async () => {
    // The machine says `denied` while the window is away, the person grants the permission
    // outside the application, and the returning focus asks again; the reading shown is the one
    // taken last.
    const harness = probeHarness();
    harness.read.requestRead("subscribe");
    await performScheduledProbe(harness);

    harness.read.requestRead("window-focus");
    probeAt(harness, 0).serve("denied");
    await crossMacrotaskBoundary();
    expect(shownState(harness.read)).toBe("denied");

    await performScheduledProbe(harness);
    expect(harness.held).toHaveLength(2);
    probeAt(harness, 1).serve("granted");
    await crossMacrotaskBoundary();

    expect(shownState(harness.read)).toBe("granted");
    expect(shownState(harness.read)).not.toBe("denied");
  });

  it("publishes nothing at all once the view is gone", async () => {
    // A probe still traveling when the view unmounts: `dispose` supersedes every round, so its
    // answer finds no key naming its serial.
    const harness = probeHarness();
    harness.read.requestRead("subscribe");
    await performScheduledProbe(harness);
    harness.read.dispose();

    probeAt(harness, 0).serve("denied");
    await crossMacrotaskBoundary();

    expect(harness.read.snapshot()).toStrictEqual({ kind: "unread" });
  });
});

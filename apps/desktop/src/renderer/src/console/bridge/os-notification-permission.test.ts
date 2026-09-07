// Overlapping probes of one machine's permission, and which answer is allowed to show.
//
// The reading is driven directly rather than through either surface it feeds, for the
// reason its consumers' own suites state: what is under test is which of two calls
// decides the answer, and a rendered surface can only show the outcome after the fact.
// The probes are HELD by hand because a probe is only genuinely outstanding if the case
// decides when it answers, and nothing else makes the overlap observable.
//
// THE DEFECT WAS A TRIP OUT OF THE WINDOW AND BACK. Granting a notification permission
// happens in the operating system, so the mount probe, the focus probe and the
// reconnect probe arrive within moments of each other. Every trigger called the port
// directly and published whatever it got, so an older `denied` landing after a newer
// `granted` put the stale answer back and left it there until some later trigger
// happened to fire. The remedy is two rules and the cases are split along them: the
// scheduler means a second reason never becomes a second concurrent call, and the
// generation latch means a settlement that outlived its round installs nothing.

import { describe, expect, it } from "vitest";

import {
  fixtureBridgeWithGrowth,
  unscriptedScenario,
} from "./fixture/fixture-bridge.test-support.js";
import type { ConsoleBridge } from "./console-bridge.js";
import { ManualClock, REFRESH_MAX_WAIT_MS } from "../core/index.js";
import { crossMacrotaskBoundary } from "../core/macrotask-boundary.test-support.js";
import { OsNotificationPermissionRead } from "./os-notification-permission.js";

const SCENARIO = unscriptedScenario("os-notification-permission-read-test");

/** What one held probe answers, once a case decides it has. */
type PermissionState = "granted" | "denied" | "not-determined";

interface HeldProbe {
  serve(state: PermissionState): void;
  reject(rejection: unknown): void;
}

interface ProbeHarness {
  readonly read: OsNotificationPermissionRead;
  readonly held: readonly HeldProbe[];
  readonly clock: ManualClock;
}

/**
 * A reading over a bridge whose permission probe is answered by hand.
 *
 * The real fixture bridge with the one operation these cases drive overridden, so what
 * they assert is what a release build's port shape produces.
 */
function probeHarness(): ProbeHarness {
  const held: HeldProbe[] = [];
  const clock = new ManualClock();
  const bridge: ConsoleBridge = fixtureBridgeWithGrowth(SCENARIO, {
    shellNotificationPermissionRead: async () =>
      await new Promise((resolve, reject) => {
        held.push({
          serve: (state) => {
            resolve({ status: "served", value: { state } });
          },
          reject,
        });
      }),
  });
  return { read: new OsNotificationPermissionRead({ bridge, clock }), held, clock };
}

/** Let the scheduler's window elapse and whatever it fired reach the wire. */
async function performScheduledProbe(harness: ProbeHarness): Promise<void> {
  harness.clock.advance(REFRESH_MAX_WAIT_MS);
  await crossMacrotaskBoundary();
}

/** The state a surface would render from the reading as it stands. */
function shownState(read: OsNotificationPermissionRead): PermissionState | undefined {
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
    // Mount, focus and reconnect all reach `requestRead`, and the scheduler is what
    // decides what that costs. Without the chokepoint the three would be three probes
    // in flight together, which is the state the ordering defect lives in.
    const harness = probeHarness();
    harness.read.requestRead("subscribe");
    harness.read.requestRead("window-focus");
    harness.read.requestRead("reconnect");
    expect(harness.held).toHaveLength(0);
  });

  it("puts no second probe on the wire while one is still outstanding", async () => {
    // THE DEFECT, at its root. Every trigger used to call the port directly, so the
    // focus a person raises on returning from the operating system's own permission
    // dialog dispatched a probe beside the one the mount had left outstanding — and
    // two concurrent probes are what makes an older `denied` able to answer after a
    // newer `granted`. Through the chokepoint the second reason does not become a
    // second call at all: it becomes the NEXT one.
    const harness = probeHarness();
    harness.read.requestRead("subscribe");
    await performScheduledProbe(harness);
    expect(harness.held).toHaveLength(1);

    harness.read.requestRead("window-focus");
    await performScheduledProbe(harness);
    expect(harness.held).toHaveLength(1);
  });

  it("shows the answer taken last when a person grants the permission and comes back", async () => {
    // The sequence both surfaces exist for, end to end: the machine says `denied`
    // while the window is away, the person grants the permission outside the
    // application, and the focus that brings them back is what asks again. The reading
    // that shows is the one taken LAST, which is the whole ordering claim.
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

  it("says the machine would not answer, rather than staying on the last thing it said", async () => {
    // The rejection arm, and it is the arm that must not be silent: a probe that
    // fails leaves a surface describing a machine nobody has asked since, and
    // silence there reads as `granted` — the one thing this console must not claim
    // on nobody's behalf.
    const harness = probeHarness();
    harness.read.requestRead("subscribe");
    await performScheduledProbe(harness);
    probeAt(harness, 0).serve("granted");
    await crossMacrotaskBoundary();

    harness.read.requestRead("reconnect");
    await performScheduledProbe(harness);
    probeAt(harness, 1).reject(new Error("the host went away"));
    await crossMacrotaskBoundary();

    expect(harness.read.snapshot()).toStrictEqual({ kind: "unavailable" });
  });

  it("publishes nothing at all once the surface is gone", async () => {
    // A probe still travelling when the surface unmounts. `dispose` supersedes every
    // round, so its answer finds no key naming its serial.
    const harness = probeHarness();
    harness.read.requestRead("subscribe");
    await performScheduledProbe(harness);
    harness.read.dispose();

    probeAt(harness, 0).serve("denied");
    await crossMacrotaskBoundary();

    expect(harness.read.snapshot()).toStrictEqual({ kind: "unread" });
  });

  it("negative control: a probe nothing superseded does publish", async () => {
    // Without this the cases above would pass over a reading that published nothing
    // ever, which is a different defect wearing the same green.
    const harness = probeHarness();
    harness.read.requestRead("subscribe");
    await performScheduledProbe(harness);
    probeAt(harness, 0).serve("denied");
    await crossMacrotaskBoundary();

    expect(shownState(harness.read)).toBe("denied");
  });
});

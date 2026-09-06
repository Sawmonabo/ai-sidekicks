// The order, and the two ways it stops early.
//
// 13.16 says the clear closes the pane first. That is one claim with three failure
// modes worth pinning: clearing without closing, clearing after a close that refused,
// and closing a partition that had no pane open. Each case below has the control that
// catches its own mode.

import { describe, expect, it } from "vitest";

import { refuse, type ConsoleRefusal } from "../../core/index.js";
import { servingAct } from "./PartitionClearControl.test-support.js";
import {
  closeThenClearSiteData,
  type ClearSiteDataStep,
  type SiteDataAct,
} from "./site-data-clear.js";

const SESSION_ID = "session-07";

const PANE_HELD_OPEN: ConsoleRefusal = refuse(
  "browser",
  "browser.pane_busy",
  "The pane is mid-navigation and would not close.",
);

const DIRECTORY_LOCKED: ConsoleRefusal = refuse(
  "browser",
  "browser.partition_locked",
  "The profile directory is still held open.",
);

/** An act that records the order it ran in and refuses. */
function refusingAct(callLog: string[], name: string, refusal: ConsoleRefusal): SiteDataAct {
  return (sessionId) => {
    callLog.push(`${name}:${sessionId}`);
    return Promise.resolve({ status: "refused", refusal });
  };
}

describe("closeThenClearSiteData — the order", () => {
  it("closes the pane and only then clears, and says it cleared", async () => {
    const callLog: string[] = [];

    const outcome = await closeThenClearSiteData({
      sessionId: SESSION_ID,
      hasOpenPane: true,
      closePane: servingAct(callLog, "close"),
      clearSiteData: servingAct(callLog, "clear"),
    });

    expect(callLog).toStrictEqual([`close:${SESSION_ID}`, `clear:${SESSION_ID}`]);
    expect(outcome).toStrictEqual({ status: "cleared" });
  });

  it("tells the caller which step is about to run, before it runs it", async () => {
    const steps: ClearSiteDataStep[] = [];
    const callLog: string[] = [];

    await closeThenClearSiteData({
      sessionId: SESSION_ID,
      hasOpenPane: true,
      closePane: servingAct(callLog, "close"),
      clearSiteData: servingAct(callLog, "clear"),
      onStep: (step) => {
        steps.push(step);
      },
    });

    expect(steps).toStrictEqual(["closing-pane", "clearing"]);
  });

  it("negative control: a partition with no open pane is never closed", async () => {
    // Without the `hasOpenPane` guard the sequence would dispatch a close for every
    // partition on the page, which is a pane torn down for a clear that never needed
    // one — and the close act is supplied here precisely so the guard is what stops it.
    const callLog: string[] = [];

    const outcome = await closeThenClearSiteData({
      sessionId: SESSION_ID,
      hasOpenPane: false,
      closePane: servingAct(callLog, "close"),
      clearSiteData: servingAct(callLog, "clear"),
    });

    expect(callLog).toStrictEqual([`clear:${SESSION_ID}`]);
    expect(outcome).toStrictEqual({ status: "cleared" });
  });
});

describe("closeThenClearSiteData — stopping early", () => {
  it("stops at a close that refused, and names that step", async () => {
    const callLog: string[] = [];

    const outcome = await closeThenClearSiteData({
      sessionId: SESSION_ID,
      hasOpenPane: true,
      closePane: refusingAct(callLog, "close", PANE_HELD_OPEN),
      clearSiteData: servingAct(callLog, "clear"),
    });

    expect(outcome).toStrictEqual({
      status: "refused",
      at: "closing-pane",
      refusal: PANE_HELD_OPEN,
    });
    expect(callLog).toStrictEqual([`close:${SESSION_ID}`]);
  });

  it("refuses by name when a pane is open and no close verb is registered", async () => {
    const callLog: string[] = [];

    const outcome = await closeThenClearSiteData({
      sessionId: SESSION_ID,
      hasOpenPane: true,
      closePane: undefined,
      clearSiteData: servingAct(callLog, "clear"),
    });

    expect(outcome.status).toBe("refused");
    expect(outcome).toMatchObject({ at: "closing-pane" });
    expect(outcome.status === "refused" ? outcome.refusal.code : undefined).toBe(
      "pane-close-unregistered",
    );
    expect(callLog).toStrictEqual([]);
  });

  it("carries a clear's own refusal, named at the clearing step", async () => {
    const callLog: string[] = [];

    const outcome = await closeThenClearSiteData({
      sessionId: SESSION_ID,
      hasOpenPane: false,
      closePane: undefined,
      clearSiteData: refusingAct(callLog, "clear", DIRECTORY_LOCKED),
    });

    expect(outcome).toStrictEqual({
      status: "refused",
      at: "clearing",
      refusal: DIRECTORY_LOCKED,
    });
  });

  it("negative control: a refused close does not fall through to the clear", async () => {
    // This is the hazard the ordering exists for. Clearing after a refused close
    // deletes the profile directory of a pane that is still reading it, and an
    // implementation that ignored the first outcome would pass every case above.
    const callLog: string[] = [];

    await closeThenClearSiteData({
      sessionId: SESSION_ID,
      hasOpenPane: true,
      closePane: refusingAct(callLog, "close", PANE_HELD_OPEN),
      clearSiteData: servingAct(callLog, "clear"),
    });

    expect(callLog).not.toContain(`clear:${SESSION_ID}`);
  });
});

// What "Step in" reaches when a deck is mounted, and what it reaches when none is.
//
// The empty arm is the half that fails silently. A run control that awaited a handler
// nobody had registered would either throw inside a settled pause or resolve to
// something indistinguishable from a deck that moved — and the person, who pressed one
// control and got a pause, would be told they had the floor.

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  registerTakeTheFloorHandler,
  takeTheFloor,
  unregisterTakeTheFloorHandler,
  type TakeTheFloorOutcome,
} from "./take-the-floor-seat.js";

const MOVED: TakeTheFloorOutcome = {
  status: "moved",
  composerAddressed: true,
  worktree: "opened",
};

afterEach(() => {
  // The seat is module scope, so a case that filled it would leak into the next one.
  unregisterTakeTheFloorHandler();
});

describe("the floor seat", () => {
  it("hands the request to the mounted deck and answers what it moved", async () => {
    const handle = vi.fn(async () => Promise.resolve(MOVED));
    registerTakeTheFloorHandler("workspace-deck", handle);

    await expect(takeTheFloor({ runId: "run-01" })).resolves.toStrictEqual(MOVED);
    expect(handle).toHaveBeenCalledWith({ runId: "run-01" });
  });

  it("answers no-deck rather than throwing when the seat is empty", async () => {
    await expect(takeTheFloor({ runId: "run-01" })).resolves.toStrictEqual({ status: "no-deck" });
  });

  it("answers no-deck again once the deck that filled it has unmounted", async () => {
    registerTakeTheFloorHandler("workspace-deck", async () => Promise.resolve(MOVED));
    unregisterTakeTheFloorHandler();
    await expect(takeTheFloor({ runId: "run-01" })).resolves.toStrictEqual({ status: "no-deck" });
  });

  it("lets the same owner replace its own handler, and refuses a second owner", async () => {
    // A remount is ordinary and a second family claiming the deck is not: which deck a
    // press moves would otherwise depend on module import order.
    registerTakeTheFloorHandler("workspace-deck", async () => Promise.resolve(MOVED));
    const replacement = vi.fn(async () =>
      Promise.resolve<TakeTheFloorOutcome>({ status: "no-deck" }),
    );
    registerTakeTheFloorHandler("workspace-deck", replacement);
    await takeTheFloor({ runId: "run-01" });
    expect(replacement).toHaveBeenCalledTimes(1);

    expect(() => {
      registerTakeTheFloorHandler("some-other-family", async () => Promise.resolve(MOVED));
    }).toThrow();
  });
});

// The record a row cannot take away, driven with no renderer at all.
//
// Every rule this object carries is a property of an act starting and settling rather
// than of a render happening, so it is drivable directly — and the place two copies of
// a single-flight guard drift is the predicate, which is exactly what these cases pin.

import { describe, expect, it } from "vitest";

import { refuse } from "../core/index.js";
import { PartitionClearRounds } from "./partition-clear-rounds.js";

const PARTITION = "session-07";
const OTHER_PARTITION = "session-11";

const DIRECTORY_STUCK = refuse(
  "browser-site-data",
  "browser.partition_stale",
  "The profile directory would not go.",
);

describe("PartitionClearRounds", () => {
  it("reads idle for a partition nobody has cleared", () => {
    expect(new PartitionClearRounds().stateFor(PARTITION)).toStrictEqual({ phase: "idle" });
  });

  it("records the step an act starts on and the steps it reaches", () => {
    const rounds = new PartitionClearRounds();
    const round = rounds.begin(PARTITION, "closing-pane");
    expect(round).toBeDefined();
    expect(rounds.stateFor(PARTITION)).toStrictEqual({ phase: "running", step: "closing-pane" });

    rounds.reachStep(round as NonNullable<typeof round>, PARTITION, "clearing");
    expect(rounds.stateFor(PARTITION)).toStrictEqual({ phase: "running", step: "clearing" });
  });

  it("refuses a second round on one partition and admits one on another", () => {
    const rounds = new PartitionClearRounds();
    expect(rounds.begin(PARTITION, "clearing")).toBeDefined();
    expect(rounds.begin(PARTITION, "clearing")).toBeUndefined();
    // One act at a time is per PARTITION, not per page: two partitions clearing at
    // once is two independent acts and refusing the second would be a page-wide lock
    // nothing asked for.
    expect(rounds.begin(OTHER_PARTITION, "clearing")).toBeDefined();
  });

  it("gives the slot back on settlement, so the next act may run", () => {
    const rounds = new PartitionClearRounds();
    const round = rounds.begin(PARTITION, "clearing");
    rounds.settle(round as NonNullable<typeof round>, PARTITION, { status: "cleared" });
    expect(rounds.stateFor(PARTITION)).toStrictEqual({
      phase: "settled",
      outcome: { status: "cleared" },
    });
    expect(rounds.begin(PARTITION, "clearing")).toBeDefined();
  });

  it("wakes its subscribers on every write, and stops on unsubscribe", () => {
    const rounds = new PartitionClearRounds();
    let wakes = 0;
    const unsubscribe = rounds.subscribe(() => {
      wakes += 1;
    });
    const round = rounds.begin(PARTITION, "closing-pane");
    rounds.reachStep(round as NonNullable<typeof round>, PARTITION, "clearing");
    expect(wakes).toBe(2);

    unsubscribe();
    rounds.settle(round as NonNullable<typeof round>, PARTITION, { status: "cleared" });
    expect(wakes).toBe(2);
  });

  it("negative control: a settlement from a round something superseded installs nothing", () => {
    // The whole reason the round is a claim rather than a boolean: a control that was
    // remounted, pressed again, and answered late must not overwrite the act the
    // person is actually waiting on.
    const rounds = new PartitionClearRounds();
    const abandoned = rounds.begin(PARTITION, "closing-pane");
    rounds.settle(abandoned as NonNullable<typeof abandoned>, PARTITION, { status: "cleared" });
    const live = rounds.begin(PARTITION, "clearing");

    rounds.settle(abandoned as NonNullable<typeof abandoned>, PARTITION, {
      status: "refused",
      at: "clearing",
      refusal: DIRECTORY_STUCK,
    });

    expect(rounds.stateFor(PARTITION)).toStrictEqual({ phase: "running", step: "clearing" });
    // And the live round still owns the slot, so the abandoned settlement did not free
    // the key its successor is holding.
    expect(rounds.begin(PARTITION, "clearing")).toBeUndefined();
    expect(live).toBeDefined();
  });
});

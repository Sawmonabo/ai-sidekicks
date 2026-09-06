// The tally a restart confirmation is built from.
//
// The claims worth a unit are the ones the dialog's own render cannot make: that a
// terminal run is not counted, that a state this build cannot read is counted
// neither way, that the enumeration is capped and the remainder still reaches the
// sentence, and that the order is the one the cap was written for.

import { describe, expect, it } from "vitest";

import { INTERRUPTED_RUN_IDS_NAMED_CAP } from "../../../../core/index.js";
import type { ConsoleEntity } from "../../../../store/index.js";
import { tallyLiveRuns } from "./restart-impact.js";

function runsFrom(entities: readonly ConsoleEntity[]): Readonly<Record<string, ConsoleEntity>> {
  return Object.fromEntries(entities.map((entity) => [entity.id, entity]));
}

function runAt(id: string, state: string, touchedAt?: string): ConsoleEntity {
  return { kind: "run", id, state, ...(touchedAt === undefined ? {} : { touchedAt }) };
}

describe("tallyLiveRuns counts what is still moving", () => {
  it("counts every non-terminal state and no terminal one", () => {
    const tally = tallyLiveRuns(
      runsFrom([
        runAt("run-queued", "queued"),
        runAt("run-waiting", "waiting_for_approval"),
        runAt("run-paused", "paused"),
        runAt("run-done", "completed"),
        runAt("run-stopped", "interrupted"),
        runAt("run-failed", "failed"),
      ]),
    );
    expect(tally.liveRunCount).toBe(3);
  });

  it("counts a state this build cannot read neither live nor finished", () => {
    // The honest arm. A newer daemon's tenth state reaches the store as a verbatim
    // string, and asserting it is moving would name a run in a sentence about work
    // that stops — while asserting it is finished would leave it out of one.
    const tally = tallyLiveRuns(runsFrom([runAt("run-new", "hibernating")]));
    expect(tally.liveRunCount).toBe(0);
    expect(tally.namedRunIds).toEqual([]);
  });

  it("counts a run the store holds with no state at all as not moving", () => {
    const tally = tallyLiveRuns(runsFrom([{ kind: "run", id: "run-bare" }]));
    expect(tally.liveRunCount).toBe(0);
  });

  it("negative control: an empty partition tallies nothing", () => {
    // Without this, a tally that answered a fixed count would satisfy every case
    // above and would put runs in the dialog for a session that has none.
    const tally = tallyLiveRuns({});
    expect(tally).toEqual({ liveRunCount: 0, namedRunIds: [], unnamedRunCount: 0 });
  });
});

describe("tallyLiveRuns enumerates a bounded prefix and counts the rest", () => {
  const many = runsFrom([
    runAt("run-a", "running", "2026-01-01T00:00:01.000Z"),
    runAt("run-b", "running", "2026-01-01T00:00:05.000Z"),
    runAt("run-c", "running", "2026-01-01T00:00:04.000Z"),
    runAt("run-d", "running", "2026-01-01T00:00:03.000Z"),
    runAt("run-e", "running", "2026-01-01T00:00:02.000Z"),
  ]);

  it("names no more than the cap and carries the remainder as a count", () => {
    const tally = tallyLiveRuns(many);
    expect(tally.namedRunIds).toHaveLength(INTERRUPTED_RUN_IDS_NAMED_CAP);
    expect(tally.unnamedRunCount).toBe(5 - INTERRUPTED_RUN_IDS_NAMED_CAP);
    // The count still names every moving run, so the cap costs the enumeration and
    // never the reading.
    expect(tally.liveRunCount).toBe(5);
  });

  it("names the newest-touched first", () => {
    expect(tallyLiveRuns(many).namedRunIds).toEqual(["run-b", "run-c", "run-d"]);
  });

  it("sorts a run with no timestamp last rather than first", () => {
    // An absent `touchedAt` is not evidence of recency. Sorting it to the head would
    // name the coldest rows in a sentence about live work.
    const tally = tallyLiveRuns(
      runsFrom([
        runAt("run-undated", "running"),
        runAt("run-old", "running", "2026-01-01T00:00:01.000Z"),
      ]),
    );
    expect(tally.namedRunIds).toEqual(["run-old", "run-undated"]);
  });

  it("orders two runs touched in the same instant by id rather than by key order", () => {
    const sameInstant = "2026-01-01T00:00:09.000Z";
    const tally = tallyLiveRuns(
      runsFrom([runAt("run-z", "running", sameInstant), runAt("run-a", "running", sameInstant)]),
    );
    expect(tally.namedRunIds).toEqual(["run-a", "run-z"]);
  });
});

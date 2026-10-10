// The run group fold, held to what `groups.ts` must never do. Each rule fails silently (a header
// standing over another run's rows, or a live run read as ended, still renders).

import type { ProviderAccountId } from "@ai-sidekicks/contracts/provider/account/record";
import type { TranscriptEventRow } from "@ai-sidekicks/contracts/transcript/row";
import type { TranscriptRunFactsFold } from "@ai-sidekicks/contracts/transcript/run-facts";
import { describe, expect, it } from "vitest";

import { runEntityOfFacts } from "#renderer/store/session/events/run/facts.js";
import { RunGroupIndex, groupRowsByRun, type RunEntitiesByRunId } from "./groups.js";
import { findRunGroup, mixedWindow } from "./groups.test-support.js";
import { runGroupHeadingOf } from "./heading.js";
import { generalRow, runRow } from "../event-rows.test-support.js";

/** A call and its result of `runId`, the `call`th pair in the log from `sequence`. */
function callPair(runId: string, sequence: number): readonly TranscriptEventRow[] {
  return [
    runRow({
      id: `${runId}-call-${String(sequence)}`,
      sequence,
      type: "tool.invoked",
      runId,
      position: sequence,
    }),
    runRow({
      id: `${runId}-result-${String(sequence + 1)}`,
      sequence: sequence + 1,
      type: "tool.result",
      runId,
      position: sequence + 1,
    }),
  ];
}

/** A store that holds no run facts. */
const NO_RUN_ENTITIES: RunEntitiesByRunId = {};

/** Run entities holding each run's facts, as the session store's run partition holds them. */
function runEntitiesHolding(
  factsByRunId: Readonly<Record<string, Partial<TranscriptRunFactsFold>>>,
): RunEntitiesByRunId {
  return Object.fromEntries(
    Object.entries(factsByRunId).map(([runId, facts]) => [
      runId,
      runEntityOfFacts(runId, { isRewound: false, foldedThroughSequence: 0, ...facts }),
    ]),
  );
}

/** An index over `rows`, its run groups reading `runEntities`. */
function indexOf(
  rows: readonly TranscriptEventRow[],
  runEntities: RunEntitiesByRunId,
): RunGroupIndex {
  const runGroupIndex = new RunGroupIndex(runEntities);
  for (const row of rows) {
    runGroupIndex.admit(row, false);
  }
  return runGroupIndex;
}

describe("run groups — rows join a run group by runId and by nothing else", () => {
  it("groups each run's rows and leaves an unattributed row out of every run group", () => {
    // The session row draws no card and run b replies after run a's last card, so no run is
    // broken.
    const runGroups = groupRowsByRun(mixedWindow(), NO_RUN_ENTITIES);
    expect(runGroups.map((runGroup) => runGroup.runId)).toStrictEqual(["run-a", "run-b"]);
    expect(findRunGroup(runGroups, "run-a").rowIds).toStrictEqual(["a1", "a2", "a3"]);
  });

  it("keeps each run group's rows in the order the log delivered them", () => {
    const runGroups = groupRowsByRun(
      [
        runRow({ id: "a2", sequence: 9, type: "assistant.message", runId: "run-a", position: 2 }),
        runRow({ id: "a1", sequence: 4, type: "run.queued", runId: "run-a", position: 1 }),
      ],
      NO_RUN_ENTITIES,
    );
    // Delivery order, not sequence order: the fold partitions and leaves the ordering to
    // whatever handed it the window.
    expect(findRunGroup(runGroups, "run-a").rowIds).toStrictEqual(["a2", "a1"]);
  });
});

describe("run groups — one unbroken stretch of a run under each header", () => {
  it("goes on under a new header after another agent's reply, each counting its drawn rows", () => {
    const runGroups = groupRowsByRun(
      [
        runRow({ id: "a-running", sequence: 1, type: "run.running", runId: "run-a", position: 1 }),
        ...callPair("run-a", 2),
        runRow({
          id: "b-reply",
          sequence: 4,
          type: "assistant.message",
          runId: "run-b",
          position: 1,
        }),
        ...callPair("run-a", 5),
        ...callPair("run-a", 7),
      ],
      runEntitiesHolding({ "run-a": { stateEventType: "run.running" } }),
    );

    // The running row draws nothing, so the first header counts only its call and result.
    expect(
      runGroups.map((runGroup) => [runGroup.key, runGroupHeadingOf(runGroup).entryCount]),
    ).toStrictEqual([
      ["run-a:a-running", "2"],
      ["run-b:b-reply", "1"],
      ["run-a:run-a-call-5", "4"],
    ]);
    // Only the newest header says what the run is doing now.
    expect(runGroups.map((runGroup) => runGroup.runStateEventType)).toStrictEqual([
      undefined,
      undefined,
      "run.running",
    ]);
  });

  it("ends the stretch at a person's message, even one stamped with the run it steers", () => {
    const steer = runRow({
      id: "steer",
      sequence: 3,
      type: "user.message",
      runId: "run-a",
      position: 3,
    });
    const rows = [...callPair("run-a", 1), steer, ...callPair("run-a", 4)];
    const runGroupIndex = indexOf(rows, NO_RUN_ENTITIES);

    expect(runGroupIndex.runGroups().map((runGroup) => runGroup.rowIds)).toStrictEqual([
      ["run-a-call-1", "run-a-result-2"],
      ["run-a-call-4", "run-a-result-5"],
    ]);
    expect(runGroupIndex.runGroupKeyByRowId().has("steer")).toBe(false);
  });

  it("lets a notification join the stretch it lands in, and one with no call before it stand alone", () => {
    const runGroups = groupRowsByRun(
      [
        // Before the run has a call, so it stands on its own.
        generalRow({ id: "early-notice", sequence: 1, type: "usage.context_compacted" }),
        ...callPair("run-a", 2),
        generalRow({ id: "session-notice", sequence: 4, type: "usage.context_compacted" }),
        // Another run's notification is not run a's, so it neither joins nor breaks run a.
        runRow({
          id: "b-notice",
          sequence: 5,
          type: "usage.context_compacted",
          runId: "run-b",
          position: 1,
        }),
        ...callPair("run-a", 6),
      ],
      NO_RUN_ENTITIES,
    );

    expect(runGroups.map((runGroup) => runGroup.rowIds)).toStrictEqual([
      ["run-a-call-2", "run-a-result-3", "session-notice", "run-a-call-6", "run-a-result-7"],
    ]);
  });

  it("draws no header for a run with no card, and stands one at the card that arrives", () => {
    // Two runs start together: a header above run b's first row would stand over run a's call.
    const rows = [
      runRow({ id: "a-queued", sequence: 1, type: "run.queued", runId: "run-a", position: 1 }),
      runRow({ id: "b-queued", sequence: 2, type: "run.queued", runId: "run-b", position: 1 }),
      ...callPair("run-a", 3),
    ];
    expect(groupRowsByRun(rows, NO_RUN_ENTITIES).map((runGroup) => runGroup.runId)).toStrictEqual([
      "run-a",
    ]);

    const runGroups = groupRowsByRun([...rows, ...callPair("run-b", 5)], NO_RUN_ENTITIES);
    expect(runGroups.map((runGroup) => [runGroup.key, runGroup.headerRowId])).toStrictEqual([
      ["run-a:a-queued", "run-a-call-3"],
      ["run-b:b-queued", "run-b-call-5"],
    ]);
  });
});

describe("run groups — what a header says of its run, from the store's facts", () => {
  it("reads who acts, who pays, the state and the ending from the run's facts, never its rows", () => {
    const runGroupIndex = indexOf(
      mixedWindow(),
      runEntitiesHolding({
        "run-a": {
          actor: "agent-from-facts",
          admittedProviderAccountId: "acct-7" as ProviderAccountId,
          stateEventType: "run.running",
        },
        "run-b": { stateEventType: "run.completed" },
      }),
    );
    const runA = findRunGroup(runGroupIndex.runGroups(), "run-a");
    expect([runA.actorId, runA.payingAccountId, runA.runStateEventType]).toStrictEqual([
      "agent-from-facts",
      "acct-7",
      "run.running",
    ]);
    expect([...runGroupIndex.liveRunIds()]).toStrictEqual(["run-a"]);
    // A run the store holds no facts for has not been seen to end, and neither has a completion
    // a rewind came after.
    expect([...indexOf(mixedWindow(), NO_RUN_ENTITIES).liveRunIds()]).toStrictEqual([
      "run-a",
      "run-b",
    ]);
    const rewound = runEntitiesHolding({
      "run-b": { stateEventType: "run.completed", isRewound: true },
    });
    expect([...indexOf(mixedWindow(), rewound).liveRunIds()]).toContain("run-b");
  });

  it("seals again only the headers newer facts move, and moves a run that ended", () => {
    const rows = [
      ...callPair("run-a", 1),
      runRow({
        id: "b-reply",
        sequence: 3,
        type: "assistant.message",
        runId: "run-b",
        position: 1,
      }),
      ...callPair("run-a", 4),
    ];
    const running = runEntitiesHolding({
      "run-a": { actor: "agent-one", stateEventType: "run.running" },
    });
    const runGroupIndex = indexOf(rows, running);
    runGroupIndex.sealTouched();
    const keysOf = (runGroups: readonly { readonly key: string }[]): readonly string[] =>
      runGroups.map((runGroup) => runGroup.key);

    // The same entities, or new ones holding the same facts objects, move nothing.
    expect(runGroupIndex.admitRunEntities(running)).toBe(false);
    expect(runGroupIndex.admitRunEntities({ ...running })).toBe(false);

    // A new state moves only the newest header, and an ending takes the run out of the live set.
    const completed = runEntitiesHolding({
      "run-a": { actor: "agent-one", stateEventType: "run.completed" },
    });
    expect(runGroupIndex.admitRunEntities(completed)).toBe(true);
    const resealed = runGroupIndex.sealTouched();
    expect(keysOf(resealed)).toStrictEqual(["run-a:run-a-call-4"]);
    expect(resealed[0]?.runStateEventType).toBe("run.completed");
    expect([...runGroupIndex.liveRunIds()]).toStrictEqual(["run-b"]);

    // Every header of the run names its actor, so a new actor seals each of them again.
    const renamed = runEntitiesHolding({
      "run-a": { actor: "agent-two", stateEventType: "run.completed" },
    });
    expect(runGroupIndex.admitRunEntities(renamed)).toBe(true);
    expect(keysOf(runGroupIndex.sealTouched())).toStrictEqual([
      "run-a:run-a-call-1",
      "run-a:run-a-call-4",
    ]);
  });
});

// Expanding a child run, over a real bridge whose one call the case decides.
//
// `bridgeAnswering` rather than a hand-built port: the expansion reaches the console's
// own call door, so a stand-in would prove the case answers itself rather than that
// the reply is parsed against the shape the corpus registers.

import { describe, expect, it } from "vitest";

import { type RunId } from "@ai-sidekicks/contracts";

import { bridgeAnswering } from "../../../bridge/fixture/fixture-bridge.test-support.js";
import { ChildRunExpansionState } from "./child-run-expansion.js";
import { FIXTURE_SESSION_ID } from "../timeline-rows.test-support.js";

const CHILD_RUN_ID = "019b79ee-0280-740e-8110-d1a4c1150091" as RunId;
const PARENT_RUN_ID = "019b79ee-0280-740e-8110-d1a4c1150092" as RunId;

/** One registered `ChildRunExpandResponse`, on the terminal arm. */
function expansionReply(entryCount: number, hasMore = false): Record<string, unknown> {
  return {
    runId: CHILD_RUN_ID,
    parentRunId: PARENT_RUN_ID,
    state: "running",
    hasMore,
    ...(hasMore ? { nextCursor: "cursor-next" } : {}),
    entries: Array.from({ length: entryCount }, (_unused, index) => ({
      id: `child-${String(index)}`,
      sessionId: FIXTURE_SESSION_ID,
      sequence: index,
      category: "run_lifecycle",
      type: "run.started",
      summary: "the child ran",
      timestamp: new Date(Date.UTC(2026, 0, 1, 9, 0, index)).toISOString(),
      kind: "run",
      runId: CHILD_RUN_ID,
      position: index,
      epoch: 0,
      payload: {},
    })),
  };
}

describe("child-run expansion — what a press leaves on screen", () => {
  it("starts summarized and reads nothing until asked", () => {
    const expansions = new ChildRunExpansionState();
    expect(expansions.expansionFor(CHILD_RUN_ID).status).toBe("summarized");
    expect(expansions.trackedChildRunIds.size).toBe(0);
  });

  it("holds the entries the daemon served and reports the unread remainder", async () => {
    const { bridge } = bridgeAnswering(async (call, passThrough) =>
      call.method === "timeline.childRunExpand" ? expansionReply(2, true) : passThrough(),
    );
    const expansions = new ChildRunExpansionState();
    const settled = await expansions.expand(bridge, CHILD_RUN_ID);
    expect(settled.status).toBe("expanded");
    expect(settled.entries).toHaveLength(2);
    expect(settled.hasUnreadEntries).toBe(true);
  });

  it("sends the child run's own id and nothing else", async () => {
    const { bridge, calls } = bridgeAnswering(async (call, passThrough) =>
      call.method === "timeline.childRunExpand" ? expansionReply(0) : passThrough(),
    );
    await new ChildRunExpansionState().expand(bridge, CHILD_RUN_ID);
    const expandCall = calls.find((call) => call.method === "timeline.childRunExpand");
    expect(expandCall?.params).toEqual({ runId: CHILD_RUN_ID });
  });

  it("takes the door's own refusal when the call is rejected, and never raises", async () => {
    const { bridge } = bridgeAnswering(async (call, passThrough) => {
      if (call.method !== "timeline.childRunExpand") {
        return passThrough();
      }
      throw new Error("the daemon is not reachable");
    });
    const expansions = new ChildRunExpansionState();
    const settled = await expansions.expand(bridge, CHILD_RUN_ID);
    expect(settled.status).toBe("expand-failed");
    expect(settled.refusal?.code).toBe("call-rejected");
    expect(expansions.expansionFor(CHILD_RUN_ID).status).toBe("expand-failed");
  });

  it("refuses a reply the registered shape does not admit rather than reading it", async () => {
    const { bridge } = bridgeAnswering(async (call, passThrough) =>
      call.method === "timeline.childRunExpand" ? { runId: CHILD_RUN_ID } : passThrough(),
    );
    const settled = await new ChildRunExpansionState().expand(bridge, CHILD_RUN_ID);
    expect(settled.status).toBe("expand-failed");
    expect(settled.entries).toEqual([]);
  });

  it("keeps the rows an earlier expansion delivered when a later one fails", async () => {
    let shouldFail = false;
    const { bridge } = bridgeAnswering(async (call, passThrough) => {
      if (call.method !== "timeline.childRunExpand") {
        return passThrough();
      }
      if (shouldFail) {
        throw new Error("the daemon is not reachable");
      }
      return expansionReply(3);
    });
    const expansions = new ChildRunExpansionState();
    await expansions.expand(bridge, CHILD_RUN_ID);
    shouldFail = true;
    const settled = await expansions.expand(bridge, CHILD_RUN_ID);
    expect(settled.status).toBe("expand-failed");
    expect(settled.entries).toHaveLength(3);
  });

  it("puts one call on the wire when a person presses twice", async () => {
    const { bridge, calls } = bridgeAnswering(async (call, passThrough) =>
      call.method === "timeline.childRunExpand" ? expansionReply(1) : passThrough(),
    );
    const expansions = new ChildRunExpansionState();
    const [first, second] = await Promise.all([
      expansions.expand(bridge, CHILD_RUN_ID),
      expansions.expand(bridge, CHILD_RUN_ID),
    ]);
    expect(calls.filter((call) => call.method === "timeline.childRunExpand")).toHaveLength(1);
    expect(first.status).toBe("expanded");
    expect(second.status).toBe("expanding");
  });

  it("folds back to a summary that holds nothing the expansion read", async () => {
    const { bridge } = bridgeAnswering(async (call, passThrough) =>
      call.method === "timeline.childRunExpand" ? expansionReply(2) : passThrough(),
    );
    const expansions = new ChildRunExpansionState();
    await expansions.expand(bridge, CHILD_RUN_ID);
    expansions.collapse(CHILD_RUN_ID);
    expect(expansions.expansionFor(CHILD_RUN_ID).entries).toEqual([]);
    expect(expansions.trackedChildRunIds.size).toBe(0);
  });
});

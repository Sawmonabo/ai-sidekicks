// Expanding a child run, over a real bridge whose one call the case decides.
//
// `bridgeAnswering` rather than a hand-built port: the expansion reaches the console's
// own call door, so a stand-in would prove the case answers itself rather than that
// the reply is parsed against the shape the corpus registers.

import { describe, expect, it } from "vitest";

import { type RunId } from "@ai-sidekicks/contracts";

import { bridgeAnswering } from "../../../bridge/fixture/fixture-bridge.test-support.js";
import { type ConsoleBridge } from "../../../bridge/index.js";
import { ChildRunExpansionState } from "./child-run-expansion.js";
import { FIXTURE_SESSION_ID } from "../timeline-rows.test-support.js";

const CHILD_RUN_ID = "019b79ee-0280-740e-8110-d1a4c1150091" as RunId;
const PARENT_RUN_ID = "019b79ee-0280-740e-8110-d1a4c1150092" as RunId;
/** A second child of the same parent, for the cases about two lines at once. */
const SECOND_CHILD_RUN_ID = "019b79ee-0280-740e-8110-d1a4c1150093" as RunId;

/** One registered `ChildRunExpandResponse`, on the terminal arm. */
function expansionReply(
  entryCount: number,
  hasMore = false,
  childRunId: RunId = CHILD_RUN_ID,
): Record<string, unknown> {
  return {
    runId: childRunId,
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
      runId: childRunId,
      position: index,
      epoch: 0,
      payload: {},
    })),
  };
}

/** What a case holds a scripted expansion with, and the act that lets it answer. */
interface HeldExpansions {
  readonly bridge: ConsoleBridge;
  /** Let every expansion this bridge is holding answer. */
  readonly release: () => void;
}

/**
 * A bridge whose expansions answer only when the case says so.
 *
 * The window between the request and the reply is where every claim below lives — an
 * expansion abandoned mid-flight, and two children reading at once — and it is not
 * observable without a reply the case releases.
 */
function bridgeHoldingExpansions(): HeldExpansions {
  let releaseReplies = (): void => undefined;
  const untilReleased = new Promise<void>((resolve) => {
    releaseReplies = resolve;
  });
  const { bridge } = bridgeAnswering(async (call, passThrough) => {
    if (call.method !== "timeline.childRunExpand") {
      return passThrough();
    }
    await untilReleased;
    const requestedRunId = (call.params as { readonly runId: RunId }).runId;
    return expansionReply(1, false, requestedRunId);
  });
  return {
    bridge,
    release: () => {
      releaseReplies();
    },
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

describe("child-run expansion — one read line per child, and what ends one", () => {
  it("expands two children at once rather than one superseding the other", async () => {
    // WHY THE LINES ARE PER CHILD. A single line per session would make the second
    // press the supersession of the first, and the first child's row — already showing
    // `expanding` — would never be settled by anything. Both settle here, which is the
    // property the per-child guard was always claiming and nothing was holding it to.
    const { bridge, release } = bridgeHoldingExpansions();
    const expansions = new ChildRunExpansionState();

    const first = expansions.expand(bridge, CHILD_RUN_ID);
    const second = expansions.expand(bridge, SECOND_CHILD_RUN_ID);
    release();

    expect((await first).status).toBe("expanded");
    expect((await second).status).toBe("expanded");
    expect(expansions.trackedChildRunIds.size).toBe(2);
  });

  it("puts an abandoned press back rather than leaving the row expanding", async () => {
    // THE TWO HALVES, TOGETHER. Nothing installs — the entries belong to a disclosure
    // nobody is rendering — and the row does not stay frozen mid-press either, because
    // a row stuck on `expanding` is a control that can never be pressed again. The
    // control is "holds the entries the daemon served" above: same call, same reply,
    // and it installs when the line is still somebody's.
    const { bridge, release } = bridgeHoldingExpansions();
    const expansions = new ChildRunExpansionState();

    const settling = expansions.expand(bridge, CHILD_RUN_ID);
    expect(expansions.expansionFor(CHILD_RUN_ID).status).toBe("expanding");

    expansions.abandonReads();
    release();
    const settled = await settling;

    expect(expansions.isAbandoned).toBe(true);
    expect(settled.status).toBe("summarized");
    expect(settled.entries).toEqual([]);
    expect(expansions.expansionFor(CHILD_RUN_ID).status).toBe("summarized");
    expect(expansions.trackedChildRunIds.size).toBe(0);
  });

  it("answers a press that arrives after the disclosure is over with a read that never lands", async () => {
    const { bridge, release } = bridgeHoldingExpansions();
    const expansions = new ChildRunExpansionState();
    expansions.abandonReads();

    const settling = expansions.expand(bridge, CHILD_RUN_ID);
    release();

    expect((await settling).status).toBe("summarized");
    expect(expansions.trackedChildRunIds.size).toBe(0);
  });
});

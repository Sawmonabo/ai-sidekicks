import { describe, expect, it } from "vitest";

import type {
  WorkflowDocument,
  WorkflowNode,
  WorkflowNodeId,
} from "@ai-sidekicks/contracts/workflow/definition/document";
import type { ProviderAccountId } from "@ai-sidekicks/contracts/provider/account/record";
import type { WorkflowRunId } from "@ai-sidekicks/contracts/workflow/run/status";
import type { WorkflowStep } from "@ai-sidekicks/contracts/workflow/run/step";

import { formatDayClock } from "#renderer/lib/wire/figures.js";
import { flowingEdgeIds, liveNodeId, runGraphNodeViews } from "./node-views.js";

const RUN_ID = "019b7a10-0280-75e5-8510-ada11a5a4999" as WorkflowRunId;

function node(id: string, name: string): WorkflowNode {
  return {
    id: id as WorkflowNodeId,
    kind: "agent.run",
    kindVersion: 1,
    name,
    order: 0,
    params: {},
  };
}

const DOCUMENT: WorkflowDocument = {
  schemaVersion: "2",
  name: "Summarize folder",
  trigger: node("watch", "Watch the folder"),
  nodes: [node("summary", "Summarize")],
  edges: [
    {
      id: "edge-watch-summary",
      source: "watch" as WorkflowNodeId,
      sourceHandle: "outputs/main/0",
      target: "summary" as WorkflowNodeId,
      targetHandle: "inputs/main/0",
    },
  ],
};

function step(
  nodeId: string,
  executionIndex: number,
  fields: Pick<WorkflowStep, "status" | "attempt"> & Partial<WorkflowStep>,
): WorkflowStep {
  return {
    workflowRunId: RUN_ID,
    nodeId: nodeId as WorkflowNodeId,
    executionIndex,
    source:
      nodeId === "watch"
        ? []
        : [{ nodeId: "watch" as WorkflowNodeId, outputIndex: 0, executionIndex: 0 }],
    startedAt: "2026-01-01T14:00:00.000Z",
    inputRef: { kind: "inline", items: [] },
    outputRef: { kind: "inline", items: [] },
    logRef: { kind: "inline", items: [] },
    ...fields,
  };
}

const TRIGGERED = step("watch", 0, {
  status: "succeeded",
  attempt: 1,
  finishedAt: "2026-01-01T14:00:01.000Z",
});
const FIRST_ATTEMPT_FAILED = step("summary", 1, {
  status: "failed",
  attempt: 1,
  finishedAt: "2026-01-01T14:01:00.000Z",
  error: { message: "The provider refused the turn", itemIndex: 4 },
});

/** The instant the graph counts days from. */
const GRAPH_NOW_MS = Date.UTC(2026, 0, 1, 14, 20);

function summaryView(steps: readonly WorkflowStep[]) {
  const view = runGraphNodeViews(DOCUMENT, steps, [], GRAPH_NOW_MS).find(
    (candidate) => candidate.node.id === "summary",
  );
  if (view === undefined) {
    throw new Error("the graph drew no Summarize node");
  }
  return view;
}

describe("the run graph nests a node's retries under its latest attempt", () => {
  it("draws the retry still going, not the earlier attempt's failure, and follows it", () => {
    // Listed retry first: the latest attempt is chosen by execution order, never by list order.
    const steps = [
      step("summary", 2, { status: "running", attempt: 2 }),
      TRIGGERED,
      FIRST_ATTEMPT_FAILED,
    ];

    const view = summaryView(steps);

    expect(view.status).toBe("running");
    expect(view.attemptWords).toBe("Attempt 2");
    expect(view.errorLine, "the earlier attempt's failure leaked onto the retry").toBeUndefined();
    expect(view.accessibleName).toBe("Summarize · Running · Attempt 2");
    expect(liveNodeId(steps)).toBe("summary");
    expect([...flowingEdgeIds(DOCUMENT, steps)]).toEqual(["edge-watch-summary"]);
  });

  it("draws the latest failed attempt with its own failing item", () => {
    const steps = [
      TRIGGERED,
      FIRST_ATTEMPT_FAILED,
      step("summary", 2, {
        status: "failed",
        attempt: 2,
        finishedAt: "2026-01-01T14:02:00.000Z",
        error: { message: "The summary came back empty\nstack line", itemIndex: 1 },
      }),
    ];

    const view = summaryView(steps);

    expect(view.errorLine).toBe("Item 1 · The summary came back empty");
    expect(view.accessibleName).toBe(
      "Summarize · Failed · Attempt 2 · Item 1 · The summary came back empty",
    );
    expect(liveNodeId(steps)).toBeUndefined();
    expect(flowingEdgeIds(DOCUMENT, steps).size).toBe(0);
  });
});

describe("the run graph names when a parked node resumes", () => {
  it("writes a resume on another day with its day in front", () => {
    // Two days on, so it is another day in every time zone.
    const resumeAt = "2026-01-03T14:00:00.000Z";
    const parked = step("summary", 1, {
      status: "waiting",
      attempt: 1,
      waitCause: "account",
      waitAccount: {
        providerAccountId: "pa-0001" as ProviderAccountId,
        provider: "codex",
        label: "Work",
      },
      resumeAt,
    });

    expect(summaryView([TRIGGERED, parked]).resumeLine).toBe(
      `Resumes at ${formatDayClock(resumeAt, GRAPH_NOW_MS)}`,
    );
  });
});

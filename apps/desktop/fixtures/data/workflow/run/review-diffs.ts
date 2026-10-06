// What Review is answered with when a workflow run's page opens it: the finished digest run's
// comparison from its start to its end, with files its steps wrote and one edit made outside the
// run in the same checkout, and the waiting release run's comparison from its start to its approval
// pause, which changed nothing. Any other comparison is left unscripted, so it refuses by name.

import type {
  GitflowDiffReadResponse,
  WorkflowRunSnapshotPoint,
} from "@ai-sidekicks/contracts/gitflow/local";
import type { WorkflowNodeId } from "@ai-sidekicks/contracts/workflow/definition/document";
import type { ScenarioReply } from "#renderer/services/daemon/scenario/reply.fixture.js";
import { readMember, readString } from "../../requests.js";
import { WORKFLOW_RUN_IDS } from "./records.js";

/** The finished digest run's comparison: two files its steps wrote, one edit made outside it. */
const DIGEST_RUN_CHANGES: GitflowDiffReadResponse = {
  base: "run start",
  head: "run end",
  files: [
    {
      path: "reviews/pr-412.md",
      kind: "added",
      additions: 3,
      deletions: 0,
      patch: [
        "--- /dev/null",
        "+++ b/reviews/pr-412.md",
        "@@ -0,0 +1,3 @@",
        "+# PR 412",
        "+",
        "+Looks good once the retry test is fixed.",
        "",
      ].join("\n"),
      step: { nodeId: "review" as WorkflowNodeId, nodeName: "Review one PR" },
    },
    {
      path: "digest/summary.md",
      kind: "modified",
      additions: 1,
      deletions: 1,
      patch: [
        "--- a/digest/summary.md",
        "+++ b/digest/summary.md",
        "@@ -1,3 +1,3 @@",
        " # Weekday digest",
        "-Nothing reviewed yet.",
        "+One PR reviewed: 412.",
        " ",
        "",
      ].join("\n"),
      step: { nodeId: "summary" as WorkflowNodeId, nodeName: "Save the notes" },
    },
    {
      path: "notes/todo.txt",
      kind: "modified",
      additions: 1,
      deletions: 0,
      patch: [
        "--- a/notes/todo.txt",
        "+++ b/notes/todo.txt",
        "@@ -1 +1,2 @@",
        " call the bank",
        "+water the plants",
        "",
      ].join("\n"),
    },
  ],
};

/** The waiting release run's comparison up to its approval pause: nothing was written. */
const RELEASE_RUN_UNTIL_PAUSE: GitflowDiffReadResponse = {
  base: "run start",
  head: "approval pause 1",
  files: [],
};

/** The diff reads a workflow run's `Open in Review` makes, answered by run and snapshot points. */
export const WORKFLOW_RUN_DIFF_REPLIES: readonly ScenarioReply[] = [
  { call: "gitflow.diffRead", afterMs: 120, resultFor: answerDiffRead },
];

function answerDiffRead(request: unknown): GitflowDiffReadResponse | undefined {
  if (readString(request, "scope") !== "workflow_run") {
    return undefined;
  }
  const workflowRunId = readString(request, "workflowRunId");
  const from = readMember(request, "from");
  const to = readMember(request, "to");
  if (
    workflowRunId === WORKFLOW_RUN_IDS.succeeded &&
    isPoint(from, { epoch: 1, point: "start" }) &&
    isPoint(to, { epoch: 1, point: "end" })
  ) {
    return DIGEST_RUN_CHANGES;
  }
  if (
    workflowRunId === WORKFLOW_RUN_IDS.waitingApproval &&
    isPoint(from, { epoch: 1, point: "start" }) &&
    isPoint(to, { epoch: 1, point: "pause", pauseNumber: 1 })
  ) {
    return RELEASE_RUN_UNTIL_PAUSE;
  }
  return undefined;
}

function isPoint(candidate: unknown, expected: WorkflowRunSnapshotPoint): boolean {
  return (
    readMember(candidate, "epoch") === expected.epoch &&
    readMember(candidate, "point") === expected.point &&
    readMember(candidate, "pauseNumber") ===
      (expected.point === "pause" ? expected.pauseNumber : undefined)
  );
}

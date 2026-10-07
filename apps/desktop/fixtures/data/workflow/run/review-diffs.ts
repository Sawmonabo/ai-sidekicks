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

/**
 * The review note the digest run's review step wrote. Long enough that its diff runs several
 * window heights, so a fling over it ends inside the change rather than at its last line.
 */
const PR_412_REVIEW_LINES: readonly string[] = [
  "# PR 412",
  "",
  "Looks good once the retry test is fixed.",
  "",
  "## What it changes",
  "",
  "The lease store now counts held leases per session before it claims one, and a claim past",
  "the capacity waits for a release instead of failing at once. The wait is bounded by the",
  "lease's own expiry, so a session that never releases cannot hold the queue.",
  "",
  "## The retry test",
  "",
  "`claims a lease after the holder releases it` passes on its own and fails when the whole",
  "file runs, because the store from the test before it is still holding two leases. Each test",
  "should build its own store; the shared one at the top of the file is the cause.",
  "",
  "## File by file",
  "",
  "### `lease-store.ts`",
  "",
  "- `claim` reads the held count and the capacity in one transaction, which closes the race",
  "  the old two-step read had.",
  "- The wait loop sleeps on the release signal, not a timer. Good.",
  "- The expiry check uses the store's clock, so tests can move it. Good.",
  "- `release` wakes one waiter, not all of them; that keeps the queue fair.",
  "- The error for a claim that times out names the session and the capacity. Good.",
  "",
  "### `lease-store.test.ts`",
  "",
  "- The shared store at the top of the file should move into a `beforeEach`.",
  "- `times out a claim past the expiry` moves the clock past the expiry but never checks the",
  "  claim was refused with the timeout error; it only checks that it settled.",
  "- `wakes the next waiter` should also check the third waiter is still waiting.",
  "",
  "### `rate-limit/index.ts`",
  "",
  "- Only the import order changed. Fine.",
  "",
  "### `docs/rate-limit.md`",
  "",
  "- The new paragraph on waiting says the wait has no bound. It is bounded by the expiry now,",
  "  so the paragraph should say so.",
  "",
  "## Behavior checked by hand",
  "",
  "- Two sessions at capacity: the third claim waits and goes through when one releases.",
  "- A holder that never releases: the waiting claim times out at the expiry with the error.",
  "- A release with no one waiting: nothing happens and the count drops by one.",
  "- A claim from a session that already holds a lease: it is counted again, as before.",
  "- Restarting the daemon with leases held: they are read back and still counted.",
  "",
  "## Test run",
  "",
  "```",
  "lease-store.test.ts",
  "  claims a lease under the capacity            ok",
  "  waits for a release past the capacity        ok",
  "  claims a lease after the holder releases it  failed (passes alone)",
  "  times out a claim past the expiry            ok",
  "  wakes the next waiter                        ok",
  "  reads held leases back after a restart       ok",
  "rate-limit.test.ts",
  "  limits a session to its share                ok",
  "  shares the capacity across sessions          ok",
  "```",
  "",
  "## Asked of the author",
  "",
  "1. Give each test in `lease-store.test.ts` its own store.",
  "2. Check the timeout error in `times out a claim past the expiry`.",
  "3. Check the third waiter in `wakes the next waiter`.",
  "4. Update the waiting paragraph in `docs/rate-limit.md`.",
  "",
  "## Not asked",
  "",
  "- Renaming `claim` to `acquire`: the rest of the daemon says claim.",
  "- A metric for the wait time: worth a separate change if the queue ever grows.",
  "",
  "## Risk",
  "",
  "Low. The change is inside the lease store, the old behavior is kept for claims under the",
  "capacity, and the wait cannot outlast the expiry.",
  "",
  "## Follow-ups",
  "",
  "- The daemon's own docs still describe the lease count as per machine.",
  "- `rate-limit.test.ts` builds its stores the same shared way and may hide the same problem.",
  "",
  "Approve once the four points above are in.",
];

/** The finished digest run's comparison: two files its steps wrote, one edit made outside it. */
const DIGEST_RUN_CHANGES: GitflowDiffReadResponse = {
  base: "run start",
  head: "run end",
  files: [
    {
      path: "reviews/pr-412.md",
      kind: "added",
      additions: PR_412_REVIEW_LINES.length,
      deletions: 0,
      patch: [
        "--- /dev/null",
        "+++ b/reviews/pr-412.md",
        `@@ -0,0 +1,${String(PR_412_REVIEW_LINES.length)} @@`,
        ...PR_412_REVIEW_LINES.map((line) => `+${line}`),
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

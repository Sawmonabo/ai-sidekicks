// Review's read of what one workflow run changed between two of its snapshot points. The snapshots
// are pinned, so nothing pushes a change to this answer: the read is asked again only by the
// window's focus, a reconnect and a person pressing `Try again`, and another `Open in Review`
// press re-points the pane, which reads a new comparison.

import type { GitDiffReadRequest } from "@ai-sidekicks/contracts/git/local";

import type { Clock } from "#renderer/lib/clock.js";
import { callDaemon } from "#renderer/services/daemon/reply.js";
import { unwrapDaemonReply } from "#renderer/services/daemon/reply.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import { PushDrivenRead } from "#renderer/store/reads/push-driven.js";
import type { DiffModel } from "./model.js";
import { diffModelFromRead } from "./read-model.js";

/** The `git.diff.read` request for a workflow run's comparison. */
export type WorkflowRunDiffRequest = Extract<GitDiffReadRequest, { scope: "workflowRun" }>;

/** The read of one run comparison; a refusal is its failed arm. */
export function createWorkflowRunDiffRead(
  bridge: PlatformBridge,
  clock: Clock,
  request: WorkflowRunDiffRequest,
): PushDrivenRead<DiffModel> {
  return new PushDrivenRead({
    clock,
    origin: "workflow-run-diff",
    read: async (signal) =>
      diffModelFromRead(
        unwrapDaemonReply(await callDaemon(bridge, "git.diff.read", request, { signal })),
      ),
    // Pinned snapshots have no stream to listen on; the release has nothing to close.
    subscribe: () => () => undefined,
  });
}

// The lost-folder banner's `Re-attach`: the call that attaches the folder fresh under the same
// project, and the line a refusal draws at the word. A refusal names what stands in the way by id,
// so the line reads the names behind them: the project of the mount that holds the repository,
// the agent whose run is live in the project, read off the agent list every view of that session
// shares, or the workflow whose run is. A folder holding its own repository again draws no line,
// and any other refusal draws the daemon's words.

import type { AgentId } from "@ai-sidekicks/contracts/agent/definition";
import type { RepoMountId } from "@ai-sidekicks/contracts/repo/mount";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { WorkflowRunId } from "@ai-sidekicks/contracts/workflow/run/id";

import type { ExtendedRefusal, RefusalHolder } from "#renderer/lib/refusal/extensions.js";
import { agentListFeedFor } from "#renderer/services/daemon/agent-list.js";
import { callDaemon } from "#renderer/services/daemon/reply.js";
import { heldIdAsWireId } from "#renderer/services/daemon/wire/identifiers.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import { agentNameOf, sessionAgentLists } from "#renderer/store/agents/list.js";

import { refusedLine } from "./notices.js";

/**
 * Send `repoMount.reattach` for the lost folder's mount; settles to the line a refusal draws at
 * `Re-attach`, or `undefined` once served, when the new mount's health takes the banner away.
 */
export async function reattachFolder(
  bridge: PlatformBridge,
  repoMountId: string,
  folder: string,
): Promise<string | undefined> {
  const reply = await callDaemon(bridge, "repoMount.reattach", {
    repoMountId: heldIdAsWireId<RepoMountId>(repoMountId),
  });
  // A folder that holds its own repository again has nothing to recover: the daemon's next probe
  // takes the banner away, so the refusal draws no line.
  if (reply.status === "served" || reply.refusal.code === "repoMount.reattachRefused") {
    return undefined;
  }
  const named = await nameReattachRefusal(bridge, reply.refusal, folder);
  return named === undefined ? refusedLine(reply.refusal) : reattachRefusalWords(named);
}

// A re-attach refusal that names what stands in the way: the folder and the project its repository
// is already attached to (`null` when a chat's own workspace holds it), or the agent or workflow
// whose run is live in the project.
type ReattachRefusal =
  | {
      readonly code: "repoMount.alreadyAttached";
      readonly folder: string;
      readonly projectName: string | null;
    }
  | { readonly code: "repoMount.reattachConflict"; readonly runnerName: string };

// The words a re-attach refusal is drawn in, inline at the `Re-attach` that was pressed.
function reattachRefusalWords(refusal: ReattachRefusal): string {
  switch (refusal.code) {
    case "repoMount.alreadyAttached":
      return `Could not re-attach: ${refusal.folder} is already attached to ${
        refusal.projectName ?? "a chat"
      }`;
    case "repoMount.reattachConflict":
      return `Could not re-attach while ${refusal.runnerName} is running. Stop the run first.`;
  }
}

// The refusal with the names its ids stand for, or `undefined` where it names nothing the banner
// words or a name could not be read.
async function nameReattachRefusal(
  bridge: PlatformBridge,
  refusal: ExtendedRefusal,
  folder: string,
): Promise<ReattachRefusal | undefined> {
  const holder: RefusalHolder = refusal.holder ?? {};
  switch (refusal.code) {
    case "repoMount.alreadyAttached": {
      if (holder.repoMountId === undefined) {
        return undefined;
      }
      const holding = await callDaemon(bridge, "repoMount.read", {
        repoMountId: heldIdAsWireId<RepoMountId>(holder.repoMountId),
      });
      return holding.status === "served"
        ? {
            code: "repoMount.alreadyAttached",
            folder,
            projectName: holding.value.displayName ?? null,
          }
        : undefined;
    }
    case "repoMount.reattachConflict": {
      const runnerName =
        holder.workflowRunId !== undefined
          ? await readWorkflowName(bridge, holder.workflowRunId)
          : holder.sessionId !== undefined && holder.agentId !== undefined
            ? await readAgentName(bridge, holder.sessionId, holder.agentId)
            : undefined;
      return runnerName === undefined
        ? undefined
        : { code: "repoMount.reattachConflict", runnerName };
    }
    default:
      return undefined;
  }
}

// The name of the workflow a run belongs to, from the run's definition.
async function readWorkflowName(
  bridge: PlatformBridge,
  workflowRunId: string,
): Promise<string | undefined> {
  const run = await callDaemon(bridge, "workflow.run.read", {
    workflowRunId: heldIdAsWireId<WorkflowRunId>(workflowRunId),
  });
  if (run.status === "refused") {
    return undefined;
  }
  const definition = await callDaemon(bridge, "workflow.definition.read", {
    definitionId: run.value.definitionId,
  });
  return definition.status === "served" ? definition.value.name : undefined;
}

// The name of one agent of `sessionId`, read off the session's shared agent list once it has
// settled; the list's feed opens again when its stream ends, so a list or its loss always comes.
function readAgentName(
  bridge: PlatformBridge,
  sessionId: string,
  agentId: string,
): Promise<string | undefined> {
  const feed = agentListFeedFor(bridge);
  const session = heldIdAsWireId<SessionId>(sessionId);
  const agent = heldIdAsWireId<AgentId>(agentId);
  return new Promise((resolve) => {
    const settleIfRead = (): boolean => {
      const state = sessionAgentLists.stateOf(feed, session);
      if (state.status === "reading") {
        return false;
      }
      resolve(agentNameOf(state, agent));
      return true;
    };
    let release: (() => void) | undefined;
    release = sessionAgentLists.watch(feed, session, () => {
      if (settleIfRead()) {
        // The list may settle while the watch opens, before `release` is assigned.
        queueMicrotask(() => {
          release?.();
          release = undefined;
        });
      }
    });
    // A list another view of the session already holds is read at once.
    if (settleIfRead()) {
      release();
      release = undefined;
    }
  });
}

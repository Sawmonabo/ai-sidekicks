// The lost-folder banner's `Re-attach`: the call that attaches the folder fresh under the same
// project, and the line a refusal draws at the word. A refusal names what stands in the way by id,
// so the line reads the names behind them: the project of the mount that holds the repository,
// or the agent whose run is live in the project. A folder holding its own repository again draws
// no line, and any other refusal draws the daemon's words.

import type { AgentId } from "@ai-sidekicks/contracts/agent/definition";
import type { RepoMountId } from "@ai-sidekicks/contracts/repo/mount";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { ExtendedRefusal, RefusalHolder } from "#renderer/lib/refusal/extensions.js";
import { agentListFeedFor } from "#renderer/services/daemon/agent-list.js";
import { callDaemon } from "#renderer/services/daemon/reply.js";
import { heldIdAsWireId } from "#renderer/services/daemon/wire/identifiers.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import { agentNameOf, type SessionAgentListState } from "#renderer/store/agents/list.js";

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
// is already attached to (`null` when a chat's own workspace holds it), or the agent running in the
// project (`null` for a workflow's run).
type ReattachRefusal =
  | {
      readonly code: "repoMount.alreadyAttached";
      readonly folder: string;
      readonly projectName: string | null;
    }
  | { readonly code: "repoMount.reattachConflict"; readonly agentName: string | null };

// The words a re-attach refusal is drawn in, inline at the `Re-attach` that was pressed.
function reattachRefusalWords(refusal: ReattachRefusal): string {
  switch (refusal.code) {
    case "repoMount.alreadyAttached":
      return `Could not re-attach: ${refusal.folder} is already attached to ${
        refusal.projectName ?? "a chat"
      }`;
    case "repoMount.reattachConflict":
      return refusal.agentName === null
        ? "Could not re-attach while a workflow is running. Stop the run first."
        : `Could not re-attach while ${refusal.agentName} is running. Stop the run first.`;
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
      if (holder.workflowRunId !== undefined) {
        return { code: "repoMount.reattachConflict", agentName: null };
      }
      if (holder.sessionId === undefined || holder.agentId === undefined) {
        return undefined;
      }
      const agentName = await readAgentName(bridge, holder.sessionId, holder.agentId);
      return agentName === undefined
        ? undefined
        : { code: "repoMount.reattachConflict", agentName };
    }
    default:
      return undefined;
  }
}

// The name of one agent of `sessionId`, read off the session's agent list once it arrives.
function readAgentName(
  bridge: PlatformBridge,
  sessionId: string,
  agentId: string,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    let isSettled = false;
    const release = agentListFeedFor(bridge)(heldIdAsWireId<SessionId>(sessionId), (frame) => {
      // One agent alone is no list to name it from; the list or its loss settles the read.
      if (isSettled || frame.kind === "agent") {
        return;
      }
      isSettled = true;
      // The list may arrive while the feed opens, before `release` is assigned.
      queueMicrotask(() => {
        release();
      });
      const state: SessionAgentListState =
        frame.kind === "list"
          ? { status: "served", agents: frame.agents }
          : { status: "failed", refusal: frame.refusal };
      resolve(agentNameOf(state, heldIdAsWireId<AgentId>(agentId)));
    });
  });
}

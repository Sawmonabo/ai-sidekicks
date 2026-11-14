// The `workspace.list` call that finds the session's workspace, the folder on disk the session is
// bound to: the pane layout opens the inspector on its checkout, and the banners name a settings
// file inside its folder from there.

import type { WorkspaceListEntry } from "@ai-sidekicks/contracts/repo/workspace";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { type PaneAddressOf } from "#renderer/routing/panes/address.js";
import { heldIdAsWireId } from "#renderer/services/daemon/wire/identifiers.js";
import { callDaemon, type DaemonReply } from "#renderer/services/daemon/reply.js";
import { type PlatformBridge } from "#renderer/services/platform/bridge.js";

/** The checkout the inspector opens on. */
export type InspectedCheckout = PaneAddressOf<"inspector">["entity"];

/**
 * Reads the session's workspace: the first one ready, else the first not archived; `undefined`
 * when the session is bound to none. Resolves `served` or `refused` and never rejects.
 */
export async function readSessionWorkspace(
  bridge: PlatformBridge,
  sessionId: string,
): Promise<DaemonReply<InspectedCheckout | undefined>> {
  const reply = await readWorkspaceEntry(bridge, sessionId);
  if (reply.status === "refused") {
    return reply;
  }
  const workspace = reply.value;
  return {
    status: "served",
    value: workspace === undefined ? undefined : { kind: "workspace", id: workspace.id },
  };
}

/**
 * Reads the folder the session's workspace works in, picked as {@link readSessionWorkspace} picks
 * it; `undefined` when the session is bound to none or its folder is not made yet. Resolves
 * `served` or `refused` and never rejects.
 */
export async function readSessionFolder(
  bridge: PlatformBridge,
  sessionId: string,
): Promise<DaemonReply<string | undefined>> {
  const reply = await readWorkspaceEntry(bridge, sessionId);
  return reply.status === "refused" ? reply : { status: "served", value: reply.value?.fsRoot };
}

async function readWorkspaceEntry(
  bridge: PlatformBridge,
  sessionId: string,
): Promise<DaemonReply<WorkspaceListEntry | undefined>> {
  const reply = await callDaemon(bridge, "workspace.list", {
    sessionId: heldIdAsWireId<SessionId>(sessionId),
  });
  if (reply.status === "refused") {
    return reply;
  }
  const { workspaces } = reply.value;
  return {
    status: "served",
    value:
      workspaces.find((candidate) => candidate.state === "ready") ??
      workspaces.find((candidate) => candidate.state !== "archived"),
  };
}

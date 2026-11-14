// The `workspace.list` call that finds the session's workspace, the folder on disk the session is
// bound to: the pane layout opens the inspector on its checkout, and the banners name a settings
// file inside its folder from there.

import type { WorkspaceListEntry } from "@ai-sidekicks/contracts/repo/workspace";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { type PaneAddressOf } from "#renderer/routing/panes/address.js";
import { heldIdAsWireId } from "#renderer/services/daemon/wire/identifiers.js";
import {
  callDaemon,
  type DaemonCallOptions,
  type DaemonReply,
} from "#renderer/services/daemon/reply.js";
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
  const reply = await readWorkspaceEntries(bridge, sessionId);
  if (reply.status === "refused") {
    return reply;
  }
  const workspace = pickWorkspace(reply.value);
  return {
    status: "served",
    value: workspace === undefined ? undefined : { kind: "workspace", id: workspace.id },
  };
}

/**
 * Reads the folders the session's workspaces work in: every ready one's, else the one
 * {@link readSessionWorkspace} picks; empty when the session is bound to none or no folder is made
 * yet. Resolves `served` or `refused` and never rejects; `signal` abandons the read.
 */
export async function readSessionFolders(
  bridge: PlatformBridge,
  sessionId: string,
  signal: AbortSignal,
): Promise<DaemonReply<readonly string[]>> {
  const reply = await readWorkspaceEntries(bridge, sessionId, { signal });
  if (reply.status === "refused") {
    return reply;
  }
  const ready = reply.value.filter((candidate) => candidate.state === "ready");
  const picked = pickWorkspace(reply.value);
  const folders = (ready.length > 0 ? ready : picked === undefined ? [] : [picked]).flatMap(
    (workspace) => (workspace.fsRoot === undefined ? [] : [workspace.fsRoot]),
  );
  return { status: "served", value: folders };
}

async function readWorkspaceEntries(
  bridge: PlatformBridge,
  sessionId: string,
  options: DaemonCallOptions = {},
): Promise<DaemonReply<readonly WorkspaceListEntry[]>> {
  const reply = await callDaemon(
    bridge,
    "workspace.list",
    { sessionId: heldIdAsWireId<SessionId>(sessionId) },
    options,
  );
  return reply.status === "refused" ? reply : { status: "served", value: reply.value.workspaces };
}

function pickWorkspace(workspaces: readonly WorkspaceListEntry[]): WorkspaceListEntry | undefined {
  return (
    workspaces.find((candidate) => candidate.state === "ready") ??
    workspaces.find((candidate) => candidate.state !== "archived")
  );
}

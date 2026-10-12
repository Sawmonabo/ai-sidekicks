// The `repo.workspaceList` call the pane layout makes to find the checkout the inspector opens on:
// the session's workspace, the folder on disk the session is bound to.

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
  const reply = await callDaemon(bridge, "repo.workspaceList", {
    sessionId: heldIdAsWireId(sessionId),
  });
  if (reply.status === "refused") {
    return reply;
  }
  const { workspaces } = reply.value;
  const workspace =
    workspaces.find((candidate) => candidate.state === "ready") ??
    workspaces.find((candidate) => candidate.state !== "archived");
  return {
    status: "served",
    value: workspace === undefined ? undefined : { kind: "workspace", id: workspace.id },
  };
}

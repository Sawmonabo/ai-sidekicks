// What every composer suite shares: a transport nothing calls through, and the pane address a
// composer is pointed at when it addresses one agent.

import type { PlatformBridge } from "#renderer/services/platform/platform-bridge.js";
import type { PaneAddress } from "#renderer/routing/panes/pane-address.js";
import { bridgeAnswering } from "#test/helpers/fixture/bridge.js";

/** A bridge that answers every call with nothing, for held state that only needs a transport. */
export function inertBridge(): PlatformBridge {
  return bridgeAnswering(async () => undefined).bridge;
}

/** The pane address focused on one agent. */
export function agentPane(agentId: string): PaneAddress {
  return { kind: "agents", entity: { kind: "agent", id: agentId } };
}

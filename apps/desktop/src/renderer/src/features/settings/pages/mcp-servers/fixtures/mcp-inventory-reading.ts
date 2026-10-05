// The inventory read the MCP fixture body is built on: one reply, three refresh signals.
//
// One unified read across both providers and every scope, as the daemon already decided that
// `(claude, user, filesystem)` and `(codex, project, …, filesystem)` are two rows. It refreshes
// on live status (the subscription passed in), window focus (installed beside the read by the
// component that owns its lifetime) and reconnect (the console's transport signal). There is no
// timer: the live-status subscription is the update channel.

import type { Clock } from "#renderer/lib/clock.js";
import type { Unsubscribe } from "#shared/preload-api.js";
import type { McpServerInventoryEntry } from "@ai-sidekicks/contracts/mcp/mcp";
import { PushDrivenRead } from "#renderer/store/reads/push-driven-read.js";

/** Names this read in a refusal, so a failure says which read failed. */
export const MCP_INVENTORY_READ_ORIGIN = "mcp-servers";

/** What the inventory read answers with. */
export interface McpInventory {
  readonly servers: readonly McpServerInventoryEntry[];
}

/** The read the MCP fixture body is built on. */
export type McpInventoryRead = PushDrivenRead<McpInventory>;

/**
 * Asks the daemon for the unified inventory. The signal aborts when a newer read supersedes this
 * one or the read is disposed.
 */
export type ListMcpInventory = (signal: AbortSignal) => Promise<McpInventory>;

/** Opens the daemon's live-status subscription; the callback fires when a status changed. */
export type SubscribeMcpInventoryChanges = (onChange: () => void) => Unsubscribe;

/**
 * Build the inventory read, constructed by whoever owns its lifetime (the fixture body's mount
 * effect, never a render body) and disposed with that owner.
 */
export function createMcpInventoryRead(options: {
  readonly listInventory: ListMcpInventory;
  readonly subscribeInventoryChanges: SubscribeMcpInventoryChanges;
  readonly clock: Clock;
}): McpInventoryRead {
  const { listInventory, subscribeInventoryChanges, clock } = options;
  return new PushDrivenRead<McpInventory>({
    clock,
    origin: MCP_INVENTORY_READ_ORIGIN,
    // `refresh` is not sent: it means "re-probe now", an act somebody must ask for, and sending
    // it on every focus would spend a probe per window switch.
    read: listInventory,
    subscribe: subscribeInventoryChanges,
  });
}

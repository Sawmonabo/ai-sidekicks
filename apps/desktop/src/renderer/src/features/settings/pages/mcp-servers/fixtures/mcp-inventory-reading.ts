// The inventory read the MCP shell is built on: one reply, three refresh signals.
//
// ONE READ, AND IT IS THE UNIFIED ONE. The governing surface reads a single unified
// inventory across both providers and every scope, so a page that read per provider
// would produce two arrival orders for one list and would have to decide, itself, how
// a `(claude, user, filesystem)` row and a `(codex, project, …, filesystem)` row
// relate. The daemon already decided that: they are two rows.
//
// WHICH SIGNALS REFRESH IT.
//
//   • **Live status** — the subscription handed in as an argument.
//   • **Focus** — installed beside the read by the component that owns its lifetime.
//   • **Reconnect** — the console's one transport signal, off `ConsoleBridge`.
//
// There is deliberately no timer: the live-status subscription is the update channel,
// so nothing above the daemon polls.

import type { Clock } from "@renderer/lib/clock.js";
import type { Unsubscribe } from "@renderer/lib/emitter.js";
import type { McpServerInventoryEntry } from "@ai-sidekicks/contracts";
import { PushDrivenRead } from "@renderer/console/seats/index.js";

/** Names this read in a refusal, so a failure says which read failed. */
export const MCP_INVENTORY_READ_ORIGIN = "mcp-servers";

/** What the inventory read answers with. */
export interface McpInventory {
  readonly servers: readonly McpServerInventoryEntry[];
}

/** The read the MCP shell is built on. */
export type McpInventoryRead = PushDrivenRead<McpInventory>;

/** Asks the daemon for the unified inventory. */
export type ListMcpInventory = () => Promise<McpInventory>;

/** Opens the daemon's live-status subscription; the callback fires when a status changed. */
export type SubscribeMcpInventoryChanges = (onChange: () => void) => Unsubscribe;

/**
 * Build the inventory read.
 *
 * Constructed by whoever owns its lifetime — the shell's mount effect, never a render
 * body — and disposed with that owner.
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
    // `refresh` is deliberately not sent. The registered request carries it and it
    // means "re-probe now", which is an act somebody has to ask for — a page that sent
    // it on every focus would spend a probe per window switch.
    read: listInventory,
    subscribe: subscribeInventoryChanges,
  });
}

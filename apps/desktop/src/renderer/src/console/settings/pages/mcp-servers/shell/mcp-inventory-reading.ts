// The inventory read the MCP shell is built on: one reply, two refresh signals.
//
// ONE READ, AND IT IS THE UNIFIED ONE. The governing surface reads a single unified
// inventory across both providers and every scope, so a page that read per provider
// would produce two arrival orders for one list and would have to decide, itself, how
// a `(claude, user, filesystem)` row and a `(codex, project, …, filesystem)` row
// relate. The daemon already decided that: they are two rows.
//
// WHICH SIGNALS REFRESH IT.
//
//   • **Focus** — installed beside the read by the component that owns its lifetime.
//   • **Reconnect** — the console's one transport signal, off `ConsoleBridge`.
//
// There is deliberately no timer. The governing section takes the live-status
// subscription as its update channel precisely so nothing above the daemon polls, and
// an interval here would reintroduce above it exactly what it forbids below.
//
// AND THE SUBSCRIPTION IS DELIBERATELY NOT BOUND. `mcp.subscribe` is registered and
// this console does not serve it: it is one of the eight operations the owning page
// body brings with it, and a shell that faked a live channel would be claiming a
// freshness it does not have. What this shell does instead is honest and smaller — it
// re-reads after its own mutations, and on focus and reconnect — and the seat next
// door records the subscription as the mount's obligation.

import type { ConsoleBridge, GrowthMcpInventoryEntry } from "../../../../bridge/index.js";
import type { ConsoleClock, Unsubscribe } from "../../../../core/index.js";
import { PushDrivenRead, servedGrowthValueOrRaise } from "../../../../seats/index.js";

/** Names this read in a refusal, so a failure says which read failed. */
export const MCP_INVENTORY_READ_ORIGIN = "mcp-servers";

/** What the inventory read answers with. */
export interface McpInventory {
  readonly servers: readonly GrowthMcpInventoryEntry[];
}

/** The read the MCP shell is built on. */
export type McpInventoryRead = PushDrivenRead<McpInventory>;

/**
 * Build the inventory read.
 *
 * Constructed by whoever owns its lifetime — the shell's mount effect, never a render
 * body — and disposed with that owner.
 *
 * IT GOES THROUGH THE GROWTH PORT AND NOT THE BOUND-CALL DOOR. No `mcp.*` method is
 * bound on the preload bridge and `packages/contracts` publishes no MCP module at all,
 * so this whole namespace is a registered wire the console does not yet have — which
 * is what the growth slate row records and what makes this read a fixture read rather
 * than a live one.
 */
export function createMcpInventoryRead(options: {
  readonly bridge: ConsoleBridge;
  readonly clock: ConsoleClock;
}): McpInventoryRead {
  const { bridge, clock } = options;
  return new PushDrivenRead<McpInventory>({
    clock,
    origin: MCP_INVENTORY_READ_ORIGIN,
    // `refresh` is deliberately not sent. The registered request carries it and it
    // means "re-probe now", which is an act somebody has to ask for — a page that sent
    // it on every focus would spend a probe per window switch.
    read: async () => servedGrowthValueOrRaise(await bridge.growth.mcpList({})),
    subscribe: noLiveStatusBoundHere,
  });
}

/**
 * The subscribe for a read whose live channel this shell does not open, named rather
 * than left as an empty function at the call site.
 *
 * It opens nothing and returns an unsubscribe that closes nothing, so the honest fact
 * has a name where a reader meets it: the governing surface HAS a live status channel
 * and this shell is not the thing that owns it.
 */
function noLiveStatusBoundHere(): Unsubscribe {
  return () => undefined;
}

// The MCP governance plane: the inventory read, and the two mutations the operator
// page sends.
//
// One plane of `GrowthOperationSignatures`, composed into it by `index.ts`.
//
// WHY THREE AND NOT ELEVEN. The registered plane carries eleven operations, and this
// table names the three the console's own surface calls: the inventory read it is
// built on, the enablement mutation, and the trust mutation. The other eight —
// upsert, remove, the two override verbs, OAuth login, reconnect, the per-binding get,
// and the live-status subscription — are the owning plan's to serve from the page it
// mounts here, and a signature registered ahead of its caller is a wire minted for
// nobody. Each is registered in the corpus and reachable by widening this table when
// its caller exists, which is what the slate row records.
//
// EVERY MUTATION CARRIES `clientIdempotencyKey` AND THE CONSOLE MINTS IT. That is the
// registered discipline for every governance mutation, and it is on the request rather
// than composed inside the port for the reason the whole port exists: the value is the
// CALLER's, a retry of one operator press must reuse it, and a port that minted one
// per call would make every retry a new operation.
//
// AND `mcp.reconnect` IS THE ONE THAT WOULD NOT CARRY ONE, which is why its absence
// from this table is not an oversight to be fixed by symmetry: it is unreceipted at
// the daemon, so a key on it would describe a replay that does not exist.

import type {
  GrowthMcpBindingRef,
  GrowthMcpInventoryEntry,
  GrowthMcpMutationResult,
} from "../growth-values/index.js";

export interface McpGrowthSignatures {
  // `refresh` is optional on the wire and the page never sends it. Stated anyway
  // because the registered request carries it: a member absent from this table is a
  // member a later caller would add without noticing the wire already has one, and
  // the page's own read is the ordinary one — what the daemon last observed, never a
  // re-probe a person did not ask for.
  mcpList: {
    request: { readonly refresh?: boolean };
    value: { readonly servers: readonly GrowthMcpInventoryEntry[] };
  };
  mcpSetEnabled: {
    request: GrowthMcpBindingRef & {
      readonly clientIdempotencyKey: string;
      readonly enabled: boolean;
    };
    value: GrowthMcpMutationResult;
  };
  // The trust mutation's own reply is narrower than the shared result: the registered
  // shape fixes `applied` at `daemon_enforced`, because a trust grant binds at the
  // daemon and reaches no provider config. The value is the shared one all the same,
  // so a page reading `applied` reads one member however it was reached — narrowing
  // here would make the two mutations two shapes for one render.
  mcpSetTrust: {
    request: GrowthMcpBindingRef & {
      readonly clientIdempotencyKey: string;
      readonly trusted: boolean;
    };
    value: GrowthMcpMutationResult;
  };
}

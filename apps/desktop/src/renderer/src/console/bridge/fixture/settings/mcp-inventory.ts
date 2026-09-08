// What the MCP inventory reads as AFTER a governance mutation the operator sent.
//
// A SCRIPT ANSWERS ONE CALL WITH ONE VALUE, and for the governance plane that is not
// enough on its own. `mcp.list`, `mcp.setEnabled`, and `mcp.setTrust` are three rows in
// one reply table, so a scenario disabling a binding answered the mutation with the row
// at `enabled: false` and then answered the very next inventory read with the row the
// scenario declared — the one at `enabled: true`. The page rendered the mutation's own
// "Applied" outcome beside a grid that had put the control back where it started, which
// is the fixture reporting that the daemon did the work and then undid it.
//
// THE SCENARIO'S REPLY TABLE IS NOT THE PLACE TO FIX IT. `ScenarioComputedReply` reads
// the caller's request and is required to be a computation with no state and no
// mutation, because that is what keeps a scenario replayable tick-for-tick on the
// frozen clock. A ledger is exactly the state that rule forbids there — so it lives on
// the PORT, which is built once per running scenario, and the scenario stays the data
// it is.
//
// IT SUBSTITUTES AND NEVER INVENTS. The scripted inventory is still the whole of what
// this fixture knows: the rows, their order, and the arms they exercise are the
// scenario's. What this holds is the narrower fact that a mutation already answered —
// the row as it now stands — and the read serves that row in the scripted row's place.
// A mutation naming a binding the inventory does not carry therefore adds nothing: the
// fixture would be minting a binding no author ever declared, which is the same
// invention `answerScriptOnly` refuses a synthesized receipt for (that helper lives in
// `growth/scripted-answer.ts`, which every plane that takes it reaches).
//
// AND IT IS PER PORT, never a module-level register. Two windows on one build hold two
// scenario engines and two ports, and a shared ledger would put one window's disable on
// the other's grid — which is a state no daemon can produce, since the two are reading
// different nodes.

import {
  mcpBindingKeyOf,
  type GrowthMcpInventoryEntry,
  type GrowthMcpMutationResult,
} from "../../growth-values/index.js";

/** What the inventory read answers with, as the registered signature declares it. */
interface McpInventoryReading {
  readonly servers: readonly GrowthMcpInventoryEntry[];
}

/**
 * The rows this port's governance mutations have already replaced, keyed by binding.
 *
 * One instance per {@link import("./mcp-governance.js").fixtureMcpGovernance}
 * call, held by that plane's own closure. Its size is bounded by the number of DISTINCT
 * bindings a scenario's mutations answer for, which is bounded by the scripted
 * inventory: a key that matches no scripted row is never read back.
 */
export class FixtureMcpInventoryLedger {
  readonly #replacedRowsByBinding = new Map<string, GrowthMcpInventoryEntry>();

  /**
   * Record what a mutation answered, and hand the answer straight back.
   *
   * A pass-through rather than a `void` recorder, so the call site reads as the one
   * act it is — the port answers with the mutation's own result, and the ledger's
   * recording is not a second statement a later edit can drop while the reply still
   * looks correct.
   *
   * The row it records is the mutation's `server`, which the registered result defines
   * as the binding AS IT NOW STANDS. The fixture derives nothing from `enabled` or
   * `trusted` itself: applying a mutation is the daemon's job, and a fixture that
   * recomputed the row would be a second implementation of a rule the scenario already
   * states in the reply it authored.
   */
  public recordMutation(result: GrowthMcpMutationResult): GrowthMcpMutationResult {
    this.#replacedRowsByBinding.set(mcpBindingKeyOf(result.server), result.server);
    return result;
  }

  /**
   * The scripted inventory with every already-mutated row standing in its own place.
   *
   * Order is the SCRIPT's — the grid shows the rows in the order the scenario declares
   * — so a substitution never moves a row, and a reader watching one control cannot
   * have a different binding slide under it.
   */
  public inventoryOver(scripted: McpInventoryReading): McpInventoryReading {
    return {
      servers: scripted.servers.map(
        (scriptedRow) =>
          this.#replacedRowsByBinding.get(mcpBindingKeyOf(scriptedRow)) ?? scriptedRow,
      ),
    };
  }
}

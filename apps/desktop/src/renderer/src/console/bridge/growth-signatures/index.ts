// What every growth operation TAKES and GIVES BACK: the signature table, and this
// file is its door.
//
// This is the half of the port that changes when a wire is registered. A row landing
// adds an operation to one of the plane modules beside this one — a request shape, a
// reply shape, sometimes a new named value beside them — and the two producers next
// door in `growth-port.ts` do not move: the mapped type derives one method per
// operation from this table, and the refusing port's body is one line per id.
//
// WHAT IS NOT HERE. The mapped type, the refusal builder, and the refusing port
// (`growth-port.ts`), because those are one construction over whatever this table
// says. What a call ANSWERS with (`growth-outcome.ts`), because a surface narrowing
// a result should not have to reach for the table it will never read. And the named
// reply values (`growth-values/`), because several have readers this table does
// not — the fixture port constructs one and the family barrel publishes it — and a
// table interrupted by the declarations of the things it refers to stops reading as
// a table.
//
// The request and value types are the CONSOLE's, derived from what its surfaces
// need — not a claim about the eventual wire shape, which belongs to the owning
// document named on the operation's slate row. Where a shape is genuinely unknown to
// the console it is stated as a named empty request rather than `unknown`, so a
// caller that starts passing something has to come here and say what.
//
// WHERE THIS TABLE MEETS THE REGISTERED-WIRE ONE, AND WHY THEY ARE TWO. A method the
// corpus HAS registered is not a growth operation and has no row here: it is bound to
// its published request and response schemas in `daemon-reply-registry.ts` and
// reached through `callDaemon`, which parses both directions. The split is not
// duplication — it is the difference between narrowing an `unknown` a real wire sent
// and standing in for a wire that does not exist. This table's types are the
// console's own because no published shape exists to derive them from; that
// registry's types are the contract's because one does, and inventing them here
// instead would put a fiction in front of the parse. A slate row landing is the only
// crossing: its operations leave this table, join that registry, and their callers
// move from `bridge.growth.<operation>(…)` to `callDaemon(bridge, "<method>", …)`.
//
// ONE MODULE PER WIRE PLANE, AND THE SET STAYS CLOSED. The table used to be one
// module, and its length was its row count — one entry per wire the console does not
// yet have, growing with every lane that added one until it was past the ~400-line
// rule `apps/desktop/AGENTS.md` sets. What that file's own header argued was that
// splitting it would split one closed set across two files, so a member that landed
// in neither half would become a silently absent one. That is true of two SEPARATE
// tables and false of the composition below: `GrowthOperationSignatures` is one
// interface that EXTENDS every plane's, so `keyof` still names every member, and
// `growth-port.ts` — which maps over `GrowthOperationId` and indexes this type per
// id — still fails to compile the moment an id has no member. The set is closed by
// the same mechanism it always was, and the seam runs where the rows already grouped
// themselves: this directory takes the plane modules on the `growth-values/`
// precedent, and each keeps the section comment the single file carried.
//
// A SUB-MODULE DOOR, NOT A SECOND FAMILY DOOR. `growth-signatures/` is a sub-module
// of `bridge/`: it publishes to the bridge's own modules and is reached by deep,
// intra-family specifiers, so `bridge/index.ts` remains the single door the rest of
// the console comes through.

import type { AgentGrowthSignatures } from "./agents.js";
import type { ArtifactGrowthSignatures } from "./artifacts.js";
import type { AttentionGrowthSignatures } from "./attention.js";
import type { GitflowGrowthSignatures } from "./gitflow.js";
import type { IdentityGrowthSignatures } from "./identity.js";
import type { LedgerGrowthSignatures } from "./ledger.js";
import type { PaneGrowthSignatures } from "./panes.js";
import type { SessionGrowthSignatures } from "./sessions.js";
import type { SidekickGrowthSignatures } from "./sidekicks.js";
import type { WorkflowGrowthSignatures } from "./workflows.js";

/**
 * Every growth operation's request and value, as one interface.
 *
 * Extension rather than intersection, and rather than a union of the plane types:
 * an interface that extends them all is a single named type whose `keyof` is the
 * whole id set, which is what `growth-port.ts` maps over. A member declared twice
 * with two different shapes is a compile error here rather than a silent override,
 * so the planes cannot quietly disagree about one operation.
 */
export interface GrowthOperationSignatures
  extends
    PaneGrowthSignatures,
    SessionGrowthSignatures,
    GitflowGrowthSignatures,
    ArtifactGrowthSignatures,
    AttentionGrowthSignatures,
    WorkflowGrowthSignatures,
    IdentityGrowthSignatures,
    SidekickGrowthSignatures,
    AgentGrowthSignatures,
    LedgerGrowthSignatures {}

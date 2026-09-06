// The composed signature table: one interface over every plane in this directory.
//
// It is declared HERE rather than in this directory's own `index.ts` because
// `bridge/index.ts` publishes it to the one view family that reads it, and a family
// door re-exporting through a second `index.ts` is the barrel chain
// `console-no-barrel-chain` fails. A door re-exports from the module that DECLARES a
// symbol, so the declaration lives in a module and the door beside it re-exports it.
//
// WHY THE PLANES ARE SEPARATE MODULES and how the set stays closed is the header of
// `index.ts`, which is where a reader arriving at the directory meets it.

import type { AgentGrowthSignatures } from "./agents.js";
import type { ApprovalGrowthSignatures } from "./approvals.js";
import type { ArtifactGrowthSignatures } from "./artifacts.js";
import type { AttentionGrowthSignatures } from "./attention.js";
import type { ChannelGrowthSignatures } from "./channels.js";
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
    AgentGrowthSignatures,
    ApprovalGrowthSignatures,
    SidekickGrowthSignatures,
    LedgerGrowthSignatures,
    ChannelGrowthSignatures {}

// The callable half of the growth ledger: one entry per eventual bridge method or
// subscription, each naming the slate row it serves. This file is its door.
//
// `Plan-023 §Console growth slate` names the wires the console builds against and
// does not yet have. Those rows are not methods — one bundles a whole namespace
// plus two settings plus a pane-kind declaration — so the ledger is keyed by
// OPERATION rather than by row, and this table is the operation half of that key
// space. The non-callable rest lives in `growth-prerequisites.ts`, and the two are
// separate modules because they are separate closed sets with separate readers:
// every row here has a port method behind it and supplies that method's refusal its
// slate-row attribution, while a prerequisite row is only ever audited.
//
// WHY A TABLE AND NOT A LIST. The entry a caller reaches for is always reached by
// id, and the compiler — not a reviewer — is what should guarantee a new id gets an
// entry. A `Record` keyed by `GrowthOperationId` makes a missing entry and an
// unknown key both compile errors; an array beside the union would make neither.
//
// ONE MODULE PER WIRE PLANE, AND THE RECORD IS STILL EXHAUSTIVE. The table used to
// be one module holding every wire plane at once — one entry per wire the console
// does not yet have, growing with every lane that added one until the planes were
// plainly the seam it should have split on. What that file's own header argued
// was that splitting the record would lose the exhaustiveness the
// `Record<GrowthOperationId, …>` annotation is there to get. It does not, because
// the annotation stays HERE: the composition below is one object literal typed as
// that same exhaustive record, so an id no plane declares is a compile error at this
// spread exactly as it was at the single literal. Each plane carries the other half:
// its own annotation is an exhaustive record over the ids `Extract`ed from the union
// by that plane's name pattern, so a plane that drops one of its own rows fails in
// the plane, and a key that is not an operation id fails there too. An id whose name
// matches no plane's pattern fails at the spread, and is fixed by widening one
// plane's pattern — which is the act of saying which plane the new wire belongs to.
//
// WHAT THE SPLIT DOES COST, AND WHAT PAYS IT. A duplicate key inside one object
// literal is a compile error; the same key in two planes is a silent override by the
// later spread. That is the one property the single file had and the composition
// does not, so `index.test.ts` buys it back by counting: the planes' key sets are
// asserted pairwise disjoint, and their sizes are asserted to sum to the composed
// table's. A row copied into a second plane fails there rather than in a surface.
//
// A SUB-MODULE DOOR, NOT A SECOND FAMILY DOOR. `growth-operations/` is a sub-module
// of `bridge/`: it publishes to the bridge's own modules and is reached by deep,
// intra-family specifiers, so `bridge/index.ts` remains the single door the rest of
// the console comes through.
//
// AND EACH PLANE DECLARES ITS ROWS TWICE OVER, SPLIT BY CONSUMER. A plane holds its
// entry table and, beside it, `<PLANE>_GROWTH_OPERATION_SUMMARIES` — the sentence
// describing each of its operations, keyed by the same closed id set. The rule is the
// one `growth-slate-consumers.ts` states for the slate's own `consumingSurface`: a
// running console reads exactly one member of a row, `slateRow`, which is what
// `growth-refusals.ts` attributes a refusal by, and it never reads a sentence — those
// are written for a reader of `Plan-023 §Console growth slate`, and the check beside
// each table is their only mechanical reader. This table is reached from the bridge
// door on every launch, so a sentence carried on a row was prose on the document every
// session downloads; declared apart and referenced by nothing a release build
// evaluates, the literals leave that document. Measured: 145 sentences, 15,395 raw
// bytes off the release renderer's initial graph.
//
// WHICH IS WHY THE COMPOSITION BELOW IS A FUNCTION. `scenario-manifest.ts` records the
// bundler property it turns on: a top-level initializer that CALLS anything is not
// provably pure, so a composed `const` would be retained however few readers it has —
// and retaining it would retain all eighteen literals it spreads. A function body is
// evaluated only when it is called, and an unreferenced function declaration is
// dropped whether or not its body is pure.

import type { GrowthOperationEntry, GrowthOperationId } from "../growth-port/growth-entry.js";
import { AGENT_GROWTH_OPERATIONS, AGENT_GROWTH_OPERATION_SUMMARIES } from "./agents.js";
import { APPROVAL_GROWTH_OPERATIONS, APPROVAL_GROWTH_OPERATION_SUMMARIES } from "./approvals.js";
import { ARTIFACT_GROWTH_OPERATIONS, ARTIFACT_GROWTH_OPERATION_SUMMARIES } from "./artifacts.js";
import { ATTENTION_GROWTH_OPERATIONS, ATTENTION_GROWTH_OPERATION_SUMMARIES } from "./attention.js";
import { CHANNEL_GROWTH_OPERATIONS, CHANNEL_GROWTH_OPERATION_SUMMARIES } from "./channels.js";
import {
  DIAGNOSTICS_GROWTH_OPERATIONS,
  DIAGNOSTICS_GROWTH_OPERATION_SUMMARIES,
} from "./diagnostics.js";
import { GITFLOW_GROWTH_OPERATIONS, GITFLOW_GROWTH_OPERATION_SUMMARIES } from "./gitflow.js";
import { IDENTITY_GROWTH_OPERATIONS, IDENTITY_GROWTH_OPERATION_SUMMARIES } from "./identity.js";
import { INVITE_GROWTH_OPERATIONS, INVITE_GROWTH_OPERATION_SUMMARIES } from "./invites.js";
import { LEDGER_GROWTH_OPERATIONS, LEDGER_GROWTH_OPERATION_SUMMARIES } from "./ledger.js";
import { MCP_GROWTH_OPERATIONS, MCP_GROWTH_OPERATION_SUMMARIES } from "./mcp.js";
import { PANE_GROWTH_OPERATIONS, PANE_GROWTH_OPERATION_SUMMARIES } from "./panes.js";
import { PRESENCE_GROWTH_OPERATIONS, PRESENCE_GROWTH_OPERATION_SUMMARIES } from "./presence.js";
import {
  PROVIDER_ACCOUNT_GROWTH_OPERATIONS,
  PROVIDER_ACCOUNT_GROWTH_OPERATION_SUMMARIES,
} from "./provider-accounts.js";
import {
  RUN_RECORD_GROWTH_OPERATIONS,
  RUN_RECORD_GROWTH_OPERATION_SUMMARIES,
} from "./run-records.js";
import { SESSION_GROWTH_OPERATIONS, SESSION_GROWTH_OPERATION_SUMMARIES } from "./sessions.js";
import { SIDEKICK_GROWTH_OPERATIONS, SIDEKICK_GROWTH_OPERATION_SUMMARIES } from "./sidekicks.js";
import { WORKFLOW_GROWTH_OPERATIONS, WORKFLOW_GROWTH_OPERATION_SUMMARIES } from "./workflows.js";

/**
 * Every plane's rows, in the order the single table carried them.
 *
 * Exported for `index.test.ts`, which is what makes the disjointness and the census
 * checkable at all: a test that re-listed the planes here would be asserting against
 * its own copy of the set rather than against the one the table is built from.
 */
export const GROWTH_OPERATION_PLANES: readonly Readonly<
  Partial<Record<GrowthOperationId, GrowthOperationEntry>>
>[] = [
  PANE_GROWTH_OPERATIONS,
  SESSION_GROWTH_OPERATIONS,
  GITFLOW_GROWTH_OPERATIONS,
  ARTIFACT_GROWTH_OPERATIONS,
  ATTENTION_GROWTH_OPERATIONS,
  WORKFLOW_GROWTH_OPERATIONS,
  IDENTITY_GROWTH_OPERATIONS,
  AGENT_GROWTH_OPERATIONS,
  APPROVAL_GROWTH_OPERATIONS,
  SIDEKICK_GROWTH_OPERATIONS,
  LEDGER_GROWTH_OPERATIONS,
  DIAGNOSTICS_GROWTH_OPERATIONS,
  PROVIDER_ACCOUNT_GROWTH_OPERATIONS,
  MCP_GROWTH_OPERATIONS,
  CHANNEL_GROWTH_OPERATIONS,
  PRESENCE_GROWTH_OPERATIONS,
  INVITE_GROWTH_OPERATIONS,
  RUN_RECORD_GROWTH_OPERATIONS,
];

/**
 * Every operation, keyed by id. Typed as an exhaustive record so the compiler — not
 * a reviewer — is what guarantees a new id gets an entry.
 */
export const GROWTH_OPERATIONS: Readonly<Record<GrowthOperationId, GrowthOperationEntry>> = {
  ...PANE_GROWTH_OPERATIONS,
  ...SESSION_GROWTH_OPERATIONS,
  ...GITFLOW_GROWTH_OPERATIONS,
  ...ARTIFACT_GROWTH_OPERATIONS,
  ...ATTENTION_GROWTH_OPERATIONS,
  ...WORKFLOW_GROWTH_OPERATIONS,
  ...IDENTITY_GROWTH_OPERATIONS,
  ...AGENT_GROWTH_OPERATIONS,
  ...APPROVAL_GROWTH_OPERATIONS,
  ...SIDEKICK_GROWTH_OPERATIONS,
  ...AGENT_GROWTH_OPERATIONS,
  ...LEDGER_GROWTH_OPERATIONS,
  ...DIAGNOSTICS_GROWTH_OPERATIONS,
  ...PROVIDER_ACCOUNT_GROWTH_OPERATIONS,
  ...MCP_GROWTH_OPERATIONS,
  ...CHANNEL_GROWTH_OPERATIONS,
  ...PRESENCE_GROWTH_OPERATIONS,
  ...INVITE_GROWTH_OPERATIONS,
  ...RUN_RECORD_GROWTH_OPERATIONS,
};

/**
 * Every operation's sentence, keyed by id.
 *
 * A FUNCTION AND NEVER A MODULE-LEVEL CONSTANT, for the bundler reason the header
 * states and `scenario-manifest.ts` records in full. Its readers are the check beside
 * this table and any later reader of the ledger written for a person; a release build
 * calls it from nowhere, which is what leaves all eighteen literals off the graph.
 *
 * Typed as an exhaustive record over the same id union `GROWTH_OPERATIONS` is, so an
 * operation whose plane gave it a row and no sentence is a compile error here — the
 * same pairing the table above gets, applied to the half that left the row.
 */
export function growthOperationSummaries(): Readonly<Record<GrowthOperationId, string>> {
  return {
    ...PANE_GROWTH_OPERATION_SUMMARIES,
    ...SESSION_GROWTH_OPERATION_SUMMARIES,
    ...GITFLOW_GROWTH_OPERATION_SUMMARIES,
    ...ARTIFACT_GROWTH_OPERATION_SUMMARIES,
    ...ATTENTION_GROWTH_OPERATION_SUMMARIES,
    ...WORKFLOW_GROWTH_OPERATION_SUMMARIES,
    ...IDENTITY_GROWTH_OPERATION_SUMMARIES,
    ...AGENT_GROWTH_OPERATION_SUMMARIES,
    ...APPROVAL_GROWTH_OPERATION_SUMMARIES,
    ...SIDEKICK_GROWTH_OPERATION_SUMMARIES,
    ...LEDGER_GROWTH_OPERATION_SUMMARIES,
    ...DIAGNOSTICS_GROWTH_OPERATION_SUMMARIES,
    ...PROVIDER_ACCOUNT_GROWTH_OPERATION_SUMMARIES,
    ...MCP_GROWTH_OPERATION_SUMMARIES,
    ...CHANNEL_GROWTH_OPERATION_SUMMARIES,
    ...PRESENCE_GROWTH_OPERATION_SUMMARIES,
    ...INVITE_GROWTH_OPERATION_SUMMARIES,
    ...RUN_RECORD_GROWTH_OPERATION_SUMMARIES,
  };
}

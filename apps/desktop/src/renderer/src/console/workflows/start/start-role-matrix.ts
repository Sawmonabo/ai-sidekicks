// Who may start a workflow, and the one refusal code that says somebody may not.
//
// THE MATRIX IS PUBLIC SURFACE. `Spec-017 §Chat-start surface (SA-38)` fixes the four
// session roles and which two of them may start a run, and showing it beside a denial
// leaks nothing a person could not read in the product's own documentation — while
// withholding it leaves an operator staring at a refusal with no way to learn what would
// have satisfied it.
//
// IT IS A READING AND NEVER A PREDICATE. Nothing in this console consults these rows
// before dispatching a start: the daemon adjudicates, and a renderer that pre-empted the
// answer would be a second authority on it — offering a control it thought would work and
// hiding one it thought would not, both of them guesses. So the rows are rendered ONLY
// beside a refusal the daemon already gave, and no code anywhere branches on them.
//
// THE ROLES ARE THE CONTRACT'S AND ARE NEVER RE-SPELLED HERE. `MembershipRole` in
// `@ai-sidekicks/contracts` declares the closed set — including the space in "runtime
// contributor", which is the wire form — and the permission table below is a mapping
// that is TOTAL over it. That totality is the whole mechanism: a role the contract gains,
// renames or drops fails to COMPILE here, where a hand-kept list of four `role: string`
// rows would have gone on compiling beside a denial explaining a rule with a row missing
// from it, and the self-authored test would have gone on passing with it.
//
// THE ORDER IS THE READING, AND IT COMES OFF THE TABLE'S OWN KEYS. The two who may start
// are declared first, so the boundary between them and the two who may not is one line
// rather than something to scan for; object key order is insertion order for non-numeric
// string keys, so the declaration below IS that order and the closed set stays declared
// exactly once.
//
// THE CODE IS A CONSTANT BECAUSE TWO SURFACES COMPARE AGAINST IT. The refusal render here
// and its test both name it, and a literal spelled twice is one typo away from a matrix
// that never appears.

import type { MembershipRole } from "@ai-sidekicks/contracts";

/** The wire code a denied start refuses with. */
export const WORKFLOW_START_DENIED_CODE = "workflow.start_denied";

/** One session role and whether it may start a run. */
export interface WorkflowStartRoleRow {
  readonly role: MembershipRole;
  readonly mayStart: boolean;
}

/**
 * Whether each of the contract's roles may start a run, in the order they are read.
 *
 * A `Record` keyed by the wire union rather than an array of pairs: the record is
 * exhaustive by construction, so this table cannot fall behind the contract, and a role
 * the contract does not declare cannot be written into it either.
 */
const WORKFLOW_START_PERMISSION: Readonly<Record<MembershipRole, boolean>> = {
  owner: true,
  collaborator: true,
  "runtime contributor": false,
  viewer: false,
};

/**
 * The roles and their permission, as the denial renders them.
 *
 * Derived from the table above rather than written a second time — the assertion on
 * `Object.keys` is sound because that table's own type fixes its keys to exactly
 * `MembershipRole`, which is the same reason the roster's vocabulary is read off its
 * notes table rather than restated beside it.
 */
export const WORKFLOW_START_ROLE_MATRIX: readonly WorkflowStartRoleRow[] = (
  Object.keys(WORKFLOW_START_PERMISSION) as readonly MembershipRole[]
).map((role) => ({ role, mayStart: WORKFLOW_START_PERMISSION[role] }));

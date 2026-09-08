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
// THE CODE IS A CONSTANT BECAUSE TWO SURFACES COMPARE AGAINST IT. The refusal render here
// and its test both name it, and a literal spelled twice is one typo away from a matrix
// that never appears.

/** The wire code a denied start refuses with. */
export const WORKFLOW_START_DENIED_CODE = "workflow.start_denied";

/** One session role and whether it may start a run. */
export interface WorkflowStartRoleRow {
  readonly role: string;
  readonly mayStart: boolean;
}

/**
 * The four roles, in the order the corpus states them.
 *
 * Ordered rather than sorted, because the order is the reading: the two who may start
 * come first, so the boundary between them and the two who may not is one line rather
 * than something to scan for.
 */
export const WORKFLOW_START_ROLE_MATRIX: readonly WorkflowStartRoleRow[] = [
  { role: "owner", mayStart: true },
  { role: "collaborator", mayStart: true },
  { role: "runtime contributor", mayStart: false },
  { role: "viewer", mayStart: false },
];

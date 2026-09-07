// The independent variables a termination decision reads, as a vocabulary.
//
// The role split `termination-failure-matrix.test.ts` was carved into: this
// module is the AXES, `termination-matrix-tools.test-support.ts` is the scripted
// platform, `termination-matrix-catalog.test-support.ts` is the table, and the
// suite itself is the assertion. They were one file, and the assertions began
// after five hundred lines of setup — which is a file doing four jobs, and the
// one job a reader opens it for was the last of them.
//
// THE FIVE AXES, AND WHY THESE FIVE. They are what the termination decision
// actually reads: what the root PID names (it is the handle a tree is addressed
// through, and it names this tree's root, nothing, an unrelated process that
// inherited the number, or nothing while this host still hangs rows off it), what
// the PLATFORM said about the kill, which MECHANISM this platform's tree kill is
// (a delivered group signal, or `taskkill` walking a descendant tree), what is
// left RUNNING, and whether the settle-time REGISTRATION that owns the retry was
// accepted. Every value is declared here, where the suite's coverage control can
// read it; a cell whose axis value nothing else carries is exactly what that
// control exists to notice.

/**
 * What the root pid names when termination is asked for.
 *
 * `recycled` is the state that is not about this tree at all: the root exited,
 * was reaped, and the operating system handed its number to an unrelated
 * process. `reaped-with-a-stale-parent-row` is its quieter twin — the number
 * names NOTHING, and this host still lists a live process that recorded it as a
 * parent, because Windows retains that column after a parent exits and a child
 * of the pid's FORMER holder is indistinguishable from this tree's own. Both are
 * states of the PID rather than of the root, which is why they belong on this
 * axis — every reading a termination takes is taken through that number.
 */
export type RootState =
  | "alive"
  | "exited-holding-stdio"
  | "reaped-with-a-stale-parent-row"
  | "reaped-with-nothing-behind-it"
  | "recycled";

/**
 * What the platform said about the kill this path issued.
 *
 * `never-asked` is a fourth answer rather than a shade of refusal: a path that
 * declines to signal at all and one that signalled and was refused are different
 * facts, and conflating them would let a cell asserting "the stranger was never
 * touched" be satisfied by one that touched it and lost.
 */
export type PlatformAnswer =
  | "delivered"
  | "refused-then-delivered"
  | "refused-throughout"
  | "never-asked";

/** Which mechanism this platform's tree kill is. */
export type TreeMode = "signal" | "external";

/**
 * What is still able to run once the kill has been issued.
 *
 * `unobservable` is not "nothing": it is a tree there is no reading to take of
 * in either direction, which happens two ways — a root pid that belongs to
 * somebody else with nothing captured while it did not, and a host whose process
 * listing will not answer at all, which leaves a live descendant real and
 * unnameable. `unverifiable-claimant` is the other
 * side of that coin — a live process this host hangs off the former root pid
 * that this tree cannot vouch for, which must be neither killed (it may be a
 * stranger) nor ignored (it may be ours). Both owe a refusal, because absence of
 * evidence is the one thing this path must never report as a clean tree.
 */
export type SurvivingMember =
  | "nothing"
  | "descendant"
  | "unreaped-zombie"
  | "unobservable"
  | "unverifiable-claimant";

/** Whether the settle-time registration that owns the retry was accepted. */
export type SettleRegistration = "accepted" | "refused";

/** One point in the space the five axes span. */
export interface TerminationAxes {
  readonly root: RootState;
  readonly platformAnswer: PlatformAnswer;
  readonly treeMode: TreeMode;
  readonly surviving: SurvivingMember;
  readonly settleRegistration: SettleRegistration;
}

/**
 * One cell: the state, the verdict it owes, and the real code that answers.
 *
 * `owedTermination` is `true` only where nothing that could still execute is
 * left — a `false` costs a retry and a wrong `true` costs an Electron that
 * outlives the run, so a cell whose answer is uncertain owes `false`.
 */
export interface TerminationCell {
  readonly name: string;
  readonly axes: TerminationAxes;
  readonly owedTermination: boolean;
  readonly answer: () => Promise<boolean>;
}

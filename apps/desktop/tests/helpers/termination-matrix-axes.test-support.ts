// The variables a termination decision reads, as a vocabulary: what the root pid names, what the
// platform said about the kill, which mechanism this platform's tree kill is, what is still
// running, and whether the settle-time registration that owns the retry was accepted. Declared
// here so the suite's coverage control can read every value. The assertion is
// `termination-failure-matrix.test.ts`, the scripted platform is
// `termination-matrix-tools.test-support.ts`, and the table is
// `termination-matrix-catalog.test-support.ts`.

/**
 * What the root pid names when termination is asked for. `recycled` is the root reaped and its
 * number handed to an unrelated process; `reaped-with-a-stale-parent-row` is the number naming
 * nothing while the host still lists a live process that recorded it as parent (Windows keeps
 * that column after a parent exits), so a child of the pid's former holder looks like this tree's.
 */
export type RootState =
  | "alive"
  | "exited-holding-stdio"
  | "reaped-with-a-stale-parent-row"
  | "reaped-with-nothing-behind-it"
  | "recycled";

/**
 * What the platform said about the kill this path issued. `never-asked` is not a refusal: a path
 * that declines to signal and one that signaled and lost are different facts, and conflating them
 * would let "the stranger was never touched" pass for one that touched it.
 */
export type PlatformAnswer =
  | "delivered"
  | "refused-then-delivered"
  | "refused-throughout"
  | "never-asked";

/** Which mechanism this platform's tree kill is. */
export type TreeMode = "signal" | "external";

/**
 * What can still run once the kill has been issued. `unobservable` is not `nothing`: no reading
 * can be taken, either because the root pid belongs to somebody else with nothing captured, or
 * because the host's process listing will not answer. `unverifiable-claimant` is a live process
 * hanging off the former root pid that this tree cannot vouch for: neither killable (it may be a
 * stranger) nor ignorable (it may be ours). Both owe a refusal, since absence of evidence is
 * never a clean tree.
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
 * One cell: the state, the verdict it owes, and the real code that answers. `owedTermination` is
 * `true` only where nothing that could still execute is left; a `false` costs a retry and a wrong
 * `true` costs an Electron that outlives the run, so an uncertain cell owes `false`.
 */
export interface TerminationCell {
  readonly name: string;
  readonly axes: TerminationAxes;
  readonly owedTermination: boolean;
  readonly answer: () => Promise<boolean>;
}

// What one execution root's removal is about, and what it costs.

/** What one removal is about, and the consequence its confirmation must state. */
export interface RootRemovalSubject {
  /** The worktree's own id, sent verbatim. */
  readonly rootId: string;
  /** What the person is agreeing to. */
  readonly consequence: string;
}

/**
 * The consequence sentence a removal states.
 *
 * Removing a worktree RECORDS a transition — the row and its event land before any disk
 * mutation and the sweep stamps the cleanup afterwards — so files on disk after a retire
 * is an ordinary state rather than a failure.
 */
export const ROOT_REMOVAL_CONSEQUENCE: string =
  "The root is recorded retired now; its files are removed by the cleanup sweep afterwards, so a retired root with files still on disk is an ordinary state. Anything uncommitted in that tree goes with them.";

/** Build one removal subject, with the consequence a removal carries. */
export function rootRemovalSubjectFor(rootId: string): RootRemovalSubject {
  return { rootId, consequence: ROOT_REMOVAL_CONSEQUENCE };
}

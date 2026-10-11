// Ending a child the daemon started together with every process it started in turn: git's
// transport helpers, a setup command's own children, what a login shell's files started.

/** How the system starts a child whose whole tree is ended later, and ends that tree. */
export interface ProcessTreeEnding {
  /**
   * Whether such a child starts as the leader of its own process group (`detached`), the group an
   * ending signals; where the system ends a tree from its root, the child stays in the daemon's.
   */
  readonly startsOwnGroup: boolean;
  /**
   * Ends the tree the child `pid` started, by `signal` where the system has signals. A tree already
   * gone is no failure; any other is thrown.
   */
  endProcessTree(pid: number, signal: NodeJS.Signals): Promise<void>;
}

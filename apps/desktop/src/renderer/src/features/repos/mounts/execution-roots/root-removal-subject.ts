// What one execution root's removal is about.

/** What one removal is about. */
export interface RootRemovalSubject {
  /** The worktree's own id, sent verbatim. */
  readonly rootId: string;
}

/** Build one removal subject. */
export function rootRemovalSubjectFor(rootId: string): RootRemovalSubject {
  return { rootId };
}

// How the operating system spells and compares a path, which every folder comparison, the trust
// envelope and the repo-root resolver follow.

/** The path rules of one operating system. */
export interface PathRules {
  /** The separator between a path's components. */
  readonly sep: string;
  /** Whether `path` is rooted, by the system's own reading. */
  isAbsolute(path: string): boolean;
  /** The root `path` starts with, empty for a relative one. */
  parse(path: string): { readonly root: string };
  /** Whether two names that differ only in case name one file, so comparisons lower-case them. */
  readonly hasCaseInsensitiveNames: boolean;
  /**
   * Whether a rooted path may name no volume (`\repos`), which the system completes against the
   * daemon's current drive, so a complete location's root must be longer than one character.
   */
  readonly hasDrivelessRoots: boolean;
  /**
   * Whether a program's output may end a line with `\r\n`; a name never holds the `\r`, since the
   * system forbids control characters in names.
   */
  readonly hasCarriageReturnLineEnds: boolean;
}

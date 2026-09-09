// Whether a rejected file operation means "there is no such path".
//
// A main-side leaf that imports nothing, so any module in this process can take it
// without pulling a graph along with it. It exists because two modules had been
// answering this question privately — `diagnostic-log.ts` for the size of a log that
// has not been written yet, `renderer-assets.ts` for an asset a request names and the
// built tree does not hold — and the two private answers had already parted: one read
// `ENOENT` alone and the other read `ENOTDIR` beside it, so a log pointed under a stray
// file reported a failed SIZE READ while an asset request of the same shape reported an
// ordinary miss. Neither predicate was exported, which is exactly why nothing reported
// the difference and why a third copy was one module away.
//
// TWO CODES, AND THE SECOND IS NOT A REFINEMENT OF THE FIRST. `ENOENT` is "no entry at
// this path". `ENOTDIR` is "a component that would have to be a directory is a file",
// which the kernel answers before it ever looks for the leaf. Both say the path names
// nothing; a reader that treats only the first as absence turns an ordinary not-there
// into a failure it then has to invent a policy for.
//
// EVERY OTHER CODE IS A FAILURE AND STAYS ONE — `EACCES`, `ELOOP`, `EIO`, `ENAMETOOLONG`.
// A predicate widened to "the operation did not succeed" would be precisely the silent
// failure both callers exist to avoid: an unreadable log reported as empty, and a
// permission-refused asset reported as a 404.

/** The rejection codes that mean the path names nothing. Closed — the tuple is the declaration. */
const ABSENCE_ERROR_CODES: readonly string[] = ["ENOENT", "ENOTDIR"];

/**
 * Whether a rejected `node:fs` operation failed because the path is not there.
 *
 * Reads `code` off an `unknown` rather than casting to `NodeJS.ErrnoException`, because
 * a `catch` binding is genuinely unknown — a rejected promise can carry any value at all
 * — and a cast would assert the shape instead of checking it.
 */
export function isMissingPath(failure: unknown): boolean {
  if (typeof failure !== "object" || failure === null || !("code" in failure)) {
    return false;
  }
  const { code } = failure;
  return typeof code === "string" && ABSENCE_ERROR_CODES.includes(code);
}

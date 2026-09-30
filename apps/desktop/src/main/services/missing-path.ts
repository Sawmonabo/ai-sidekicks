// A main-side leaf that imports nothing. `diagnostic-log.ts` (a log not yet written) and
// `renderer-assets.ts` (an asset the built tree lacks) need the same answer to "is the path
// just not there?".
//
// Two codes count: `ENOENT` (no entry at the path) and `ENOTDIR` (a component that would have
// to be a directory is a file); both mean the path names nothing. Every other code (`EACCES`,
// `ELOOP`, `EIO`, `ENAMETOOLONG`) is a failure and stays one: widening would report an
// unreadable log as empty and a permission refusal as a 404.

/** The rejection codes that mean the path names nothing. */
const ABSENCE_ERROR_CODES: readonly string[] = ["ENOENT", "ENOTDIR"];

/**
 * Whether a rejected `node:fs` operation failed because the path is not there. Reads `code`
 * off an `unknown` rather than casting, because a rejected promise can carry any value.
 */
export function isMissingPath(failure: unknown): boolean {
  if (typeof failure !== "object" || failure === null || !("code" in failure)) {
    return false;
  }
  const { code } = failure;
  return typeof code === "string" && ABSENCE_ERROR_CODES.includes(code);
}

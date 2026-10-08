// One check for a missing file, shared by the modules that read a file that may be absent.

/** Whether `error` is a file-system failure because no file is at the path (`ENOENT`). */
export function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

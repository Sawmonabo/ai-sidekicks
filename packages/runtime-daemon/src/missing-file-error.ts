// The test the modules that read a file which may be absent share, so a missing file reads one way.

/** Whether `error` is a file-system failure because no file is at the path (`ENOENT`). */
export function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

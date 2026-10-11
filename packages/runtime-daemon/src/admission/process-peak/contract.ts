// The one read the memory gate takes from the operating system: the most memory a process has held
// since it started. Each system's module answers it, and the daemon picks one at its start, so no
// caller tests the platform.

/** Reads a process's lifetime peak memory as its system charges it. */
export interface ProcessPeakReader {
  /**
   * The most memory process `processId` has held since it started, in bytes, or `undefined` when
   * it can no longer be read: it has exited, or it runs as another user. The read works only while
   * the process exists, so a caller reads it before the process is reaped. Throws on any other
   * refusal.
   */
  readPeakBytes(processId: number): Promise<number | undefined>;
}

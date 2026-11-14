// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// A running process as the system knows it: its id, the boot it runs in, and the system's own record of when it started.

/**
 * A process as the system knows it; two readings are of the same process exactly when equal.
 */
export interface ProcessIdentity {
  /**
   * The operating-system process id.
   */
  processId: number;
  /**
   * The id of the boot the process runs in: Linux's boot id, macOS's boot session id; on Windows
   * one fixed word, since Windows keeps no boot mark a change of the clock leaves alone.
   */
  bootId: string;
  /**
   * The system's own record of when the process started, as the system writes it: Linux's
   * clock ticks since boot, macOS's start instant, Windows' creation time. Compared only for
   * equality, never read as a time, so a change of the clock does not change it.
   */
  processStartTime: string;
}

export { validateProcessIdentity } from "./checks/process-identity.js";

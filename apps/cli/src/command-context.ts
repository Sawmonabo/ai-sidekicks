/**
 * The output streams one run of the command line writes to: the real process streams in
 * production, collectors in a test. A command's result goes to `stdout`; every diagnostic goes to
 * `stderr`.
 */
export interface CommandContext {
  readonly stdout: { write(chunk: string): void };
  readonly stderr: { write(chunk: string): void };
}

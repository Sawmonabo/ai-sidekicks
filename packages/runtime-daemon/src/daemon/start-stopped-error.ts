// The end of a start that a stop cut short before the daemon listened: what the start had taken is
// let go, and what it had written stays as it was, so the next start goes on from there.

/** Thrown by a start when a stop came before it listened, naming the step the stop ended. */
export class DaemonStartStoppedError extends Error {
  /** `step` names what the start was doing when the stop came, such as `repairing the file`. */
  constructor(step: string) {
    super(`A stop came while the start was ${step}`);
    this.name = "DaemonStartStoppedError";
  }
}

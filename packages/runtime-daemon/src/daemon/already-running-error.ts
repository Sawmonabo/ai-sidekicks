// The refusal a start meets when another daemon is already running for this account: it holds the
// data folder, or it answers on the socket this start would bind.

/** Thrown by a start when another daemon already holds what this one needs. */
export class DaemonAlreadyRunningError extends Error {
  /** `heldPlace` names what the other daemon holds, such as `the data folder <path>`. */
  constructor(heldPlace: string, options?: ErrorOptions) {
    super(`Another daemon already holds ${heldPlace}`, options);
    this.name = "DaemonAlreadyRunningError";
  }
}

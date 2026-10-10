// Holds a port another part of the daemon registers once at runtime, after the drivers that call
// it are built, so a driver reads the port when it needs it rather than when it is constructed.

/**
 * One port, absent until its owner registers it. A caller that finds it absent leaves the
 * provider waiting rather than answering in the owner's place, or refuses through `requirePort`.
 */
export class PortRegistration<TPort> {
  readonly #portName: string;
  #port: TPort | undefined;

  /** `portName` names the port in the errors a second registration and a refusal throw. */
  constructor(portName: string) {
    this.#portName = portName;
  }

  /** Registers the port. Throws when one is already registered, since it has a single owner. */
  register(port: TPort): void {
    if (this.#port !== undefined) {
      throw new Error(`The ${this.#portName} port is already registered`);
    }
    this.#port = port;
  }

  /** The registered port, or `undefined` before its owner registers it. */
  get port(): TPort | undefined {
    return this.#port;
  }

  /**
   * The registered port. Throws an error naming the port when its owner has not registered it,
   * for an operation that cannot go on, or wait, without it.
   */
  requirePort(): TPort {
    if (this.#port === undefined) {
      throw new Error(`The ${this.#portName} port is not registered yet`);
    }
    return this.#port;
  }
}

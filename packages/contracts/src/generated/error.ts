// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The fields two refusals carry in `data.fields`: `daemon.limitExceeded` and `terminal.backendUnavailable`.

/** The longest name of a limit a `daemon.limitExceeded` refusal reports. */
export const RESOURCE_LABEL_MAX_LEN = 128 as const;

/** The longest message a refusal carries: well above any readable message, still bounded. */
export const ERROR_MESSAGE_MAX_LEN = 8192 as const;

/**
 * A `daemon.limitExceeded` refusal's fields: the name of the limit that tripped, its ceiling
 * and the count that passed it. The screen says the limit was reached in words and draws no
 * figure.
 */
export interface DaemonLimitExceededFields {
  /**
   * The limit's name.
   */
  resource: string;
  /**
   * The limit's ceiling.
   */
  limit: number;
  /**
   * The count that passed it.
   */
  current: number;
}
/**
 * A `terminal.backendUnavailable` refusal's fields: why the daemon could not open the PTY a shell
 * needs, rendered opaquely and never branched on.
 */
export interface TerminalBackendUnavailableFields {
  /**
   * What the platform's PTY reported.
   */
  cause?: unknown;
}

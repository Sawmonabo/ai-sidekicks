import { JsonRpcRemoteError, JsonRpcTransportUnavailableError } from "@ai-sidekicks/client-sdk";
import {
  JsonRpcErrorCode,
  type JsonRpcErrorCodeValue,
} from "@ai-sidekicks/contracts/jsonrpc/message";
import { CommanderError } from "commander";

/** The process exit codes the command line returns, from the BSD `sysexits.h` set. */
export const PosixExitCode = {
  Success: 0,
  /** EX_USAGE: the command was invoked or called incorrectly. */
  Usage: 64,
  /** EX_DATAERR: the input data was malformed. */
  DataError: 65,
  /** EX_SOFTWARE: an internal failure. */
  Software: 70,
} as const;

/** One of the values in {@link PosixExitCode}. */
export type PosixExitCode = (typeof PosixExitCode)[keyof typeof PosixExitCode];

/**
 * The exit code for each numeric error the daemon returns. Keyed by every contract code, so a code
 * added to the contract fails typecheck until it is given an exit code here.
 */
const DAEMON_ERROR_EXIT_CODES: Readonly<Record<JsonRpcErrorCodeValue, PosixExitCode>> = {
  [JsonRpcErrorCode.ParseError]: PosixExitCode.DataError,
  [JsonRpcErrorCode.InvalidRequest]: PosixExitCode.Usage,
  [JsonRpcErrorCode.MethodNotFound]: PosixExitCode.Usage,
  [JsonRpcErrorCode.InvalidParams]: PosixExitCode.Usage,
  [JsonRpcErrorCode.InternalError]: PosixExitCode.Software,
};

/** A failure the command line raises itself rather than receives from the daemon. */
type LocalFailureKind = "usage" | "software";

/** The exit code for each failure the command line raises itself. */
export const LOCAL_FAILURE_EXIT_CODES: Readonly<Record<LocalFailureKind, PosixExitCode>> = {
  usage: PosixExitCode.Usage,
  software: PosixExitCode.Software,
};

/** Thrown when the daemon returns a numeric error code that has no exit code assigned. */
export class UnmappedExitCodeError extends Error {
  public constructor(daemonCode: number) {
    super(`The daemon's error code ${daemonCode} has no exit code`);
    this.name = "UnmappedExitCodeError";
  }
}

function isAssignedDaemonCode(code: number): code is JsonRpcErrorCodeValue {
  return Object.hasOwn(DAEMON_ERROR_EXIT_CODES, code);
}

/**
 * The exit code for a failed run. A parse refusal is a usage error, a daemon error takes its
 * code's exit code, and anything else is a software error. Throws {@link UnmappedExitCodeError}
 * for a daemon code with no exit code.
 */
export function exitCodeForFailure(error: unknown): PosixExitCode {
  if (error instanceof CommanderError) {
    return LOCAL_FAILURE_EXIT_CODES.usage;
  }
  if (error instanceof JsonRpcRemoteError || error instanceof JsonRpcTransportUnavailableError) {
    if (!isAssignedDaemonCode(error.code)) {
      throw new UnmappedExitCodeError(error.code);
    }
    return DAEMON_ERROR_EXIT_CODES[error.code];
  }
  return LOCAL_FAILURE_EXIT_CODES.software;
}

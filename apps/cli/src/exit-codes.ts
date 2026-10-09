import {
  JsonRpcRemoteError,
  JsonRpcTransportClosedError,
  JsonRpcTransportUnavailableError,
} from "@ai-sidekicks/client-sdk";
import {
  JsonRpcErrorCode,
  type JsonRpcErrorCodeValue,
} from "@ai-sidekicks/contracts/jsonrpc/error-code";
import { CommanderError } from "commander";

/**
 * The process exit codes the command line returns: BSD `sysexits.h` codes, plus the status a shell
 * reports for a program a closed pipe ended.
 */
export const ExitCode = {
  Success: 0,
  /** EX_USAGE: the command was invoked or called incorrectly. */
  Usage: 64,
  /** EX_DATAERR: the input data was malformed. */
  DataError: 65,
  /** EX_UNAVAILABLE: a service the command needs is not answering. */
  Unavailable: 69,
  /** EX_SOFTWARE: an internal failure. */
  Software: 70,
  /** 128 + SIGPIPE: the reader of the output went away, as git and coreutils exit. */
  BrokenPipe: 141,
} as const;

/** One of the values in {@link ExitCode}. */
export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

/**
 * The exit code for each numeric error the daemon returns. Keyed by every contract code, so a code
 * added to the contract fails typecheck until it is given an exit code here.
 */
const DAEMON_ERROR_EXIT_CODES: Readonly<Record<JsonRpcErrorCodeValue, ExitCode>> = {
  [JsonRpcErrorCode.ParseError]: ExitCode.DataError,
  [JsonRpcErrorCode.InvalidRequest]: ExitCode.Usage,
  [JsonRpcErrorCode.MethodNotFound]: ExitCode.Usage,
  [JsonRpcErrorCode.InvalidParams]: ExitCode.Usage,
  [JsonRpcErrorCode.InternalError]: ExitCode.Software,
};

/** A failure the command line raises itself rather than receives from the daemon. */
type LocalFailureKind = "usage" | "unavailable" | "brokenPipe" | "software";

/** The exit code for each failure the command line raises itself. */
export const LOCAL_FAILURE_EXIT_CODES: Readonly<Record<LocalFailureKind, ExitCode>> = {
  usage: ExitCode.Usage,
  unavailable: ExitCode.Unavailable,
  brokenPipe: ExitCode.BrokenPipe,
  software: ExitCode.Software,
};

/** Thrown when the daemon returns a numeric error code that has no exit code assigned. */
class UnmappedExitCodeError extends Error {
  public constructor(daemonCode: number) {
    super(`The background service returned error code ${daemonCode}, which has no exit code`);
    this.name = "UnmappedExitCodeError";
  }
}

function isAssignedDaemonCode(code: number): code is JsonRpcErrorCodeValue {
  return Object.hasOwn(DAEMON_ERROR_EXIT_CODES, code);
}

function isBrokenPipe(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EPIPE";
}

/**
 * The exit code for a failed run, from its error's class: a refusal, an unreachable service, a
 * closed output pipe, a daemon error code, or else a software error. Throws
 * `UnmappedExitCodeError` for a daemon code with no exit code.
 */
export function exitCodeForFailure(error: unknown): ExitCode {
  if (error instanceof CommanderError) {
    return LOCAL_FAILURE_EXIT_CODES.usage;
  }
  if (
    error instanceof JsonRpcTransportUnavailableError ||
    error instanceof JsonRpcTransportClosedError
  ) {
    return LOCAL_FAILURE_EXIT_CODES.unavailable;
  }
  if (isBrokenPipe(error)) {
    return LOCAL_FAILURE_EXIT_CODES.brokenPipe;
  }
  if (error instanceof JsonRpcRemoteError) {
    if (!isAssignedDaemonCode(error.code)) {
      throw new UnmappedExitCodeError(error.code);
    }
    return DAEMON_ERROR_EXIT_CODES[error.code];
  }
  return LOCAL_FAILURE_EXIT_CODES.software;
}

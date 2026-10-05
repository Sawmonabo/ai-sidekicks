// A background service process main can end: one it started, whose exit the system reports, or
// one it found running, which it knows by the identity the service reported. Either is ended by
// one rule. A service main asked to stop has its whole drain bound from the moment main sent the
// request, then SIGTERM, then SIGKILL 2 seconds later; one that never answered gets SIGTERM at
// once, which starts its drain, and SIGKILL once the drain bound and 2 seconds have passed. Every
// wait runs on the monotonic clock, so a change of the wall clock never holds a signal back.

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { DAEMON_STOP_DRAIN_BOUND_MS } from "@ai-sidekicks/contracts/daemon-lifecycle";
import {
  createProcessIdentityReader,
  isSameProcess,
  type ProcessIdentity,
} from "@ai-sidekicks/contracts/process-identity";

/** How long a service still running after its drain bound has before SIGKILL. */
const SERVICE_END_GRACE_MS = 2_000;

/**
 * How often main looks whether a found service has exited. The system reports the exit of main's
 * own children only, so a found service is looked at by its identity, and only while a restart or
 * a quit waits on it.
 */
const FOUND_SERVICE_EXIT_CHECK_MS = 100;

/** The longest that wait runs: the drain, the grace before the kill, and a second for the kill. */
const FOUND_SERVICE_EXIT_WAIT_MS = DAEMON_STOP_DRAIN_BOUND_MS + SERVICE_END_GRACE_MS + 1_000;

/**
 * Why main ends a service. `stopAsked`: main sent `daemon.stop` or `daemon.restart` at `askedAt`,
 * a `performance.now()` reading, and the service answered, so its drain has run since then.
 * `unanswered`: it stopped answering, or never answered the stop, so SIGTERM starts its drain.
 */
export type ServiceEnding =
  | { readonly cause: "stopAsked"; readonly askedAt: number }
  | { readonly cause: "unanswered" };

/**
 * How a service process ended: its exit code or the signal that ended it. Both are `null` for a
 * service main found running, whose exit main sees but whose code it cannot read.
 */
export interface ServiceExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

/**
 * A reader of this system's processes through Node's own file read and program run; it answers
 * `undefined` when no process has the id.
 */
export function createSystemProcessIdentityReader(): (
  processId: number,
) => Promise<ProcessIdentity | undefined> {
  const runProgram = promisify(execFile);
  return createProcessIdentityReader({
    platform: process.platform,
    readTextFile: (filePath) => readFile(filePath, "utf8"),
    runProgram: (file, args, environment) => runProgram(file, [...args], { env: environment }),
  });
}

/** A background service process main can end. */
export interface ServiceProcess {
  /** The process id the operating system gave it. */
  readonly processId: number;
  /** Whether the process is known to have exited. */
  hasExited(): boolean;
  /**
   * Resolves once the process has exited. For a service main found running, it resolves at the
   * latest a second after the kill was due, and rejects when looking at the process fails.
   */
  whenExited(): Promise<ServiceExit>;
  /**
   * Ends it by `ending`'s rule, each signal sent only while the process is still the service. Only
   * the first call acts; a later one returns the first one's promise. Resolves once the last signal
   * is sent or the process has exited; rejects when looking at the process or signaling it fails.
   */
  end(ending: ServiceEnding): Promise<void>;
}

/** What a {@link ServiceProcess} is built from: how to look at the process and how to signal it. */
export interface ServiceProcessParts {
  readonly processId: number;
  readonly hasExited: () => boolean;
  readonly whenExited: () => Promise<ServiceExit>;
  /** Whether the process is still the service, looked at just before each signal. */
  readonly isRunning: () => Promise<boolean>;
  readonly signal: (name: NodeJS.Signals) => void;
}

/** A service process from its parts, whose `end` acts once. */
export function serviceProcessOf(parts: ServiceProcessParts): ServiceProcess {
  let ending: Promise<void> | undefined;
  return {
    processId: parts.processId,
    hasExited: parts.hasExited,
    whenExited: parts.whenExited,
    end: (serviceEnding) => {
      ending ??= endServiceProcess(serviceEnding, parts.isRunning, parts.signal);
      return ending;
    },
  };
}

async function endServiceProcess(
  ending: ServiceEnding,
  isRunning: () => Promise<boolean>,
  signal: (name: NodeJS.Signals) => void,
): Promise<void> {
  const terminateAt =
    ending.cause === "stopAsked" ? ending.askedAt + DAEMON_STOP_DRAIN_BOUND_MS : performance.now();
  await waitUntil(terminateAt);
  if (!(await isRunning())) {
    return;
  }
  signal("SIGTERM");
  // After a stop the drain began when it was asked for; otherwise this SIGTERM began it.
  const killAt =
    ending.cause === "stopAsked"
      ? terminateAt + SERVICE_END_GRACE_MS
      : performance.now() + DAEMON_STOP_DRAIN_BOUND_MS + SERVICE_END_GRACE_MS;
  await waitUntil(killAt);
  if (!(await isRunning())) {
    return;
  }
  signal("SIGKILL");
}

// The timer is unref'd: a pending ending never keeps main's event loop alive by itself.
function waitUntil(at: number): Promise<void> {
  const waitMs = at - performance.now();
  if (waitMs <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    setTimeout(resolve, waitMs).unref();
  });
}

/**
 * The service main found running, by the identity it reported. Before each signal, and at each
 * look while waiting for its exit, main reads that id's identity from the system; an id that no
 * longer reads as the service belongs to another process, counts as exited and is never signaled.
 */
export function attachToServiceProcess(
  identity: ProcessIdentity,
  readIdentity: (
    processId: number,
  ) => Promise<ProcessIdentity | undefined> = createSystemProcessIdentityReader(),
): ServiceProcess {
  const { processId } = identity;
  let isKnownGone = false;
  const isStillService = async (): Promise<boolean> => {
    const reading = await readIdentity(processId);
    if (reading === undefined || !isSameProcess(reading, identity)) {
      isKnownGone = true;
    }
    return !isKnownGone;
  };
  let exited: Promise<ServiceExit> | undefined;
  return serviceProcessOf({
    processId,
    hasExited: () => isKnownGone || !isProcessIdTaken(processId),
    whenExited: () => {
      exited ??= new Promise<ServiceExit>((resolve, reject) => {
        const lookedUntil = performance.now() + FOUND_SERVICE_EXIT_WAIT_MS;
        const look = (): void => {
          isStillService().then((isRunning) => {
            if (!isRunning || performance.now() >= lookedUntil) {
              resolve({ code: null, signal: null });
              return;
            }
            setTimeout(look, FOUND_SERVICE_EXIT_CHECK_MS);
          }, reject);
        };
        look();
      });
      return exited;
    },
    isRunning: isStillService,
    signal: (name) => {
      try {
        process.kill(processId, name);
      } catch (failure) {
        // It exited between the look and the signal, which is what the signal was for.
        if (!isErrorCode(failure, "ESRCH")) {
          throw failure;
        }
      }
    },
  });
}

// Whether any process main may signal holds the id; another account's process counts as none.
function isProcessIdTaken(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (failure) {
    if (isErrorCode(failure, "ESRCH") || isErrorCode(failure, "EPERM")) {
      return false;
    }
    throw failure;
  }
}

function isErrorCode(failure: unknown, code: string): boolean {
  return failure instanceof Error && (failure as NodeJS.ErrnoException).code === code;
}

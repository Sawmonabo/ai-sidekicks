// Whether a pid names anything, and whether what it names can still run.
//
// The role beside `identity.ts` and deliberately not folded into it: this module
// answers questions about a NUMBER at one moment, and identity answers whether
// the number still names the same process across two. Both were one file, and
// the pairing hid that every reading here is correct about a pid and silent about
// a tree.
//
// SURVIVAL IS TWO QUESTIONS AND `kill(pid, 0)` ANSWERS THE WRONG ONE
//
// A process that has exited and has not been reaped by its parent is a ZOMBIE: it
// holds its pid, it answers signal 0, and it will never run another instruction.
// That is not an edge case for this package — a group SIGKILL takes the direct
// child down alongside its own children, so a grandchild is reparented to init at
// the moment it dies and stays a zombie for exactly as long as that init takes to
// reap it, which in a container whose init does not reap is forever. So "still
// there" and "still running" are different readings, and a leak probe must take
// the second: Linux reports it in `/proc/<pid>/stat`'s state field, macOS in
// `ps -o stat=`, and Windows is asked nothing at all, because it keeps no such
// entry and its tree kill is external, so disappearance is the only evidence
// there is.
//
// AND THE TWO READINGS ARE TAKEN AT TWO MOMENTS, WHICH IS A RACE
//
// A process that exits BETWEEN them leaves the existence probe saying `true` and
// the state lookup saying nothing — the entry is gone, so there is nothing to
// parse — and reading that silence as "no evidence it exited" reports an
// already-reaped pid as `running`. That reading is consumed by `terminateProcessTree`
// after a signal it could not deliver, where it turns the commonest outcome there
// is, ESRCH on a process that had already gone, into a refused kill. So a missing
// state is answered by asking existence AGAIN rather than by assuming either way:
// still there and stateless is `running`, and gone is `gone`.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";

/**
 * What a pid is doing, as three states rather than two.
 *
 * `gone` — the pid names nothing. `zombie` — it names an exited process its
 * parent has not reaped, which is terminated for every purpose this package
 * has. `running` — it names a process that may still execute, which is the one
 * reading that should ever fail a leak assertion.
 */
export type ProcessLiveness = "gone" | "zombie" | "running";

/**
 * Whether a pid names a process at all, without signalling it.
 *
 * Signal 0 performs the permission and existence checks and delivers nothing —
 * on Windows too, where Node maps it onto a handle open. `EPERM` means the
 * process is there and out of reach, which for this question is "still there":
 * reporting it gone would be the same false success this probe exists to catch.
 *
 * It answers EXISTENCE and deliberately not liveness — a zombie answers this
 * `true`. Callers asking whether anything is still running want
 * `processHasTerminated`, which is this reading plus the state below.
 */
export function processExists(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Whether the process GROUP led by `processId` still holds any member.
 *
 * The reading that survives the root's exit, and the reason it has to exist
 * separately from `processExists`. A group is alive for exactly as long as one
 * of its members is, so on a detached spawn it is the tree's handle rather than
 * a fact about the leader: the launcher shim can be gone and reaped while the
 * browser process it started is still in the group and still running.
 *
 * `EPERM` means the group is there and out of reach, which for this question is
 * "still there" — `processExists`'s reason, one target wider. The negative form
 * is safe HERE only because the caller's pid leads its own group, which the
 * detached spawn in `electron-child.ts` is what guarantees; handed a pid that
 * leads somebody else's group this reports on that group instead.
 *
 * Never asked of `0`: on POSIX `kill(0, …)` addresses the CALLER's own group,
 * so a pid that was never recorded would report this runner as the live tree.
 */
export function processGroupExists(processId: number): boolean {
  if (processId <= 0) {
    return false;
  }
  try {
    process.kill(-processId, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Whether a process-table state code names a process that has already exited.
 *
 * `Z` is the zombie state on both POSIX platforms this package runs on; Linux
 * additionally reports `X` for a process in the act of being torn down. Only
 * the FIRST letter is read, because `ps` decorates the code with modifiers
 * (`Z+`, `Ss`, `R<`) that say nothing about whether the process still runs.
 *
 * A pure function over the text so both arms below can be driven by a test
 * without a real zombie, which is not a thing a test can reliably manufacture:
 * whether one lingers at all is the reaping behaviour of an init this process
 * does not own.
 */
export function isTerminatedProcessState(stateCode: string): boolean {
  const stateLetter = stateCode.trim().charAt(0).toUpperCase();
  return stateLetter === "Z" || stateLetter === "X";
}

/**
 * The state code out of the text of `/proc/<pid>/stat`.
 *
 * Read from the LAST `)` rather than by splitting on whitespace, and that is
 * the whole reason this is a named function: field 2 is the executable name in
 * parentheses, it is not escaped, and it may contain spaces and parentheses of
 * its own — `(Web Content)` and `(a) b)` both parse wrongly under a naive
 * split, and the state is the field immediately after it.
 *
 * `undefined` means the text was not that format, which is not evidence of
 * anything and is treated as such by the caller.
 */
export function processStateFromProcStat(statText: string): string | undefined {
  const executableNameEnd = statText.lastIndexOf(")");
  if (executableNameEnd < 0) {
    return undefined;
  }
  const stateCode = statText
    .slice(executableNameEnd + 1)
    .trim()
    .split(/\s+/)[0];
  return stateCode === undefined || stateCode === "" ? undefined : stateCode;
}

/**
 * This platform's state code for `processId`, or `undefined` if it has none.
 *
 * `undefined` is returned for four different reasons and they are deliberately
 * not distinguished here: an unreadable entry, an unparseable one, a platform
 * that keeps no such state, and a process that exited between the existence
 * probe and this lookup. They are not the same fact — the last one means the
 * pid is GONE and the other three mean nothing at all — and distinguishing them
 * out of this function would mean reading a platform's errno vocabulary into a
 * reading that has a cheaper and more honest way to settle it. The caller asks
 * existence again instead, which answers all four with one syscall.
 */
function readProcessStateCode(processId: number): string | undefined {
  if (process.platform === "linux") {
    try {
      return processStateFromProcStat(readFileSync(`/proc/${String(processId)}/stat`, "utf8"));
    } catch {
      // The entry vanished between the existence probe and this read, or was
      // never readable. Which of the two it was is the caller's second existence
      // read to settle, not this arm's to guess from an errno.
      return undefined;
    }
  }
  if (process.platform === "darwin") {
    const inspected = spawnSync("ps", ["-o", "stat=", "-p", String(processId)], {
      encoding: "utf8",
    });
    if (inspected.error !== undefined || inspected.status !== 0) {
      return undefined;
    }
    const reported = inspected.stdout.trim();
    return reported === "" ? undefined : reported;
  }
  // Windows keeps no exited-but-unreaped entry to read, so there is nothing to
  // ask and disappearance is the only termination evidence the platform gives.
  return undefined;
}

/**
 * The two questions a liveness reading asks, as one injectable pair.
 *
 * Split out for the reason `terminationSucceeded` splits out its probe, and for
 * a second one that is stronger: the case that matters here is a process that
 * exits BETWEEN the two questions, and the width of that window belongs to the
 * kernel. It cannot be arranged against a real pid, so it is arranged against
 * this seam instead.
 */
export interface ProcessLivenessProbes {
  /** Whether the pid names a process at all — a zombie answers `true`. */
  readonly exists: (processId: number) => boolean;
  /** This platform's process-table state code, or `undefined` if it has none. */
  readonly stateCode: (processId: number) => string | undefined;
}

/** The real pair, which every production caller takes. */
const PLATFORM_LIVENESS_PROBES: ProcessLivenessProbes = {
  exists: processExists,
  stateCode: readProcessStateCode,
};

/**
 * What `processId` is doing right now.
 *
 * Existence first, because it is one syscall and settles most calls; the state
 * read only for a pid that is still there. Both readings race the process they
 * describe, which is why every assertion on this in the tests is a bounded
 * observation rather than a single sample.
 *
 * A MISSING STATE IS NOT EVIDENCE OF RUNNING, AND THE SECOND EXISTENCE READ IS
 * WHAT SEPARATES THE TWO THINGS IT CAN MEAN. The lookup is a second moment, so
 * a process that exited since the first one leaves it with nothing to read —
 * `/proc/<pid>/stat` is gone, `ps` exits non-zero — which is exactly what a
 * platform that keeps no state at all returns. Reading both as `running` told
 * `terminateProcessTree` that a reaped pid had refused its kill, which is the
 * false FAILURE beside the false success this module was written against: it
 * makes an ordinary ESRCH look unterminable, and it leaves a caller retrying a
 * number the operating system has already taken back. Asking existence again
 * costs one syscall on the only branch that reaches it and answers both.
 *
 * Failing towards `running` survives that: the recheck reports `running` for
 * every pid that is demonstrably still there, so the platform with no state to
 * read — Windows — reads exactly as it did.
 */
export function readProcessLiveness(
  processId: number,
  probes: ProcessLivenessProbes = PLATFORM_LIVENESS_PROBES,
): ProcessLiveness {
  if (!probes.exists(processId)) {
    return "gone";
  }
  const stateCode = probes.stateCode(processId);
  if (stateCode !== undefined) {
    return isTerminatedProcessState(stateCode) ? "zombie" : "running";
  }
  return probes.exists(processId) ? "running" : "gone";
}

/**
 * Whether `processId` will never run another instruction.
 *
 * The reading a leak assertion wants. A zombie counts as terminated: it holds a
 * pid and nothing else, and waiting for it to disappear waits on an init this
 * process does not own — which on a hosted runner is prompt and in a container
 * whose init does not reap is unbounded.
 */
export function processHasTerminated(processId: number): boolean {
  return readProcessLiveness(processId) !== "running";
}

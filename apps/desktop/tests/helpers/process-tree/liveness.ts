// Whether a pid names anything, and whether what it names can still run. This answers questions
// about a number at one moment; `identity.ts` covers whether it names the same process across two.
//
// `kill(pid, 0)` answers "still there", not "still running". An exited, unreaped process is a
// zombie: it holds its pid and answers signal 0 but never runs again. A group SIGKILL reparents a
// grandchild to init, which leaves it a zombie until init reaps it, forever in a container whose
// init does not. A leak probe therefore needs the state: Linux reports it in `/proc/<pid>/stat`,
// macOS in `ps -o stat=`, and Windows keeps no such entry, so disappearance is its only evidence.
//
// The existence probe and the state lookup happen at two moments. A process exiting between them
// leaves `true` and no state, and reading that as `running` would report a reaped pid as refusing
// its kill. A missing state is therefore answered by asking existence again: still there is
// `running`, gone is `gone`.

import { readFileSync } from "node:fs";
import process from "node:process";

import { runBoundedHostQuery } from "./readers.js";

/**
 * What a pid is doing: `gone` names nothing, `zombie` names an exited process its parent has not
 * reaped, `running` names a process that may still execute.
 *
 * Only `running` should fail a leak assertion.
 */
type ProcessLiveness = "gone" | "zombie" | "running";

/**
 * Whether a pid names a process at all, without signaling it.
 *
 * Signal 0 checks permission and existence and delivers nothing, on Windows too. `EPERM` means
 * the process is there and out of reach, which counts as still there. A zombie answers `true`;
 * callers asking whether anything still runs want `processHasTerminated`.
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
 * Whether the process group led by `processId` still holds any member.
 *
 * A group lives as long as one member does, so on a detached spawn it is the tree's handle even
 * after the launcher shim is gone. `EPERM` counts as still there. The negative pid is safe only
 * because the detached spawn in `electron-child.ts` makes the caller's pid lead its own group;
 * for any other pid this reports on someone else's group. Never asked of `0`, which on POSIX
 * addresses the caller's own group and would report this runner as the live tree.
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
 * `Z` is the zombie state on both POSIX platforms; Linux also reports `X` for a process being
 * torn down. Only the first letter is read, since `ps` appends modifiers (`Z+`, `Ss`, `R<`).
 */
function isTerminatedProcessState(stateCode: string): boolean {
  const stateLetter = stateCode.trim().charAt(0).toUpperCase();
  return stateLetter === "Z" || stateLetter === "X";
}

/**
 * The state code out of the text of `/proc/<pid>/stat`, or `undefined` if it is not that format.
 *
 * Read from the last `)` rather than by splitting on whitespace: field 2 is the unescaped
 * executable name in parentheses and may contain spaces and parentheses, so `(Web Content)` and
 * `(a) b)` parse wrongly under a naive split.
 */
function processStateFromProcStat(statText: string): string | undefined {
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
 * `undefined` covers an unreadable entry, an unparseable one, a platform with no such state, and
 * a process that exited between the existence probe and this lookup. They are not separated;
 * the caller asks existence again, which settles all four with one syscall.
 *
 * The macOS arm runs `ps` through `runBoundedHostQuery`, because `spawnSync` blocks the thread
 * vitest's timeout runs on and a stalled `ps` would tear the worker down with its Electron
 * still alive. The Linux arm reads a file and needs no bound.
 */
function readProcessStateCode(
  processId: number,
  remainingBudgetMilliseconds?: number,
): string | undefined {
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
    return runBoundedHostQuery(
      "ps",
      ["-o", "stat=", "-p", String(processId)],
      remainingBudgetMilliseconds,
    );
  }
  // Windows keeps no exited-but-unreaped entry to read, so there is nothing to
  // ask and disappearance is the only termination evidence the platform gives.
  return undefined;
}

/**
 * What `processId` is doing right now.
 *
 * Existence first, since it is one syscall; the state read only for a pid that is still there.
 * A missing state is settled by a second existence read, because the lookup can find nothing
 * for a process that exited since the first check, and reading that as `running` would report
 * a reaped pid as refusing its kill. The recheck reports `running` for every pid still there,
 * so Windows, which has no state to read, is unchanged. It also keeps an exhausted budget safe:
 * the state probe runs nothing, the recheck costs a syscall, and a live pid reads `running`,
 * never a false clean tree.
 */
function readProcessLiveness(
  processId: number,
  remainingBudgetMilliseconds?: number,
): ProcessLiveness {
  if (!processExists(processId)) {
    return "gone";
  }
  const stateCode = readProcessStateCode(processId, remainingBudgetMilliseconds);
  if (stateCode !== undefined) {
    return isTerminatedProcessState(stateCode) ? "zombie" : "running";
  }
  return processExists(processId) ? "running" : "gone";
}

/**
 * Whether `processId` will never run another instruction.
 *
 * The reading a leak assertion wants; a zombie counts as terminated, since waiting for it to
 * disappear waits on an init this process does not own. A caller inside a deadline passes what
 * is left of it, because the macOS arm runs a command; spent to zero it spawns nothing and
 * reads not-terminated, which keeps a caller escalating.
 */
export function processHasTerminated(
  processId: number,
  remainingBudgetMilliseconds?: number,
): boolean {
  return readProcessLiveness(processId, remainingBudgetMilliseconds) !== "running";
}

// Killing a spawned Electron tree, once, for every harness that spawns one.
//
// Two harnesses spawn Electron — the Tier-1 smoke probe in `electron-probe.ts`
// and the console launcher behind `test/console/bounded-cleanup.ts` — and each
// grew its own copy of the same platform facts. They had already diverged:
// only one of them read `taskkill`'s exit status, so the other reported a kill it
// had not performed. A rule with two homes is a rule that will disagree with
// itself; this is the home.
//
// The four facts, each measured rather than assumed:
//
//   • POSIX group delivery is safe HERE and catastrophic in general.
//     `playwright-core` spawns with `detached: process.platform !== "win32"`
//     (`lib/coreBundle.js`), and the smoke probe passes `detached: true` itself,
//     so on POSIX the launched Electron LEADS its own process group and `-pid`
//     reaches the browser, its zygote, and every renderer at once. The negative
//     form addresses a whole GROUP — the one whose id is that number — and the
//     only reason that group is the launched tree is the detached spawn above.
//     Hand the same call a pid that leads somebody else's group and it takes
//     that group down instead, which is why the fallback below narrows to the
//     leader and never widens. An ATTACHED child leads no group at all, so the
//     negative call finds none, fails `ESRCH`, and falls through to that arm;
//     this runner's own group is a different number and is never passed.
//
//   • Windows has no process group to signal, and its "signals" are
//     `TerminateProcess` calls that are never forwarded, so signalling the
//     launcher alone orphans the browser holding the inherited stdout write end.
//     `taskkill /pid N /t` walks the descendant tree: without `/f` it posts
//     WM_CLOSE to each windowed process (the graceful analog — the tree members
//     that matter here all have windows), with `/f` it terminates every node
//     outright (the SIGKILL analog). This is also the form `playwright-core`
//     itself runs for this process. It is a SEPARATE PROGRAM rather than a
//     delivered signal, which is why the mode below is named and exported: a
//     tree terminated that way reports no signal on the child's `exit`, so a
//     test asserting one is asserting a POSIX detail on a platform that has none.
//
//   • Delivery and survival are two questions, and answering only the first was
//     the divergence. A `taskkill` that SPAWNS and exits non-zero — termination
//     denied, most of all — leaves `spawnSync`'s `error` undefined while Electron
//     keeps running. The exit code is a separate field of that result precisely
//     because it is a separate question, and a non-zero exit is not automatically
//     a failure either: a tree already gone is one of the things taskkill refuses.
//     Which one it was is asked of the OS, never read out of taskkill's message,
//     because that message is localised and this must not depend on the runner's
//     display language.
//
//   • Survival itself is two questions, and `kill(pid, 0)` answers the wrong one.
//     A process that has exited and has not been reaped by its parent is a
//     ZOMBIE: it holds its pid, it answers signal 0, and it will never run
//     another instruction. That is not an edge case for this module — a group
//     SIGKILL takes the direct child down alongside its own children, so a
//     grandchild is reparented to init at the moment it dies and stays a zombie
//     for exactly as long as that init takes to reap it, which in a container
//     whose init does not reap is forever. So "still there" and "still running"
//     are different readings, and a leak probe must take the second: Linux
//     reports it in `/proc/<pid>/stat`'s state field, macOS in `ps -o stat=`,
//     and Windows is asked nothing at all, because it keeps no such entry and
//     its tree kill is external, so disappearance is the only evidence there is.
//
//   • And the two readings are taken at two moments, which is a race and not a
//     detail. A process that exits BETWEEN them leaves the existence probe
//     saying `true` and the state lookup saying nothing — the entry is gone, so
//     there is nothing to parse — and reading that silence as "no evidence it
//     exited" reports an already-reaped pid as `running`. That reading is
//     consumed by `terminateProcessTree` after a signal it could not deliver,
//     where it turns the commonest outcome there is, ESRCH on a process that
//     had already gone, into a refused kill. So a missing state is answered by
//     asking existence AGAIN rather than by assuming either way: still there
//     and stateless is `running`, and gone is `gone`.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";

/** How this platform's tree kill reaches a tree. */
export type ProcessTreeTerminationMode = "signal" | "external";

/**
 * Whether `terminateProcessTree` DELIVERS a signal or runs another program.
 *
 * Exported because it is the honest key for a caller that wants to say
 * something about how a tree died. On POSIX the group kill is a delivered
 * signal, so the child's `exit` names it; on Windows the tree is walked by
 * `taskkill /f`, an external termination the child reports as an exit code with
 * `signal === null`. A test branching on `process.platform` to say the same
 * thing would be restating this module's own fact somewhere it can drift.
 */
export const PROCESS_TREE_TERMINATION_MODE: ProcessTreeTerminationMode =
  process.platform === "win32" ? "external" : "signal";

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

/**
 * Whether a termination attempt left nothing to worry about.
 *
 * Two ways to succeed, and the second is why this is a function rather than a
 * boolean at each call site. A signal that was delivered is a success. A signal
 * that was NOT is still a success if there is nothing left to kill — which is
 * the ordinary outcome when a process exited between a close timing out and the
 * kill being issued.
 *
 * Splitting the probe out as an argument is what makes both arms testable at
 * all: the real one signals a real process, so a test exercising it would kill
 * something — on the POSIX arm a whole process group, which is the launched
 * tree only because of the detached spawn described above.
 */
export function terminationSucceeded(
  signalDelivered: boolean,
  processStillRunning: () => boolean,
): boolean {
  return signalDelivered || !processStillRunning();
}

/**
 * Signal the process tree led by `processId`, and say whether it landed.
 *
 * `true` means the signal was delivered or there was nothing left to signal;
 * `false` means a live process refused it. A caller escalating from `SIGTERM`
 * asks again after its grace period rather than reading `true` as "gone" — a
 * delivered graceful signal says the tree was asked to exit, not that it has.
 */
export function terminateProcessTree(
  processId: number,
  signal: NodeJS.Signals = "SIGKILL",
): boolean {
  const stillRunning = (): boolean => !processHasTerminated(processId);
  if (PROCESS_TREE_TERMINATION_MODE === "external") {
    const forced = signal === "SIGKILL" ? ["/f"] : [];
    const result = spawnSync("taskkill", ["/pid", String(processId), "/t", ...forced], {
      stdio: "ignore",
    });
    return terminationSucceeded(result.error === undefined && result.status === 0, stillRunning);
  }
  for (const target of [-processId, processId]) {
    try {
      process.kill(target, signal);
      return true;
    } catch {
      // Group already reaped, or this pid does not lead one after all.
    }
  }
  // Both throws land here, and ESRCH is the commonest reason: the process was
  // already gone. Reporting that as a failed termination would tell a reader an
  // Electron may still be holding a profile when nothing is — the same
  // misdescription as the Windows arm, in the opposite direction.
  return terminationSucceeded(false, stillRunning);
}

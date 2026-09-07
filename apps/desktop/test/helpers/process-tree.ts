// Killing a spawned Electron tree, once, for every harness that spawns one.
//
// Two harnesses spawn Electron — the Tier-1 smoke probe in `electron-probe.ts`
// and the console launcher behind `test/console/bounded-cleanup.ts` — and each
// grew its own copy of the same platform facts. They had already diverged:
// only one of them read `taskkill`'s exit status, so the other reported a kill it
// had not performed. A rule with two homes is a rule that will disagree with
// itself; this is the home.
//
// The facts this module holds, each measured rather than assumed — deliberately
// stated without a count, because the list has grown once per finding and a
// number written here is a number that goes stale silently:
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
//     `taskkill /pid N /t` walks the descendant tree instead — `runPlatformTreeKill`
//     in `process-tree-arms.ts` states what the flags do and why. It is a
//     SEPARATE PROGRAM rather than a delivered signal, which is why the mode
//     below is named and exported: a
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
//     display language. Both arms of that decision live in
//     `process-tree-arms.ts`, because neither can be executed on the platform
//     this suite runs on; this module supplies them the platform's own readings.
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
//   • And a pid is a NAME rather than a process. The operating system takes it
//     back and hands it out again, so every reading above can be taken of a pid
//     that no longer belongs to the tree it was recorded for — the shim exits
//     early and is reaped, which makes that window ordinary here rather than
//     exotic. `SpawnedTreeIdentity` below is what closes it: a start stamp
//     captured at spawn, re-read before any signal, so the Windows arm walks a
//     root it has verified and never a stranger who inherited the number.
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

import {
  deliverSignal,
  descendantsOf,
  readProcessParentTable,
  runPlatformTreeKill,
  terminateExternalTree,
  terminateSignalledTree,
  type TreeRootIdentity,
} from "./process-tree-arms.js";

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
 * The platform's per-instance start stamp for `processId`, or `undefined`.
 *
 * THE READING THAT SEPARATES A PID FROM THE PROCESS HOLDING IT. Every other
 * reading in this module answers a question about a NUMBER, and a number is
 * reissued: the launcher shim exits, it is reaped, and the pid every later
 * disposal is addressed through can by then belong to somebody else. A start
 * stamp is the one thing the operating system does not reissue with it, so
 * comparing the stamp read now against the stamp read at spawn is what makes
 * "this is still the tree I spawned" answerable at all.
 *
 * Platform-dispatched for `readProcessParentTable`'s reason and with its
 * posture: the arm that consumes this is Windows', and a reader nothing on this
 * runner executes is a reader nothing checks — so the POSIX branch exists, is
 * exercised against this very process, and keeps the shape honest. Windows is
 * asked through the same `Win32_Process` view the parent table already reads, as
 * `CreationDate.Ticks`, which is an integer rather than a locale-formatted date;
 * POSIX is asked through `ps -o lstart=`, whose one-second resolution is enough
 * for a comparison and is deliberately not claimed to be more.
 *
 * `undefined` means the stamp could not be read, which is not evidence of
 * anything — `SpawnedTreeIdentity` below settles what to do about it.
 */
export function readProcessStartStamp(processId: number): string | undefined {
  if (processId <= 0) {
    return undefined;
  }
  const reported =
    process.platform === "win32"
      ? spawnSync(
          "powershell",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `(Get-CimInstance Win32_Process -Filter "ProcessId=${String(processId)}").CreationDate.Ticks`,
          ],
          { encoding: "utf8" },
        )
      : spawnSync("ps", ["-o", "lstart=", "-p", String(processId)], { encoding: "utf8" });
  if (reported.error !== undefined || reported.status !== 0) {
    return undefined;
  }
  const stamp = reported.stdout.trim();
  return stamp === "" ? undefined : stamp;
}

/** How a root's per-instance start stamp is read, as one injectable reading. */
export type ProcessStartStampReader = (processId: number) => string | undefined;

/**
 * A spawned tree's root, captured while it is certainly still that root.
 *
 * THE HANDLE A PID IS NOT. `terminateExternalTree` walks a tree DOWN from its
 * root pid, and by the time a disposal runs that pid may name an unrelated
 * process — the shim exits early and is reaped, which is the ordinary shape here
 * and not a corner of one. Signalling it terminates a stranger, the platform
 * exits zero, and `ManagedElectronChild` latches on the zero while the browser
 * this package spawned keeps running. So the tree carries an identity from the
 * moment it is spawned, and every later signal re-reads it first.
 *
 * The descendant capture is the second half and cannot be taken at spawn: an
 * Electron has no children in the instant it starts. It is refreshed on every
 * VERIFIED reading instead, so the last set taken while the root was demonstrably
 * this tree's is the set still nameable once the pid stops being. Refreshed only
 * on the verified arm, because a capture taken under an unverifiable identity is
 * a capture nothing can ever consume — the recycled reading it exists for is
 * exactly the reading that arm cannot reach.
 *
 * Every collaborator is injected for this package's usual reason and one
 * stronger: a pid whose holder changes between two reads is not a state a test
 * can arrange against a live process, and it is the only state this class is
 * about.
 */
export class SpawnedTreeIdentity {
  readonly #processId: number;
  readonly #readStamp: ProcessStartStampReader;
  readonly #readParentTable: () => ReadonlyMap<number, number>;
  readonly #rootExists: (processId: number) => boolean;
  readonly #capturedStamp: string | undefined;
  #capturedDescendants: readonly number[] = [];

  constructor(
    processId: number,
    readStamp: ProcessStartStampReader = readProcessStartStamp,
    readParentTable: () => ReadonlyMap<number, number> = readProcessParentTable,
    rootExists: (processId: number) => boolean = processExists,
  ) {
    this.#processId = processId;
    this.#readStamp = readStamp;
    this.#readParentTable = readParentTable;
    this.#rootExists = rootExists;
    this.#capturedStamp = readStamp(processId);
  }

  /**
   * A tree whose root was never captured, for a caller that holds no spawn moment.
   *
   * Named rather than defaulted silently, because what it gives up is exactly
   * what this class exists for: with nothing to compare against, a reissued pid
   * is undetectable and the reading degrades to the one this module took before
   * identity existed — `same` while the pid names anything. The one caller is
   * `terminateProcessTree`'s default, reached from `BoundedCleanup`, which is
   * handed a pid by Playwright rather than by a spawn of its own and so has no
   * moment at which the capture would mean anything.
   */
  static unverified(processId: number): SpawnedTreeIdentity {
    return new SpawnedTreeIdentity(processId, () => undefined);
  }

  /** The members captured while the root last read `same`. */
  get capturedDescendants(): readonly number[] {
    return this.#capturedDescendants;
  }

  /**
   * What the root pid names right now, and a refreshed capture when it is ours.
   *
   * Existence decides `gone` rather than the stamp, and the order is the claim:
   * a stamp that could not be read on a LIVE process is an unreadable probe, and
   * reading that as `gone` would skip the one walk that reaches the tree. So the
   * pid is asked whether it names anything first, and the stamp is asked only to
   * separate ours from somebody else's.
   *
   * An unverifiable pair — no capture, or no current reading — answers `same`.
   * That is a deliberate degradation and not an oversight: refusing every kill on
   * a host whose stamp probe does not work would leak every tree on that host,
   * which is a larger failure than the one this class closes, and detection is
   * impossible there by construction rather than by choice.
   */
  readIdentity(): TreeRootIdentity {
    if (this.#processId <= 0 || !this.#rootExists(this.#processId)) {
      return "gone";
    }
    const currentStamp = this.#readStamp(this.#processId);
    if (this.#capturedStamp === undefined || currentStamp === undefined) {
      return "same";
    }
    if (currentStamp !== this.#capturedStamp) {
      return "recycled";
    }
    this.#capturedDescendants = descendantsOf(this.#processId, this.#readParentTable());
    return "same";
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
 * Signal the process tree led by `processId`, and say whether the TREE is gone.
 *
 * `true` means the signal was delivered or there was nothing left to signal;
 * `false` means something that can still run refused it. A caller escalating
 * from `SIGTERM` asks again after its grace period rather than reading `true` as
 * "gone" — a delivered graceful signal says the tree was asked to exit, not that
 * it has.
 *
 * The verdict is over the TREE and never over the root alone, which is what the
 * arms in `process-tree-arms.ts` are for: this function's whole body is the
 * platform dispatch and the readings each arm is handed. Answering from the root
 * is what let a rootless Windows tree — a reaped launcher shim with a live
 * browser under it — be reported as a delivered kill.
 *
 * `rootIdentity` is the tree's own, captured at the spawn that created it, and
 * the Windows arm refuses to signal `processId` at all unless it re-verifies. The
 * default is the UNVERIFIED one rather than a fresh capture: capturing here would
 * compare the pid against itself an instant later and answer `same` for every
 * pid on the host, which is a check that cannot fail dressed as one that can.
 */
export function terminateProcessTree(
  processId: number,
  signal: NodeJS.Signals = "SIGKILL",
  rootIdentity: SpawnedTreeIdentity = SpawnedTreeIdentity.unverified(processId),
): boolean {
  if (PROCESS_TREE_TERMINATION_MODE === "external") {
    return terminateExternalTree(processId, signal, {
      killTreeFrom: runPlatformTreeKill,
      parentByChild: readProcessParentTable,
      hasTerminated: processHasTerminated,
      rootIdentity: () => rootIdentity.readIdentity(),
      capturedDescendants: () => rootIdentity.capturedDescendants,
    });
  }
  return terminateSignalledTree(processId, signal, {
    deliver: deliverSignal,
    groupHasMember: processGroupExists,
    hasTerminated: processHasTerminated,
  });
}

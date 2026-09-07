// The two platform arms of a tree kill, each as a decision over injected
// collaborators.
//
// `process-tree.ts` beside this owns the READINGS — whether a pid names
// anything, whether it can still run, which mechanism this platform terminates a
// tree with — and dispatches to the arm this platform takes. The arms live here
// because neither of them can be executed on the platform the suite runs on: a
// macOS runner never enters the `taskkill` arm, and a case that entered the
// POSIX arm for real would deliver a signal to a whole process group from inside
// the runner. Both are therefore written as decisions over an injected tool set,
// which is what makes them checkable at all — the same split `readProcessLiveness`
// already makes for its probe pair, one module over.
//
// A TREE IS NOT ITS ROOT, AND THAT IS THE WHOLE SUBJECT HERE
//
// Both arms are asked "did the kill leave anything running", and both used to
// answer it by asking about the ROOT pid alone. That is right only while the
// root is the tree, and it stops being the tree the moment the root exits with a
// descendant still running — which is the ordinary Electron shape rather than a
// corner of one: `node_modules/.bin/electron` is a shim that spawns the browser
// with the shim's own stdout, so the shim can be gone and reaped while the
// browser it started keeps the pipe and keeps running.
//
//   • On POSIX the tree HAS a handle that survives the root, and it is the
//     process group the detached spawn created. `kill(-pid, …)` addresses the
//     group, and a group exists for exactly as long as it has a member — so the
//     honest survival question is asked of `-pid` and not of `pid`. Asked of the
//     root, an `EPERM` on the group followed by an `ESRCH` on the reaped root
//     reports a live tree as terminated.
//
//   • On Windows there is no group. `taskkill /pid <root> /t` DISCOVERS the
//     descendants by walking down from the root, so a root that names nothing
//     hands the walk nothing to find: taskkill exits non-zero, the root-only
//     survival probe says "gone", and the refusal is reported as a delivered
//     kill. `ManagedElectronChild` latches on that report, every later disposal
//     returns early on the latch, and the descendant outlives the run. So the
//     rootless tree is addressed EXPLICITLY here, from the parent table, and the
//     verdict is over every member the walk found rather than over the root.
//
// The Windows parent table is readable after the root is gone because Windows
// does not reparent: a descendant keeps recording the dead root's id.
//
// AND THE ROOT PID IS NOT THE ROOT
//
// A pid is a name the operating system takes back and hands out again, and the
// window in which it does is the ordinary shape here rather than a corner of
// one: the launcher shim exits early, it is reaped, and every later disposal is
// addressed through the number it left behind. `taskkill /pid <reissued> /t`
// then walks a STRANGER's tree, exits zero, and that zero latches
// `ManagedElectronChild` as killed — an unrelated process terminated, the
// descendant this package spawned still running, and the whole thing reported as
// a delivered kill. The parent table is no help either: its rows under that pid
// are the stranger's children.
//
// So identity is a READING like every other one in this module, taken BEFORE
// anything is signalled, and it has three answers because "not ours" is two
// facts and not one:
//
//   • `same` — the pid still names the instance this tree was captured from. It
//     is the only answer under which the root is walked at all.
//   • `gone` — the pid names nothing. The root exited and was reaped, and the
//     parent-table walk above is still this tree's, because Windows does not
//     reparent.
//   • `recycled` — the pid names a DIFFERENT process. Nothing reachable through
//     that number is this tree's, so nothing is signalled through it and the
//     table beneath it is not walked. Only the members captured while the root
//     last read `same` may be addressed, and with no such capture the verdict is
//     a refusal: an empty capture is absence of evidence, and absence of
//     evidence must never read as a clean tree.

import { spawnSync } from "node:child_process";
import process from "node:process";

/**
 * Whether a termination attempt left nothing to worry about.
 *
 * Two ways to succeed, and the second is why this is a function rather than a
 * boolean at each call site. A signal that was delivered is a success. A signal
 * that was NOT is still a success if there is nothing left to kill — which is
 * the ordinary outcome when a process exited between a close timing out and the
 * kill being issued.
 *
 * `treeStillRunning` is the TREE's question and never the root's. Both arms
 * below compose it from what their platform can actually answer about a whole
 * tree, and getting that composition wrong is the defect this module's header
 * describes rather than a subtlety.
 */
export function terminationSucceeded(
  signalDelivered: boolean,
  treeStillRunning: () => boolean,
): boolean {
  return signalDelivered || !treeStillRunning();
}

/** What the POSIX arm needs from the platform, as one injectable set. */
export interface SignalTreeTools {
  /** Deliver `signal` to `target`, and say whether it landed rather than throwing. */
  readonly deliver: (target: number, signal: NodeJS.Signals) => boolean;
  /** Whether the process group led by `processId` still holds any member. */
  readonly groupHasMember: (processId: number) => boolean;
  /** Whether `processId` itself will never run another instruction. */
  readonly hasTerminated: (processId: number) => boolean;
}

/**
 * Whether the pid a tree is addressed THROUGH still names that tree's root.
 *
 * Three answers rather than two, because "not ours" splits into two facts that
 * owe different behaviour — the module header has the mechanism. `gone` keeps
 * the parent-table walk, which Windows' no-reparenting rule leaves readable
 * after the root exits; `recycled` forfeits both the root and the table.
 */
export type TreeRootIdentity = "same" | "gone" | "recycled";

/** What the Windows arm needs from the platform, as one injectable set. */
export interface ExternalTreeTools {
  /** Run the platform's tree kill downwards from `processId`; `true` if it exited clean. */
  readonly killTreeFrom: (processId: number, forced: boolean) => boolean;
  /** Every process on this host, as child pid to parent pid. */
  readonly parentByChild: () => ReadonlyMap<number, number>;
  /** Whether `processId` will never run another instruction. */
  readonly hasTerminated: (processId: number) => boolean;
  /**
   * What the root pid names right now, relative to what this tree captured.
   *
   * Asked before anything is signalled, because a signal is the one act that
   * cannot be taken back: a `taskkill` issued at a reissued pid has already
   * terminated a stranger by the time any verdict is computed.
   */
  readonly rootIdentity: () => TreeRootIdentity;
  /**
   * The members captured while the root last read `same`.
   *
   * The only handle on this tree that survives its root's pid being reissued.
   * Empty is a legitimate answer and is read as "nothing of this tree is
   * nameable" rather than as "this tree is gone".
   */
  readonly capturedDescendants: () => readonly number[];
}

/**
 * Signal the group `processId` leads, and say whether the TREE is gone.
 *
 * The negative form first, because it is the only form that reaches the browser
 * behind the launcher shim; the leader alone is the narrowing fallback for a
 * child that leads no group, and this arm never widens past it.
 *
 * The survival question is the GROUP's. A group outlives its leader — it exists
 * while any member does — so this is the reading that stays right across the
 * root's exit, and it is the one the root-only probe got wrong.
 */
export function terminateSignalledTree(
  processId: number,
  signal: NodeJS.Signals,
  tools: SignalTreeTools,
): boolean {
  for (const target of [-processId, processId]) {
    if (tools.deliver(target, signal)) {
      return true;
    }
  }
  // Both deliveries failed, and ESRCH on an empty group is the commonest reason.
  // Reporting that as a failed termination would tell a reader an Electron may
  // still be holding a profile when nothing is; reporting an EPERM on a LIVE
  // group as a success is the same misdescription in the opposite direction.
  return terminationSucceeded(
    false,
    () => tools.groupHasMember(processId) || !tools.hasTerminated(processId),
  );
}

/**
 * Walk `processId`'s tree with the platform's own tree kill, then address what it could not reach.
 *
 * IDENTITY FIRST, AND ONLY THEN A SIGNAL. The pid is read before it is used, and
 * it is walked only under `same` — the module header has why a reissued pid
 * walked here terminates a stranger and reports the surviving descendant as
 * killed. `gone` and `recycled` both skip the root outright; what separates them
 * is whether the parent table beneath that number is still this tree's.
 *
 * The second pass is not a retry of the first. `taskkill /t` finds descendants by
 * walking DOWN from the root, so a root that names nothing gives it nothing to
 * find — and the tree it could not find is exactly the tree that outlives the
 * run. Those members are taken from the parent table, from what was captured
 * while the root was verifiably this tree's, or from both, and killed by name.
 * The verdict is over every one of them: a rootless termination is never
 * accepted as delivered on the strength of the root being gone.
 */
export function terminateExternalTree(
  processId: number,
  signal: NodeJS.Signals,
  tools: ExternalTreeTools,
): boolean {
  const forced = signal === "SIGKILL";
  const identity = tools.rootIdentity();
  if (identity === "same" && tools.killTreeFrom(processId, forced)) {
    return true;
  }
  const members = addressableTreeMembers(processId, identity, tools);
  const unreachedMembers = members.filter((member) => !tools.hasTerminated(member));
  for (const member of unreachedMembers) {
    tools.killTreeFrom(member, forced);
  }
  if (identity === "recycled" && members.length === 0) {
    // Nothing of this tree can be named: the pid belongs to somebody else and
    // nothing was captured while it was ours, so there is no reading to take.
    // Reporting a kill here is the false success this whole module exists to
    // prevent, one step further out — the caller's retry and its eventual
    // `unterminable` are the honest answers to "we cannot see it".
    return false;
  }
  return terminationSucceeded(
    false,
    () =>
      // The root is part of the survival question only while it is still this
      // tree's. Under `recycled` it is a stranger, and a live stranger would
      // report this tree as unkillable forever; under `gone` it answers
      // terminated, and asking anyway is what catches an identity read that
      // raced a root which had not in fact exited.
      (identity !== "recycled" && !tools.hasTerminated(processId)) ||
      unreachedMembers.some((member) => !tools.hasTerminated(member)),
  );
}

/**
 * The members this arm may address, given what the root pid turned out to name.
 *
 * A set rather than a list because the two sources overlap on every ordinary
 * reading, and addressing a member twice would spawn a second `taskkill` at a
 * process the first one already took.
 *
 * The parent table is admitted for `same` and `gone` and refused for `recycled`,
 * which is the whole discrimination: under the first two the rows beneath the
 * root pid are this tree's — Windows does not reparent, so they survive the
 * root — and under the third they are a stranger's children, which this arm must
 * never kill however plainly they are "descendants of that pid".
 */
function addressableTreeMembers(
  processId: number,
  identity: TreeRootIdentity,
  tools: ExternalTreeTools,
): number[] {
  const captured = tools.capturedDescendants();
  if (identity === "recycled") {
    return [...new Set(captured)];
  }
  return [...new Set([...descendantsOf(processId, tools.parentByChild()), ...captured])];
}

/**
 * Every process below `rootProcessId` in `parentByChild`, transitively.
 *
 * A breadth walk with a visited set rather than recursion, and the set is
 * load-bearing rather than tidy: a parent table is a snapshot of a host whose
 * pids are reused, so a row pair naming each other as parents is representable
 * and a walk without the set would never return. The root is not in the result —
 * the caller already holds it, and the two are terminated for different reasons.
 */
export function descendantsOf(
  rootProcessId: number,
  parentByChild: ReadonlyMap<number, number>,
): number[] {
  const childrenByParent = new Map<number, number[]>();
  for (const [childProcessId, parentProcessId] of parentByChild) {
    const siblings = childrenByParent.get(parentProcessId);
    if (siblings === undefined) {
      childrenByParent.set(parentProcessId, [childProcessId]);
    } else {
      siblings.push(childProcessId);
    }
  }
  const discovered = new Set<number>([rootProcessId]);
  const pending = [rootProcessId];
  const descendants: number[] = [];
  while (pending.length > 0) {
    const parentProcessId = pending.shift() as number;
    for (const childProcessId of childrenByParent.get(parentProcessId) ?? []) {
      if (discovered.has(childProcessId)) {
        continue;
      }
      discovered.add(childProcessId);
      descendants.push(childProcessId);
      pending.push(childProcessId);
    }
  }
  return descendants;
}

/**
 * A child-to-parent table out of whitespace-separated `pid ppid` lines.
 *
 * One parser for both platforms, which is why both readers below are asked to
 * emit that shape rather than their native one: two parsers over two output
 * formats are two things that drift, and the format is the caller's to choose.
 * A line that is not two integers is a header or a warning and contributes
 * nothing — reporting it would put a `ps` banner in a kill list.
 */
export function parseProcessParentTable(tableText: string): Map<number, number> {
  const parentByChild = new Map<number, number>();
  for (const line of tableText.split("\n")) {
    const [childField, parentField, ...rest] = line.trim().split(/\s+/);
    if (rest.length > 0 || childField === undefined || parentField === undefined) {
      continue;
    }
    const childProcessId = Number(childField);
    const parentProcessId = Number(parentField);
    if (!Number.isInteger(childProcessId) || !Number.isInteger(parentProcessId)) {
      continue;
    }
    parentByChild.set(childProcessId, parentProcessId);
  }
  return parentByChild;
}

/**
 * This host's child-to-parent table, or an empty one if it could not be read.
 *
 * Platform-dispatched rather than Windows-only, even though the arm that
 * consumes it is Windows'. A reader nothing on this runner ever executes is a
 * reader nothing checks, and the parsing above is only half the claim — that the
 * command emits the shape it is parsed as is the other half, and the POSIX
 * branch is what makes it checkable here.
 *
 * An empty table is the honest answer to an unreadable one: it names no
 * descendant, so the arm above reports a refusal rather than inventing pids.
 */
export function readProcessParentTable(): Map<number, number> {
  const listing =
    process.platform === "win32"
      ? spawnSync(
          "powershell",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }',
          ],
          { encoding: "utf8" },
        )
      : spawnSync("ps", ["-Ao", "pid=,ppid="], { encoding: "utf8" });
  if (listing.error !== undefined || listing.status !== 0) {
    return new Map<number, number>();
  }
  return parseProcessParentTable(listing.stdout);
}

/**
 * Run this platform's tree kill downwards from `processId`.
 *
 * `taskkill /pid N /t` walks the descendant tree: without `/f` it posts WM_CLOSE
 * to each windowed process (the graceful analog — the tree members that matter
 * here all have windows), with `/f` it terminates every node outright (the
 * SIGKILL analog). This is also the form `playwright-core` itself runs.
 *
 * A non-zero exit is not automatically a failure — a tree already gone is one of
 * the things taskkill refuses — so this reports the STATUS and the arm above
 * decides, asking the operating system rather than reading taskkill's message,
 * which is localised and must not depend on the runner's display language.
 */
export function runPlatformTreeKill(processId: number, forced: boolean): boolean {
  const result = spawnSync(
    "taskkill",
    ["/pid", String(processId), "/t", ...(forced ? ["/f"] : [])],
    { stdio: "ignore" },
  );
  return result.error === undefined && result.status === 0;
}

/**
 * Deliver `signal` to `target`, reporting a throw as a failure to deliver.
 *
 * The negative targets this is asked about address a process GROUP, which is the
 * launched tree only because the spawn was detached — so this is deliberately a
 * thin, named seam rather than an inline `try` at the one call site: the arm
 * above is drivable without it only if the delivery is somebody else's to supply.
 */
export function deliverSignal(target: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(target, signal);
    return true;
  } catch {
    // Group already reaped, this pid does not lead one, or it is out of reach.
    return false;
  }
}

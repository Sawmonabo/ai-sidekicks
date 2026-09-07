// The two platform arms of a tree kill, each as a decision over injected
// collaborators.
//
// `readers.ts`, `liveness.ts` and `identity.ts` own the READINGS — what this host
// says, whether a pid can still run, whether it still names what it named — and
// `dispatch.ts` picks the arm this platform takes. The arms live here because
// neither of them can be executed on the platform the suite runs on: a macOS
// runner never enters the `taskkill` arm, and a case that entered the POSIX arm
// for real would deliver a signal to a whole process group from inside the
// runner. Both are therefore written as decisions over an injected tool set,
// which is what makes them checkable at all — the same split `readProcessLiveness`
// already makes for its probe pair.
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
//     rootless tree is addressed EXPLICITLY here and the verdict is over every
//     member the arm can name rather than over the root.
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
// a delivered kill.
//
// So identity is a READING like every other one here, taken BEFORE anything is
// signalled, and it has three answers because "not ours" is two facts and not
// one:
//
//   • `same` — the pid still names the instance this tree was captured from. It
//     is the only answer under which the root is walked at all.
//   • `gone` — the pid names nothing. The root exited and was reaped.
//   • `recycled` — the pid names a DIFFERENT process. Nothing reachable through
//     that number is this tree's, so nothing is signalled through it. Only the
//     members captured while the root last read `same` may be addressed, and
//     with no such capture the verdict is a refusal: an empty capture is absence
//     of evidence, and absence of evidence must never read as a clean tree.
//
// THE PARENT TABLE IS SOUND EVIDENCE IN EXACTLY ONE DIRECTION
//
// Windows does not reparent, so a live descendant keeps recording its tree's
// root pid after that root has exited — and it also RETAINS that column when the
// pid's former holder died long before this tree was ever spawned. Both rows look
// identical. A table that lists nothing beneath the root pid is therefore proof
// that nothing claims it; a table that lists something is no proof at all that
// what it lists is ours.
//
// That asymmetry is spent here and nowhere else:
//
//   • Under `gone` the rows beneath the root pid are a SURVIVAL reading and never
//     a kill list. The members addressed are the captured ones this tree verified
//     for itself; a row nothing verified is a reason to refuse the verdict, never
//     a pid to hand `taskkill`. Reading it as a kill list is what took a
//     long-lived child of an OLDER process that once held the number and passed
//     it to `taskkill` as though it were this tree's.
//   • Under `same` the walk stays a kill list, because it reaches nothing the
//     platform's own walk did not: `taskkill /pid <live root> /t` discovers its
//     descendants from that same table, so narrowing the second pass would narrow
//     nothing the first pass had not already reached.
//   • Under `recycled` the table is not consulted in either direction. Rows
//     beneath a reissued number are as likely the new holder's children as this
//     tree's, and a live stranger with a child would hold the verdict at `false`
//     for as long as it lived — a refusal that can never clear.
//
// The residual is named rather than hidden: under `gone`, a stale row whose
// process outlives the run holds the verdict at `false` for the caller's bounded
// attempts and ends as a reported `unterminable`. That is the failure direction
// this module takes everywhere — a refusal a reader can see, rather than a clean
// tree nobody can check.

import process from "node:process";

import {
  verifyCapturedMembers,
  type CapturedTreeMember,
  type TreeRootIdentity,
} from "./identity.js";
import {
  descendantsOf,
  runBoundedHostCommand,
  type ProcessTableReader,
  type ProcessTableRow,
} from "./readers.js";

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

/** What the Windows arm needs from the platform, as one injectable set. */
export interface ExternalTreeTools {
  /** Run the platform's tree kill downwards from `processId`; `true` if it exited clean. */
  readonly killTreeFrom: (processId: number, forced: boolean) => boolean;
  /** Every process on this host, as pid to its recorded parent and start stamp. */
  readonly processTable: ProcessTableReader;
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
   * The members captured while the root last read `same`, each with its stamp.
   *
   * The only handle on this tree that survives its root's pid being reissued,
   * and the only source a rootless kill list is built from. Empty is a
   * legitimate answer and is read as "nothing of this tree is nameable" rather
   * than as "this tree is gone".
   */
  readonly capturedDescendants: () => readonly CapturedTreeMember[];
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
 * killed.
 *
 * The second pass is not a retry of the first. `taskkill /t` finds descendants by
 * walking DOWN from the root, so a root that names nothing gives it nothing to
 * find — and the tree it could not find is exactly the tree that outlives the
 * run. Those members come from what this tree captured while the root was
 * verifiably its own, verified pid by pid, and they are killed by name. The
 * verdict is over every one of them AND over every row this host still hangs off
 * the root pid: a rootless termination is never accepted as delivered on the
 * strength of the root being gone, and a row this tree cannot vouch for is a
 * reason to refuse rather than a pid to signal.
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
  // ONE READ, then every decision below is taken over the same snapshot. Two
  // reads would let the kill list and the survival reading disagree about which
  // host they describe, which is the class of race this whole module is about.
  const processTable = tools.processTable();
  const captured = tools.capturedDescendants();
  const members = addressableTreeMembers(processId, identity, processTable, captured);
  const unreachedMembers = members.filter((member) => !tools.hasTerminated(member));
  for (const member of unreachedMembers) {
    tools.killTreeFrom(member, forced);
  }
  if (identity === "recycled" && captured.length === 0) {
    // Nothing of this tree can be named: the pid belongs to somebody else and
    // nothing was captured while it was ours, so there is no reading to take.
    // Reporting a kill here is the false success this whole module exists to
    // prevent, one step further out — the caller's retry and its eventual
    // `unterminable` are the honest answers to "we cannot see it". Asked of the
    // CAPTURE rather than of what survived verification: a captured pid the
    // stamps convict of being somebody else is evidence that the member it
    // named has exited, which is the opposite of having nothing to go on.
    return false;
  }
  const claimants = unverifiedRootClaimants(processId, identity, processTable, members);
  return terminationSucceeded(
    false,
    () =>
      // The root is part of the survival question only while it is still this
      // tree's. Under `recycled` it is a stranger, and a live stranger would
      // report this tree as unkillable forever; under `gone` it answers
      // terminated, and asking anyway is what catches an identity read that
      // raced a root which had not in fact exited.
      (identity !== "recycled" && !tools.hasTerminated(processId)) ||
      unreachedMembers.some((member) => !tools.hasTerminated(member)) ||
      claimants.some((claimant) => !tools.hasTerminated(claimant)),
  );
}

/**
 * The members this arm may SIGNAL, given what the root pid turned out to name.
 *
 * A set rather than a list because the two sources overlap on every ordinary
 * reading, and addressing a member twice would spawn a second `taskkill` at a
 * process the first one already took.
 *
 * The table walk is admitted for `same` alone. Under `gone` and `recycled` the
 * kill list is the CAPTURE, verified pid by pid against the stamps in this same
 * table — the header states the asymmetry that makes those three different, and
 * `verifyCapturedMembers` states what a stamp has to say before a member is
 * dropped.
 */
function addressableTreeMembers(
  processId: number,
  identity: TreeRootIdentity,
  processTable: ReadonlyMap<number, ProcessTableRow>,
  captured: readonly CapturedTreeMember[],
): number[] {
  const verified = verifyCapturedMembers(captured, processTable);
  if (identity !== "same") {
    return [...new Set(verified)];
  }
  return [...new Set([...descendantsOf(processId, processTable), ...verified])];
}

/**
 * The rows this host still hangs off the root pid that this tree cannot vouch for.
 *
 * READ AND NEVER SIGNALLED. Each one is either a descendant this tree never
 * captured or a leftover child of whoever held the number before it, and nothing
 * in the table can tell those apart — so killing one risks an unrelated process
 * and ignoring one risks reporting a live tree as gone. Refusing the verdict is
 * the only answer that does neither.
 *
 * Empty for every identity but `gone`, and the header says why: under `same` the
 * walk is already the kill list, and under `recycled` the rows belong at least as
 * much to the pid's new holder as to this tree, so reading them would hold the
 * verdict at `false` for as long as that stranger lived.
 */
function unverifiedRootClaimants(
  processId: number,
  identity: TreeRootIdentity,
  processTable: ReadonlyMap<number, ProcessTableRow>,
  addressed: readonly number[],
): number[] {
  if (identity !== "gone") {
    return [];
  }
  const addressedMembers = new Set(addressed);
  return descendantsOf(processId, processTable).filter(
    (claimant) => !addressedMembers.has(claimant),
  );
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
 *
 * Run through the one bounded door in `readers.ts` for the reason every other
 * host command here is: it is a `spawnSync`, so a `taskkill` that does not
 * return blocks the thread vitest's own timeout runs on. A caller inside a
 * deadline passes what is left of it; a bound already spent runs nothing and
 * reports the kill as undelivered, which is the reading that keeps the caller
 * escalating rather than one that claims a tree it never signalled.
 */
export function runPlatformTreeKill(
  processId: number,
  forced: boolean,
  remainingBudgetMilliseconds?: number,
): boolean {
  const result = runBoundedHostCommand(
    "taskkill",
    ["/pid", String(processId), "/t", ...(forced ? ["/f"] : [])],
    remainingBudgetMilliseconds,
  );
  return result !== undefined && result.error === undefined && result.status === 0;
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

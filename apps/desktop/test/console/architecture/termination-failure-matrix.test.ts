// Every state the termination path can be asked in, enumerated, with the verdict
// each one owes.
//
// WHY AN ENUMERATION RATHER THAN A CASE PER DEFECT. Separate findings against
// this path — a refused `taskkill` read as a kill, an unreaped zombie read as a
// live process, a root that exited while a descendant held its stdio, a
// settle-time registration that threw over a child already running, a root pid
// the operating system had already handed to somebody else — were each one CELL
// of the same table, and each was fixed where it was found. A fix that closes one
// cell and reopens another is invisible to a suite organised by finding. The
// findings are deliberately not counted here: the count moved once per round, and
// the table below is the record that cannot go stale silently.
//
// THE FIVE AXES, AND WHY THESE FIVE. They are the independent variables the
// termination decision actually reads: what the root PID names (it is the handle
// a tree is addressed through, and it names this tree's root, nothing, or an
// unrelated process that inherited the number), what the PLATFORM said about the
// kill, which MECHANISM this platform's tree kill is (a delivered group signal,
// or `taskkill` walking a descendant tree), what is left RUNNING, and whether the
// settle-time REGISTRATION that owns the retry was accepted. Each axis declares
// its own values below, where the coverage control can read them; restating them
// here would be a second roster that drifts from the first. Each finding sits at
// a distinct point in that space.
//
// WHAT IS DRIVEN, AND WHAT CANNOT BE. No platform can be asked to refuse a kill
// on demand, no runner can be made Windows, and a zombie is the reaping behaviour
// of an init this process does not own. So the platform I/O stays unexecuted by
// construction — `process-tree.test.ts` says the same about itself — and the
// DECISIONS those arms funnel through are driven directly with scripted
// collaborators, which is why each is a named exported function rather than an
// expression at a call site. The one cell that needs a real child gets one.

import { describe, expect, it } from "vitest";

import {
  terminateExternalTree,
  terminateSignalledTree,
  type ExternalTreeTools,
  type SignalTreeTools,
  type TreeRootIdentity,
} from "../../helpers/process-tree-arms.js";
import { PROCESS_TREE_TERMINATION_MODE, readProcessLiveness } from "../../helpers/process-tree.js";
import {
  LIFETIME_TEST_TIMEOUT_MS,
  RefusedRegistrationSpawn,
} from "./electron-child-lifetime.test-support.js";
import { expectTerminatedWithin, reap } from "./electron-child-liveness.test-support.js";

/**
 * What the root pid names when termination is asked for.
 *
 * `recycled` is the state that is not about this tree at all: the root exited,
 * was reaped, and the operating system handed its number to an unrelated
 * process. It is a state of the PID rather than of the root, which is why it
 * belongs on this axis — every reading a termination takes is taken through that
 * number.
 */
type RootState = "alive" | "exited-holding-stdio" | "reaped-with-nothing-behind-it" | "recycled";

/**
 * What the platform said about the kill this path issued.
 *
 * `never-asked` is a fourth answer rather than a shade of refusal: a path that
 * declines to signal at all and one that signalled and was refused are different
 * facts, and conflating them would let a cell asserting "the stranger was never
 * touched" be satisfied by one that touched it and lost.
 */
type PlatformAnswer = "delivered" | "refused-then-delivered" | "refused-throughout" | "never-asked";

/** Which mechanism this platform's tree kill is. */
type TreeMode = "signal" | "external";

/**
 * What is still able to run once the kill has been issued.
 *
 * `unobservable` is not "nothing": it is a tree whose root pid belongs to
 * somebody else and of which nothing was captured while it did not, so there is
 * no reading to take in either direction. It owes a refusal for that reason —
 * absence of evidence is the one thing this path must never report as a clean
 * tree.
 */
type SurvivingMember = "nothing" | "descendant" | "unreaped-zombie" | "unobservable";

/** Whether the settle-time registration that owns the retry was accepted. */
type SettleRegistration = "accepted" | "refused";

interface TerminationAxes {
  readonly root: RootState;
  readonly platformAnswer: PlatformAnswer;
  readonly treeMode: TreeMode;
  readonly surviving: SurvivingMember;
  readonly settleRegistration: SettleRegistration;
}

/**
 * One cell: the state, the verdict it owes, and the real code that answers.
 *
 * `owedTermination` is `true` only where nothing that could still execute is
 * left — a `false` costs a retry and a wrong `true` costs an Electron that
 * outlives the run, so a cell whose answer is uncertain owes `false`.
 */
interface TerminationCell {
  readonly name: string;
  readonly axes: TerminationAxes;
  readonly owedTermination: boolean;
  readonly answer: () => Promise<boolean>;
}

/** A pid that names nothing here, since every cell below scripts its own answers. */
const ROOT_PID = 4242;
/** The descendant a rootless tree leaves behind, addressable only explicitly. */
const DESCENDANT_PID = 4243;
/**
 * A child of whoever holds `ROOT_PID` once it has been reissued.
 *
 * The pid that makes the recycled cells non-vacuous: it is what a parent-table
 * walk from `ROOT_PID` hands back after the reissue, so a cell asserting "the
 * stranger's tree was not walked" has something concrete to be false about.
 */
const IMPOSTOR_CHILD_PID = 4244;

/**
 * The external arm's collaborators, scripted. `hasTerminated` is handed the pids
 * the arm ran a tree kill from, so "it addressed the descendant" is separable
 * from "it reported success without looking": a scripted tree dies only if named.
 *
 * `rootIdentity` and `capturedDescendants` default to the ordinary reading — the
 * pid is still this tree's, and nothing has been captured beyond what the table
 * says — so a cell that is not about a reissued pid says nothing about one.
 */
function scriptedExternalTools(script: {
  readonly killTreeFrom: (processId: number) => boolean;
  readonly parentByChild: ReadonlyMap<number, number>;
  readonly hasTerminated: (processId: number, killAttempts: readonly number[]) => boolean;
  readonly rootIdentity?: TreeRootIdentity;
  readonly capturedDescendants?: readonly number[];
}): ExternalTreeTools & { readonly killedFrom: readonly number[] } {
  const killedFrom: number[] = [];
  return {
    killedFrom,
    killTreeFrom: (processId: number): boolean => {
      killedFrom.push(processId);
      return script.killTreeFrom(processId);
    },
    parentByChild: () => script.parentByChild,
    hasTerminated: (processId: number): boolean => script.hasTerminated(processId, killedFrom),
    rootIdentity: () => script.rootIdentity ?? "same",
    capturedDescendants: () => script.capturedDescendants ?? [],
  };
}

/** A parent table in which `DESCENDANT_PID` still records `ROOT_PID` as its parent. */
const ROOTLESS_TREE_TABLE: ReadonlyMap<number, number> = new Map([[DESCENDANT_PID, ROOT_PID]]);

/**
 * A parent table taken AFTER the reissue: the rows under `ROOT_PID` are the
 * stranger's children, and this tree's descendant is not in it at all.
 */
const REISSUED_ROOT_TABLE: ReadonlyMap<number, number> = new Map([[IMPOSTOR_CHILD_PID, ROOT_PID]]);

/**
 * The tools for a rootless tree whose descendant takes, or refuses, an explicit
 * kill. The root is gone throughout — that is what makes the tree rootless — so
 * the only pid whose fate can change is the descendant's, and it changes only if
 * the arm actually addressed it.
 */
function rootlessTreeTools(
  descendantYieldsToExplicitKill: boolean,
): ExternalTreeTools & { readonly killedFrom: readonly number[] } {
  return scriptedExternalTools({
    // The walk starts at the root, and a pid that names nothing has no tree to
    // walk, so `taskkill` exits non-zero however alive the descendant is.
    killTreeFrom: (processId: number) => processId !== ROOT_PID && descendantYieldsToExplicitKill,
    parentByChild: ROOTLESS_TREE_TABLE,
    hasTerminated: (processId: number, killAttempts: readonly number[]) =>
      processId === ROOT_PID ||
      (descendantYieldsToExplicitKill && killAttempts.includes(processId)),
    rootIdentity: "gone",
  });
}

/**
 * The tools for a tree whose root pid has been handed to somebody else.
 *
 * The STRANGER is scripted to take the kill and to stay alive — both halves
 * matter. Taking it is the clean `taskkill` exit that used to latch the child as
 * killed; staying alive is what makes "the root was signalled" observable in
 * `hasTerminated` as well as in `killedFrom`, so a rewrite cannot satisfy the
 * cell by signalling and then reading the wrong pid.
 */
function reissuedRootTools(
  capturedDescendants: readonly number[],
  capturedDescendantIsGone = false,
): ExternalTreeTools & { readonly killedFrom: readonly number[] } {
  return scriptedExternalTools({
    killTreeFrom: () => true,
    parentByChild: REISSUED_ROOT_TABLE,
    hasTerminated: (processId: number) =>
      processId === DESCENDANT_PID ? capturedDescendantIsGone : false,
    rootIdentity: "recycled",
    capturedDescendants,
  });
}

/** A liveness probe pair that reports one scripted state for a pid that exists. */
function scriptedLiveness(stateCode: string): { exists: () => boolean; stateCode: () => string } {
  return { exists: () => true, stateCode: () => stateCode };
}

/**
 * The POSIX arm's collaborators, scripted: nothing delivers, and the case says
 * what the GROUP and the ROOT each still hold. Both are supplied separately
 * because the whole cell is that they disagree — the root reaped and its group
 * not empty, which a shim exiting under a live browser produces on every run.
 */
function undeliverableSignalTools(script: {
  readonly groupHasMember: boolean;
  readonly rootHasTerminated: boolean;
}): SignalTreeTools {
  return {
    deliver: () => false,
    groupHasMember: () => script.groupHasMember,
    hasTerminated: () => script.rootHasTerminated,
  };
}

const TERMINATION_MATRIX: readonly TerminationCell[] = [
  {
    name: "the ordinary kill: the platform delivered, so nothing further is asked",
    axes: {
      root: "alive",
      platformAnswer: "delivered",
      treeMode: "external",
      surviving: "nothing",
      settleRegistration: "accepted",
    },
    owedTermination: true,
    answer: () =>
      Promise.resolve(
        terminateExternalTree(
          ROOT_PID,
          "SIGKILL",
          scriptedExternalTools({
            killTreeFrom: () => true,
            parentByChild: new Map(),
            hasTerminated: () => false,
          }),
        ),
      ),
  },
  {
    name: "a refused kill over a live root is a refusal, not a kill",
    axes: {
      root: "alive",
      platformAnswer: "refused-throughout",
      treeMode: "external",
      surviving: "descendant",
      settleRegistration: "accepted",
    },
    owedTermination: false,
    answer: () =>
      Promise.resolve(
        terminateExternalTree(
          ROOT_PID,
          "SIGKILL",
          scriptedExternalTools({
            killTreeFrom: () => false,
            parentByChild: ROOTLESS_TREE_TABLE,
            hasTerminated: () => false,
          }),
        ),
      ),
  },
  {
    name: "a rootless tree is addressed through its descendants, never reported gone with the root",
    axes: {
      root: "exited-holding-stdio",
      platformAnswer: "refused-then-delivered",
      treeMode: "external",
      surviving: "descendant",
      settleRegistration: "accepted",
    },
    owedTermination: true,
    // The verdict AND the evidence, because the verdict alone is satisfiable the
    // wrong way: an arm reporting the tree gone because its ROOT is gone answers
    // `true` without naming the descendant. Conjoining the ask discriminates.
    answer: () => {
      const tools = rootlessTreeTools(true);
      const terminated = terminateExternalTree(ROOT_PID, "SIGKILL", tools);
      return Promise.resolve(terminated && tools.killedFrom.includes(DESCENDANT_PID));
    },
  },
  {
    name: "a rootless tree whose descendant survives every ask is a refusal",
    axes: {
      root: "exited-holding-stdio",
      platformAnswer: "refused-throughout",
      treeMode: "external",
      surviving: "descendant",
      settleRegistration: "accepted",
    },
    owedTermination: false,
    answer: () =>
      Promise.resolve(terminateExternalTree(ROOT_PID, "SIGKILL", rootlessTreeTools(false))),
  },
  {
    name: "a reaped root with nothing behind it is the ordinary nothing-left-to-signal success",
    axes: {
      root: "reaped-with-nothing-behind-it",
      platformAnswer: "refused-throughout",
      treeMode: "external",
      surviving: "nothing",
      settleRegistration: "accepted",
    },
    owedTermination: true,
    answer: () =>
      Promise.resolve(
        terminateExternalTree(
          ROOT_PID,
          "SIGKILL",
          scriptedExternalTools({
            killTreeFrom: () => false,
            parentByChild: new Map(),
            hasTerminated: () => true,
          }),
        ),
      ),
  },
  {
    // THE PID IS A NAME AND THE NAME WAS REISSUED. The root exited, was reaped,
    // and its number now belongs to an unrelated process — the ordinary shape
    // here, since the launcher shim exits under a live browser. `taskkill /pid
    // <that number> /t` walks the STRANGER's tree, exits zero, and that zero
    // used to latch `ManagedElectronChild` as killed while this package's own
    // descendant kept running. Two claims, and the second is the one the verdict
    // alone cannot make: nothing reachable through the reissued number was
    // signalled, and the member captured while the pid was still this tree's was.
    name: "a reissued root pid is signalled by nothing, and the tree it no longer names is not reported killed",
    axes: {
      root: "recycled",
      platformAnswer: "refused-throughout",
      treeMode: "external",
      surviving: "descendant",
      settleRegistration: "accepted",
    },
    owedTermination: false,
    answer: () => {
      const tools = reissuedRootTools([DESCENDANT_PID]);
      const terminated = terminateExternalTree(ROOT_PID, "SIGKILL", tools);
      expect(
        tools.killedFrom,
        "the reissued root pid was signalled — an unrelated process was terminated by this cleanup",
      ).not.toContain(ROOT_PID);
      expect(
        tools.killedFrom,
        "the parent table was walked from a reissued pid — the stranger's own child was signalled",
      ).not.toContain(IMPOSTOR_CHILD_PID);
      expect(
        tools.killedFrom,
        "the member captured while the pid was still this tree's was never addressed",
      ).toContain(DESCENDANT_PID);
      return Promise.resolve(terminated);
    },
  },
  {
    name: "a reissued root pid over a captured tree that is already gone is the honest success",
    axes: {
      root: "recycled",
      platformAnswer: "never-asked",
      treeMode: "external",
      surviving: "nothing",
      settleRegistration: "accepted",
    },
    // The foil for the cell above, and the reason the refusal there is about
    // EVIDENCE rather than about the word `recycled`. Everything this tree was
    // ever known to hold has terminated, so there is nothing to kill and nothing
    // to report — a path that answered `false` for every reissued pid would hold
    // teardown open on every ordinary Windows run whose shim was reaped early.
    owedTermination: true,
    answer: () => {
      const tools = reissuedRootTools([DESCENDANT_PID], true);
      const terminated = terminateExternalTree(ROOT_PID, "SIGKILL", tools);
      expect(
        tools.killedFrom,
        "something was signalled over a tree already gone — the reissued pid is being asked about rather than read",
      ).toStrictEqual([]);
      return Promise.resolve(terminated);
    },
  },
  {
    name: "a reissued root pid with nothing captured is a refusal, because there is no reading to take",
    axes: {
      root: "recycled",
      platformAnswer: "never-asked",
      treeMode: "external",
      surviving: "unobservable",
      settleRegistration: "accepted",
    },
    // The third arm, and the one a fix that stopped at "do not signal a reissued
    // pid" would get wrong: with nothing captured there is no member to address
    // and no member to read, and reporting the tree gone on that basis is the
    // same false success as walking the stranger — quieter, and with the same
    // Electron left running. The caller's bounded retry and its eventual
    // `unterminable` are what a reader is owed here.
    owedTermination: false,
    answer: () => {
      const tools = reissuedRootTools([]);
      const terminated = terminateExternalTree(ROOT_PID, "SIGKILL", tools);
      expect(
        tools.killedFrom,
        "a pid was signalled although this tree is unobservable — something was guessed at",
      ).toStrictEqual([]);
      return Promise.resolve(terminated);
    },
  },
  {
    name: "a group signal that could not be delivered while the GROUP still holds a member",
    axes: {
      root: "exited-holding-stdio",
      platformAnswer: "refused-throughout",
      treeMode: "signal",
      surviving: "descendant",
      settleRegistration: "accepted",
    },
    owedTermination: false,
    // The reading that must be the GROUP's rather than the root's. The root is
    // reaped — a root-only probe therefore reports it gone — while the
    // descendant it left is still in the group the detached spawn created, and
    // a group is alive for as long as one member is.
    answer: () =>
      Promise.resolve(
        terminateSignalledTree(
          ROOT_PID,
          "SIGKILL",
          undeliverableSignalTools({ groupHasMember: true, rootHasTerminated: true }),
        ),
      ),
  },
  {
    name: "a group signal that could not be delivered because the group is empty",
    axes: {
      root: "reaped-with-nothing-behind-it",
      platformAnswer: "refused-throughout",
      treeMode: "signal",
      surviving: "nothing",
      settleRegistration: "accepted",
    },
    owedTermination: true,
    answer: () =>
      Promise.resolve(
        terminateSignalledTree(
          ROOT_PID,
          "SIGKILL",
          undeliverableSignalTools({ groupHasMember: false, rootHasTerminated: true }),
        ),
      ),
  },
  {
    name: "an unreaped zombie is terminated, whatever its pid still answers",
    axes: {
      root: "reaped-with-nothing-behind-it",
      platformAnswer: "delivered",
      treeMode: "signal",
      surviving: "unreaped-zombie",
      settleRegistration: "accepted",
    },
    owedTermination: true,
    answer: () =>
      Promise.resolve(readProcessLiveness(ROOT_PID, scriptedLiveness("Z+")) !== "running"),
  },
  {
    name: "a sleeping process is NOT terminated, which is what keeps the zombie reading honest",
    axes: {
      root: "alive",
      platformAnswer: "delivered",
      treeMode: "signal",
      surviving: "descendant",
      settleRegistration: "accepted",
    },
    owedTermination: false,
    answer: () =>
      Promise.resolve(readProcessLiveness(ROOT_PID, scriptedLiveness("S+")) !== "running"),
  },
  {
    // THE ONE CELL THAT NEEDS A REAL CHILD. The registrar throwing is a spawn
    // from `beforeAll`, and the caller never receives the handle — so the single
    // ask the recovery used to make was the only ask that would ever be made,
    // and a platform that refused it left a detached child running with nothing
    // anywhere that could name it again. Nothing scripted can stand in for that:
    // the defect is precisely that no object survives to be asked.
    name: "a refused registration over a refused kill asks again rather than abandoning the tree",
    axes: {
      root: "alive",
      platformAnswer: "refused-then-delivered",
      treeMode: PROCESS_TREE_TERMINATION_MODE,
      surviving: "descendant",
      settleRegistration: "refused",
    },
    owedTermination: true,
    answer: async () => {
      const refused = new RefusedRegistrationSpawn(1);
      expect(refused.attempt).toThrow();
      const abandonedPid = refused.abandonedPid;
      try {
        expect(
          abandonedPid,
          "the recovery asked nothing, so no pid was ever recorded",
        ).toBeGreaterThan(0);
        expect(
          refused.terminationRequests.length,
          "the recovery asked once over a refusal — the abandoned tree is never asked about again",
        ).toBeGreaterThan(1);
        await expectTerminatedWithin(abandonedPid, "the child a refused registration abandoned");
        return true;
      } finally {
        reap(abandonedPid);
      }
    },
  },
];

describe("the termination path, enumerated over every state it is asked in", () => {
  it.each(TERMINATION_MATRIX)(
    "$name",
    async (cell: TerminationCell) => {
      expect(
        await cell.answer(),
        `${cell.name} — root ${cell.axes.root}, platform ${cell.axes.platformAnswer}, ` +
          `${cell.axes.treeMode} mode, ${cell.axes.surviving} surviving, ` +
          `registration ${cell.axes.settleRegistration}`,
      ).toBe(cell.owedTermination);
    },
    // The scripted cells settle in microseconds; the spawning one takes the tier's.
    LIFETIME_TEST_TIMEOUT_MS,
  );

  it("covers every axis value at least once, so the table cannot go stale silently", () => {
    // The enumeration's own control. A cell added for a new finding with an axis
    // value nothing else carries is the case this catches; so is an axis value
    // whose only cell was deleted, which is how a matrix stops being one.
    const covered = (reader: (axes: TerminationAxes) => string): string[] =>
      [...new Set(TERMINATION_MATRIX.map((cell) => reader(cell.axes)))].sort();
    expect(covered((axes) => axes.root)).toStrictEqual([
      "alive",
      "exited-holding-stdio",
      "reaped-with-nothing-behind-it",
      "recycled",
    ]);
    expect(covered((axes) => axes.platformAnswer)).toStrictEqual([
      "delivered",
      "never-asked",
      "refused-then-delivered",
      "refused-throughout",
    ]);
    // Covered on either platform: every other cell names its mode, this one reads it.
    expect(covered((axes) => axes.treeMode)).toStrictEqual(["external", "signal"]);
    expect(covered((axes) => axes.surviving)).toStrictEqual([
      "descendant",
      "nothing",
      "unobservable",
      "unreaped-zombie",
    ]);
    expect(covered((axes) => axes.settleRegistration)).toStrictEqual(["accepted", "refused"]);
  });
});

// The `taskkill` arm's cells: every state a Windows tree kill can be asked in.
//
// Split from the signal arm's beside it because the two arms are two functions
// and neither can be executed on the platform the suite runs on — `arms.ts` says
// so in its own header, and the matrix's `treeMode` axis is that same split
// written as data. `termination-matrix-catalog.test-support.ts` composes both
// halves back into the one table the suite asserts over, so the enumeration is
// still one table and this is still one role.
//
// A CELL IS DATA AND ITS ANSWER IS THE REAL CODE. `answer` calls the shipped
// decision with the scripted collaborators from
// `termination-matrix-tools.test-support.ts`; where the verdict alone is
// satisfiable the wrong way, the cell also asserts the EVIDENCE — which pid was
// signalled and which was not — because a path that reports a tree gone because
// its root is gone answers `true` without ever naming a member.

import { expect } from "vitest";

import { terminateExternalTree } from "../../helpers/process-tree/arms.js";
import { type TerminationCell } from "./termination-matrix-axes.test-support.js";
import {
  CAPTURED_DESCENDANT,
  DESCENDANT_PID,
  EMPTY_TABLE,
  IMPOSTOR_CHILD_PID,
  reissuedDescendantTools,
  reissuedRootTools,
  ROOT_PID,
  ROOTLESS_TREE_TABLE,
  rootlessTreeTools,
  scriptedExternalTools,
  STALE_PARENT_ROW_PID,
  STALE_PARENT_ROW_TABLE,
} from "./termination-matrix-tools.test-support.js";

/** Every cell whose subject is `terminateExternalTree`. */
export const EXTERNAL_ARM_CELLS: readonly TerminationCell[] = [
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
            processTable: EMPTY_TABLE,
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
            processTable: ROOTLESS_TREE_TABLE,
            hasTerminated: () => false,
          }),
        ),
      ),
  },
  {
    name: "a rootless tree is addressed through its captured members, never reported gone with the root",
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
    // THE DEAD ROOT'S NUMBER STILL CARRIES ROWS, AND ONE OF THEM IS NOT OURS.
    // Windows keeps a process's recorded parent id after that parent exits, so a
    // long-lived child of whoever held `ROOT_PID` BEFORE this tree sits in the
    // table under the same row shape this tree's own descendant sits in. A kill
    // list built from that table hands `taskkill` a process this package never
    // started — the same false success as walking a reissued pid, arriving
    // through the door marked `gone`. Two claims: the stranger was not signalled,
    // and the member this tree captured was.
    name: "a stale parent row under a dead root pid is read, never signalled",
    axes: {
      root: "reaped-with-a-stale-parent-row",
      platformAnswer: "refused-then-delivered",
      treeMode: "external",
      surviving: "unverifiable-claimant",
      settleRegistration: "accepted",
    },
    // A REFUSAL rather than a success, and the reason is the same asymmetry: the
    // table is sound evidence that something claims the dead number and no
    // evidence at all that it is ours. Killing it risks an unrelated process and
    // ignoring it risks reporting a live tree as gone, so the verdict is withheld
    // and the caller's bounded retry ends in an honest `unterminable`.
    owedTermination: false,
    answer: () => {
      const tools = rootlessTreeTools(true, STALE_PARENT_ROW_TABLE);
      const terminated = terminateExternalTree(ROOT_PID, "SIGKILL", tools);
      expect(
        tools.killedFrom,
        "a process this tree never captured was signalled — the stale parent row is being used as a kill list",
      ).not.toContain(STALE_PARENT_ROW_PID);
      expect(
        tools.killedFrom,
        "the member captured while the root was still this tree's was never addressed",
      ).toContain(DESCENDANT_PID);
      return Promise.resolve(terminated);
    },
  },
  {
    // THE SECOND REISSUE. The captured member's OWN pid went back to the
    // operating system and came out as somebody else — so a capture carrying
    // only numbers would hand `taskkill` a stranger with the root's identity
    // check reporting nothing wrong, because the root is not what moved. The
    // stamp each member is captured with is what refuses it.
    name: "a captured member whose own pid was reissued is not signalled",
    axes: {
      root: "reaped-with-nothing-behind-it",
      platformAnswer: "never-asked",
      treeMode: "external",
      surviving: "nothing",
      settleRegistration: "accepted",
    },
    // The member is gone — that is what a reissued pid means — and nothing else
    // claims the dead root, so this is the honest success rather than a refusal.
    owedTermination: true,
    answer: () => {
      const tools = reissuedDescendantTools();
      const terminated = terminateExternalTree(ROOT_PID, "SIGKILL", tools);
      expect(
        tools.killedFrom,
        "the pid a captured member used to hold was signalled — the capture is being trusted without its stamp",
      ).toStrictEqual([]);
      return Promise.resolve(terminated);
    },
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
            processTable: EMPTY_TABLE,
            hasTerminated: () => true,
          }),
        ),
      ),
  },
  {
    // THE CASE A BLANKER RULE WOULD HAVE BROKEN, and the reason the rootless
    // arm's refusal is keyed on evidence rather than on an empty kill list. The
    // root pid names nothing, nothing was ever captured — `BoundedCleanup` is
    // handed a pid by Playwright and has no spawn moment to capture at — and the
    // host lists no row under that number. That last reading is the positive
    // evidence: Windows does not reparent, so a live descendant would still be
    // recording the dead root as its parent. Answering `false` here would report
    // every ordinary already-exited tree as unterminable.
    name: "a dead root pid nothing claims is a success even with nothing captured",
    axes: {
      root: "reaped-with-nothing-behind-it",
      platformAnswer: "never-asked",
      treeMode: "external",
      surviving: "nothing",
      settleRegistration: "accepted",
    },
    owedTermination: true,
    answer: () => {
      const tools = scriptedExternalTools({
        killTreeFrom: () => true,
        processTable: EMPTY_TABLE,
        hasTerminated: (processId: number) => processId === ROOT_PID,
        rootIdentity: "gone",
      });
      const terminated = terminateExternalTree(ROOT_PID, "SIGKILL", tools);
      expect(
        tools.killedFrom,
        "a pid was signalled although the root names nothing and nothing was captured — something was guessed at",
      ).toStrictEqual([]);
      return Promise.resolve(terminated);
    },
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
      const tools = reissuedRootTools([CAPTURED_DESCENDANT]);
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
      const tools = reissuedRootTools([CAPTURED_DESCENDANT], true);
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
];

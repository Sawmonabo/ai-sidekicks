// The `taskkill` arm's cells: every state a Windows tree kill can be asked in. The two arms cannot
// both run on the suite's platform (see `process-tree/platform-termination.ts`); the `treeMode`
// axis records that split. A cell's `answer` calls the shipped decision with the scripted tools
// from `termination-matrix-tools.test-support.ts`, and asserts the evidence (which pid was
// signaled) where the verdict alone could be satisfied the wrong way.

import { expect } from "vitest";

import { terminateExternalTree } from "./process-tree/platform-termination.js";
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
  UNREADABLE_TABLE,
} from "./termination-matrix-tools.test-support.js";

/** Every cell whose subject is `terminateExternalTree`. */
export const EXTERNAL_TERMINATION_CELLS: readonly TerminationCell[] = [
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
    // The verdict and the evidence: an arm that reports the tree gone because its root is gone
    // answers `true` without naming the descendant.
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
    // A dead root's number still carries rows: Windows keeps a recorded parent id after the
    // parent exits, so a long-lived child of the number's former holder looks like this tree's
    // descendant. A kill list built from the table would signal a process this package never
    // started. The stranger must not be signaled and the captured member must be.
    name: "a stale parent row under a dead root pid is read, never signaled",
    axes: {
      root: "reaped-with-a-stale-parent-row",
      platformAnswer: "refused-then-delivered",
      treeMode: "external",
      surviving: "unverifiable-claimant",
      settleRegistration: "accepted",
    },
    // A refusal: the table shows that something claims the dead number, not that it is ours.
    // Killing it risks an unrelated process and ignoring it risks calling a live tree gone, so
    // the verdict is withheld and the bounded retry ends in `unterminable`.
    owedTermination: false,
    answer: () => {
      const tools = rootlessTreeTools(true, STALE_PARENT_ROW_TABLE);
      const terminated = terminateExternalTree(ROOT_PID, "SIGKILL", tools);
      expect(
        tools.killedFrom,
        "a process this tree never captured was signaled — the stale parent row is being used as a kill list",
      ).not.toContain(STALE_PARENT_ROW_PID);
      expect(
        tools.killedFrom,
        "the member captured while the root was still this tree's was never addressed",
      ).toContain(DESCENDANT_PID);
      return Promise.resolve(terminated);
    },
  },
  {
    // The captured member's own pid was reissued to somebody else. Only the start stamp taken at
    // capture refuses it, since the root's identity check reports nothing wrong.
    name: "a captured member whose own pid was reissued is not signaled",
    axes: {
      root: "reaped-with-nothing-behind-it",
      platformAnswer: "never-asked",
      treeMode: "external",
      surviving: "nothing",
      settleRegistration: "accepted",
    },
    // The member is gone (that is what a reissued pid means) and nothing claims the dead root:
    // an honest success.
    owedTermination: true,
    answer: () => {
      const tools = reissuedDescendantTools();
      const terminated = terminateExternalTree(ROOT_PID, "SIGKILL", tools);
      expect(
        tools.killedFrom,
        "the pid a captured member used to hold was signaled — the capture is being trusted without its stamp",
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
    // Refusal is keyed on evidence, not on an empty kill list. The root names nothing, nothing
    // was captured (`BoundedCleanup` is handed a pid with no spawn moment), and the host lists no
    // row under that number; Windows does not reparent, so a live descendant would still record
    // the dead root as its parent. Answering `false` would call every already-exited tree
    // unterminable.
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
        "a pid was signaled although the root names nothing and nothing was captured — something was guessed at",
      ).toStrictEqual([]);
      return Promise.resolve(terminated);
    },
  },
  {
    // The foil for the cell above: same dead root and absent capture, but the listing failed
    // (would not start, spent its bound, or exited non-zero), so an empty result is no evidence.
    // Read as an empty table it would answer `true` with a live browser under it;
    // `process-tree/readers.ts` returns a sentinel for an unreadable host so the verdict fails
    // closed and the caller's bounded retry ends in `unterminable`.
    name: "an unreadable process listing is a refusal, not a dead root with nothing behind it",
    axes: {
      root: "exited-holding-stdio",
      platformAnswer: "never-asked",
      treeMode: "external",
      surviving: "unobservable",
      settleRegistration: "accepted",
    },
    owedTermination: false,
    answer: () => {
      const tools = scriptedExternalTools({
        killTreeFrom: () => true,
        processTable: UNREADABLE_TABLE,
        // The root is gone and every other reading is clean, which is what made a false success
        // reachable.
        hasTerminated: (processId: number) => processId === ROOT_PID,
        rootIdentity: "gone",
      });
      const terminated = terminateExternalTree(ROOT_PID, "SIGKILL", tools);
      expect(
        tools.killedFrom,
        "a pid was signaled although this host named none — an unreadable listing is being read as a table",
      ).toStrictEqual([]);
      return Promise.resolve(terminated);
    },
  },
  {
    // The root exited, was reaped, and its number now belongs to an unrelated process (the
    // launcher shim exits under a live browser). `taskkill /pid <number> /t` would walk the
    // stranger's tree and exit zero. Nothing reachable through the reissued number may be
    // signaled, and the member captured while the pid was still this tree's must be.
    name: "a reissued root pid is signaled by nothing, and the tree it no longer names is not reported killed",
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
        "the reissued root pid was signaled — an unrelated process was terminated by this cleanup",
      ).not.toContain(ROOT_PID);
      expect(
        tools.killedFrom,
        "the parent table was walked from a reissued pid — the stranger's own child was signaled",
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
    // The foil for the cell above: everything this tree held has terminated, so there is nothing
    // to kill or report. Answering `false` for every reissued pid would hold teardown open on
    // every Windows run whose shim was reaped early.
    owedTermination: true,
    answer: () => {
      const tools = reissuedRootTools([CAPTURED_DESCENDANT], true);
      const terminated = terminateExternalTree(ROOT_PID, "SIGKILL", tools);
      expect(
        tools.killedFrom,
        "something was signaled over a tree already gone — the reissued pid is being asked about rather than read",
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
    // With nothing captured there is no member to address or read, and reporting the tree gone
    // would be the same false success as walking the stranger. The caller's bounded retry and its
    // `unterminable` are what is owed.
    owedTermination: false,
    answer: () => {
      const tools = reissuedRootTools([]);
      const terminated = terminateExternalTree(ROOT_PID, "SIGKILL", tools);
      expect(
        tools.killedFrom,
        "a pid was signaled although this tree is unobservable — something was guessed at",
      ).toStrictEqual([]);
      return Promise.resolve(terminated);
    },
  },
];

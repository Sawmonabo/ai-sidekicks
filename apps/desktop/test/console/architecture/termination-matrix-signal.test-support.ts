// Every cell the `taskkill` arm does not own.
//
// Three subjects rather than one, and they sit together because none of them is
// large enough to be its own file and all of them are what is left once the
// external arm's cells are lifted out: the POSIX group signal, the liveness
// reading both arms compose their verdict from, and the single cell that needs a
// REAL child. That last one names no arm — it reads
// `PROCESS_TREE_TERMINATION_MODE` and takes whichever this runner has — so it
// belongs with neither arm's scripted cells and does not earn a file of its own.
//
// `termination-matrix-catalog.test-support.ts` composes these back onto the
// external arm's, so the enumeration the suite asserts over is still one table.

import { expect } from "vitest";

import { terminateSignalledTree } from "../../helpers/process-tree/arms.js";
import { PROCESS_TREE_TERMINATION_MODE } from "../../helpers/process-tree/dispatch.js";
import { readProcessLiveness } from "../../helpers/process-tree/liveness.js";
import { RefusedRegistrationSpawn } from "./electron-child-lifetime.test-support.js";
import { expectTerminatedWithin, reap } from "./electron-child-liveness.test-support.js";
import { type TerminationCell } from "./termination-matrix-axes.test-support.js";
import {
  ROOT_PID,
  scriptedLiveness,
  undeliverableSignalTools,
} from "./termination-matrix-tools.test-support.js";

/** The group-signal cells, the liveness readings, and the one real child. */
export const SIGNALLED_AND_OBSERVED_CELLS: readonly TerminationCell[] = [
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

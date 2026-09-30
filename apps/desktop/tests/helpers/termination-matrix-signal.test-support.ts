// The termination cells the `taskkill` arm does not own: the POSIX group signal, the liveness
// reading both arms use, and the one cell that needs a real child (it reads
// `PROCESS_TREE_TERMINATION_MODE`, so it belongs to neither arm).
// `termination-matrix-catalog.test-support.ts` composes these with the external arm's cells.

import { expect } from "vitest";

import { terminateSignaledTree } from "./process-tree/platform-termination.js";
import { PROCESS_TREE_TERMINATION_MODE } from "./process-tree/termination.js";
import { readProcessLiveness } from "./process-tree/liveness.js";
import { RefusedRegistrationSpawn } from "./electron-child-lifetime.test-support.js";
import { expectTerminatedWithin, reap } from "./electron-child-liveness.test-support.js";
import { type TerminationCell } from "./termination-matrix-axes.test-support.js";
import {
  ROOT_PID,
  scriptedLiveness,
  undeliverableSignalTools,
} from "./termination-matrix-tools.test-support.js";

/** The group-signal cells, the liveness readings, and the one real child. */
export const SIGNALED_AND_OBSERVED_CELLS: readonly TerminationCell[] = [
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
    // The reading must be the group's, not the root's: the root is reaped, so a root-only probe
    // reports it gone while the descendant it left is still in the group.
    answer: () =>
      Promise.resolve(
        terminateSignaledTree(
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
        terminateSignaledTree(
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
    // The one cell that needs a real child. When the registrar throws (a spawn from `beforeAll`)
    // the caller never gets the handle, so the recovery's single ask was the only one ever made,
    // and a refusal left a detached child running with nothing that could name it. No scripted
    // object survives to be asked.
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

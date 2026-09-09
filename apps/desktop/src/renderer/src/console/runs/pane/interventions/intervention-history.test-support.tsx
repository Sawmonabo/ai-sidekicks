// The records the history's suites drive, and the mount they drive them through.
//
// Hoisted on the second reader rather than copied: `InterventionHistory.copy.test.tsx`
// presses the path controls a restored rollback offers, and `InterventionHistory.test.tsx`
// asserts what that same record discloses. One builder, so a change to the settled
// rollback's wire shape is one edit here and never two that drift apart.

import { render } from "@testing-library/react";

import type { ConsoleBridge } from "../../../bridge/index.js";
import { createFixture } from "../../../bridge/fixture/call-plane/bridge.test-support.js";
import { InterventionHistory } from "./InterventionHistory.js";
import type { RunControlRecord } from "../controls/run-control-surface.js";
import { RUN_ID } from "../runs-pane.test-support.js";

/** The intervention every settlement these builders make is recorded under. */
export const INTERVENTION_ID = "d5f2c3e4-6071-4182-ac93-1e4f50617283";

/** The history for one run, over the real fixture bridge or a case's own. */
export function renderHistory(
  records: readonly RunControlRecord[],
  bridge: ConsoleBridge = createFixture().bridge,
): HTMLElement {
  const { container } = render(
    // A real fixture bridge rather than a stub: the list holds the path action a
    // settled rollback's enumerations offer, and a hand-built object would let a
    // change to that seam's shape pass here and fail in the window.
    <InterventionHistory records={records} runId={RUN_ID} bridge={bridge} />,
  );
  return container;
}

/** The path the single-record restore cases open and copy. */
export const RESTORED_PATH = "/Users/dev/code/one/.env.local";

/**
 * A settled rollback that restored files, with both enumerations non-empty.
 *
 * The overwritten path is a parameter because the keying cases need two records whose
 * enumerations are distinguishable — a control is found by its accessible name, and
 * two rows offering the same path would leave the case unable to say which row it
 * pressed.
 */
export function restoredRollbackRecord(
  recordId: string,
  overwrittenPath: string = RESTORED_PATH,
): RunControlRecord {
  return {
    recordId,
    runId: RUN_ID,
    control: "rollback",
    outcome: {
      kind: "settled",
      control: "rollback",
      response: {
        interventionId: INTERVENTION_ID as never,
        interventionType: "rollback",
        state: "applied",
        runVersion: 14,
        result: {
          disposition: "files-restored",
          overwrittenIgnoredPaths: [overwrittenPath],
          divergentGitlinks: ["/Users/dev/code/one/vendor/sdk"],
        },
      },
    },
  };
}

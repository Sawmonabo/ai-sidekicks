// The window dims the rows whose own stamp carries the superseded mark, and no other. A mark lost
// between the stamp and the row draws rewound turns as current, and nothing throws.

import { describe, expect, it } from "vitest";

import { EVENT_ID_STEM } from "#fixtures/scenarios/transcript-states.js";
import type { ProjectedSessionEvent } from "#renderer/store/session/entities/vocabulary.js";
import { transcriptFixtureStampAt } from "../logs.test-support.js";
import { deriveTranscriptWindow } from "./transcript-window.js";

const SESSION_ID = "019b793b-7b60-75e5-8510-ada11a5a44a5";
const RUN_ID = "019b793b-7b60-740e-8110-d1a4c1150111";

/** One event of the run at `sequence`, stamped where the daemon placed it. */
function runEvent(
  sequence: number,
  kind: string,
  runStamp: NonNullable<ProjectedSessionEvent["runStamp"]>,
  payload: Readonly<Record<string, unknown>> = {},
): ProjectedSessionEvent {
  return {
    id: `${EVENT_ID_STEM}${String(sequence).padStart(4, "0")}`,
    sessionId: SESSION_ID,
    sequence,
    cursor: `cursor-at-${String(sequence)}`,
    kind,
    occurredAt: transcriptFixtureStampAt(sequence),
    payload: { sessionId: SESSION_ID, runId: RUN_ID, ...payload },
    runStamp,
  };
}

describe("the superseded treatment", () => {
  it("dims exactly the rows whose stamp carries the mark", () => {
    const transcriptWindow = deriveTranscriptWindow([
      runEvent(1, "run.running", { position: 1, epoch: 0 }),
      runEvent(2, "run.running", { position: 3, epoch: 0, superseded: { targetPosition: 2 } }),
      runEvent(
        3,
        "run.rolled_back",
        { position: 2, epoch: 0 },
        { runVersion: 3, targetPosition: 2 },
      ),
      // The re-executed turn reuses position 3 in the next epoch and stays current.
      runEvent(4, "run.running", { position: 3, epoch: 1 }),
    ]);

    expect(transcriptWindow.rows).toHaveLength(4);
    expect([...transcriptWindow.supersededRowIds]).toStrictEqual([`${EVENT_ID_STEM}0002`]);
  });
});

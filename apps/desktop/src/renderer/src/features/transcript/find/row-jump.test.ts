// Finding a row by id, and naming the narrowing that keeps it out of view.

import type { TimelineRow } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import { generalRow, rollbackBoundaryRow, runRow } from "../timeline-rows.test-support.js";
import { jumpToEventId, type RowJumpStages } from "./row-jump.js";

/** Two runs by two agents, one session row, and a boundary in each run. */
function twoRunWindow(): readonly TimelineRow[] {
  return [
    runRow({
      id: "a1",
      sequence: 1,
      type: "run.running",
      runId: "run-a",
      position: 1,
      actor: "agent-one",
    }),
    runRow({
      id: "b1",
      sequence: 2,
      type: "run.running",
      runId: "run-b",
      position: 1,
      actor: "agent-two",
    }),
    generalRow({
      id: "s1",
      sequence: 3,
      type: "session.renamed",
      category: "session_lifecycle",
      actor: "person-one",
    }),
    rollbackBoundaryRow({
      id: "rb-a",
      sequence: 4,
      runId: "run-a",
      position: 2,
      targetPosition: 1,
      actor: "person-one",
    }),
    rollbackBoundaryRow({
      id: "rb-b",
      sequence: 5,
      runId: "run-b",
      position: 2,
      targetPosition: 1,
      actor: "person-one",
    }),
    runRow({
      id: "a2",
      sequence: 6,
      type: "run.completed",
      runId: "run-a",
      position: 3,
      actor: "agent-one",
    }),
  ];
}

describe("a jump by id names which narrowing is hiding the row", () => {
  const rows = twoRunWindow();

  /**
   * The stages, each admitting whatever it is handed.
   *
   * Built from row lists rather than from a window model, because the classifier's
   * whole claim is that it answers from the STAGES and not from either end of
   * them — a case that had to build a feed to exercise one arm would be testing
   * the feed.
   */
  function stagesOver(admissions: {
    fold?: readonly TimelineRow[];
    viewport?: readonly TimelineRow[];
  }): RowJumpStages {
    const idsOf = (admitted: readonly TimelineRow[] | undefined): ReadonlySet<string> =>
      new Set((admitted ?? rows).map((row) => row.id));
    return {
      "folded-into-chapter": idsOf(admissions.fold),
      "outside-window": idsOf(admissions.viewport),
    };
  }

  it("finds a row every stage admitted", () => {
    expect(jumpToEventId(rows, stagesOver({}), "a1").status).toBe("found");
  });

  it("names the chapter fold and the cap, each for its own stage", () => {
    // Each stage is the only one narrowed in its case, so the answer can come from
    // nowhere else.
    const foldedAway = rows.filter((row) => row.id !== "b1");
    expect(jumpToEventId(rows, stagesOver({ fold: foldedAway }), "b1").status).toBe(
      "folded-into-chapter",
    );
    expect(jumpToEventId(rows, stagesOver({ viewport: foldedAway }), "b1").status).toBe(
      "outside-window",
    );
  });

  it("names the earliest stage that dropped the row, not the last", () => {
    // The stages nest, so a row the fold took is absent from every stage after it.
    // Reading the last would report the cap for a row whose run group is folded, and
    // offer no act where opening the group reaches it.
    const withoutB1 = rows.filter((row) => row.id !== "b1");
    const outcome = jumpToEventId(rows, stagesOver({ fold: withoutB1, viewport: withoutB1 }), "b1");
    expect(outcome.status).toBe("folded-into-chapter");
  });

  it("separates an id this window never held from every narrowing", () => {
    expect(jumpToEventId(rows, stagesOver({}), "an-id-from-earlier-in-the-session").status).toBe(
      "not-in-loaded-log",
    );
  });

  it("negative control: with every stage admitting everything nothing is ever absent", () => {
    // Without this the cases above would pass over a classifier that reported an
    // absence for every id, which would put a permanent notice on a whole transcript.
    for (const row of rows) {
      expect(jumpToEventId(rows, stagesOver({}), row.id).status).toBe("found");
    }
  });
});

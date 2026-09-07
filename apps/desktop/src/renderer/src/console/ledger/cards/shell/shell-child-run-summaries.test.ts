import { describe, expect, it } from "vitest";

import { EVENT_ID_STEM } from "../../../bridge/scenarios/ledger/ledger-cast.js";
import { type ConsoleSessionEvent } from "../../../store/index.js";
import { projectFixtureShellRows } from "./fixture-shell-projection.js";
import { deriveShellChildRunSummaries } from "./shell-child-run-summaries.js";

const SESSION_ID = "019b793b-7b60-75e5-8510-ada11a5a44a5";
const PARENT_RUN = "019b793b-7b60-740e-8110-d1a4c1150111";
const CHILD_RUN = "019b793b-7b60-740e-8140-d1a4c1150114";
const OTHER_RUN = "019b793b-7b60-740e-8120-d1a4c1150112";
const RUNTIME_NODE = "019b793b-7b60-7d0c-8110-c0de11a0d0e1";

function event(
  sequence: number,
  kind: string,
  payload: Readonly<Record<string, unknown>>,
): ConsoleSessionEvent {
  return {
    id: `${EVENT_ID_STEM}${String(sequence).padStart(4, "0")}`,
    sessionId: SESSION_ID,
    sequence,
    kind,
    occurredAt: `2026-01-01T11:0${String(sequence % 10)}:00.000Z`,
    payload,
  };
}

/** The child's birth beat, carrying whichever linkage members the case is about. */
function childBirth(
  sequence: number,
  linkage: Readonly<Record<string, unknown>>,
): ConsoleSessionEvent {
  return event(sequence, "run.queued", {
    sessionId: SESSION_ID,
    runId: CHILD_RUN,
    runVersion: 1,
    newState: "queued",
    ...linkage,
  });
}

function childTransition(sequence: number, newState: string): ConsoleSessionEvent {
  return event(sequence, `run.${newState}`, {
    sessionId: SESSION_ID,
    runId: CHILD_RUN,
    runVersion: sequence,
    newState,
  });
}

describe("the shell's child-run summaries", () => {
  it("summarizes a child run onto the one row that names it and its parent", () => {
    const birth = childBirth(1, { parentRunId: PARENT_RUN, producingNodeId: RUNTIME_NODE });
    const summaries = deriveShellChildRunSummaries([
      birth,
      childTransition(2, "starting"),
      childTransition(3, "running"),
    ]);

    expect([...summaries.keys()]).toStrictEqual([birth.id]);
    expect(summaries.get(birth.id)).toStrictEqual({
      runId: CHILD_RUN,
      parentRunId: PARENT_RUN,
      producingNodeId: RUNTIME_NODE,
      // The newest state the log announced, not the one the creation row carried.
      state: "running",
      // The birth beat and the two transitions after it.
      eventCount: 3,
      completeness: { state: "complete" },
    });
  });

  it("summarizes no run whose creation row names no parent", () => {
    // THE NEGATIVE CONTROL for the whole treatment. A run is a child because the
    // daemon said so on its birth beat; without that member there is a run and no
    // parent, and the ledger already draws one of those.
    const summaries = deriveShellChildRunSummaries([
      childBirth(1, {}),
      childTransition(2, "running"),
    ]);

    expect([...summaries.keys()]).toStrictEqual([]);
  });

  it("omits a producing node the creation row did not name", () => {
    const birth = childBirth(1, { parentRunId: PARENT_RUN });
    const summary = deriveShellChildRunSummaries([birth]).get(birth.id);

    // Absent rather than present-and-undefined: a fabricated provenance is worse
    // than the named absence the row renders in its place.
    expect(summary).not.toHaveProperty("producingNodeId");
  });

  it("counts only the rows attributed to the child, and not its parent's", () => {
    const birth = childBirth(1, { parentRunId: PARENT_RUN });
    const summaries = deriveShellChildRunSummaries([
      birth,
      childTransition(2, "running"),
      event(3, "run.running", { sessionId: SESSION_ID, runId: PARENT_RUN }),
      event(4, "run.running", { sessionId: SESSION_ID, runId: OTHER_RUN }),
    ]);

    expect(summaries.get(birth.id)?.eventCount).toBe(2);
  });

  it("marks the summary incomplete at the child's first compaction", () => {
    const birth = childBirth(1, { parentRunId: PARENT_RUN });
    const firstCompaction = event(2, "usage.context_compacted", {
      sessionId: SESSION_ID,
      runId: CHILD_RUN,
    });
    const summaries = deriveShellChildRunSummaries([
      birth,
      firstCompaction,
      event(3, "usage.context_compacted", { sessionId: SESSION_ID, runId: CHILD_RUN }),
    ]);

    // The FIRST one, because that is when the transcript stopped being whole; a
    // later compaction changes nothing about the claim.
    expect(summaries.get(birth.id)?.completeness).toStrictEqual({
      state: "incomplete",
      cause: "compacted",
      observedAt: firstCompaction.occurredAt,
    });
  });

  it("reports a parent's compaction as nothing at all about the child", () => {
    const birth = childBirth(1, { parentRunId: PARENT_RUN });
    const summaries = deriveShellChildRunSummaries([
      birth,
      event(2, "usage.context_compacted", { sessionId: SESSION_ID, runId: PARENT_RUN }),
    ]);

    expect(summaries.get(birth.id)?.completeness).toStrictEqual({ state: "complete" });
  });

  it("summarizes no run that named itself as its own parent", () => {
    // A self-parenting summary makes the lineage graph cyclic and every walk of it
    // non-terminating, so a malformed creation row produces no summary at all rather
    // than one whose first walk does not return.
    const birth = childBirth(1, { parentRunId: CHILD_RUN });

    expect([...deriveShellChildRunSummaries([birth]).keys()]).toStrictEqual([]);
  });

  it("keeps the first creation row when a child's birth is delivered twice", () => {
    const birth = childBirth(1, { parentRunId: PARENT_RUN });
    const redelivered = childBirth(2, { parentRunId: OTHER_RUN });
    const summaries = deriveShellChildRunSummaries([birth, redelivered]);

    // First-wins, the rule the anchor index is written under: a redelivered birth
    // would otherwise walk the card down the log and re-parent the child with it.
    expect([...summaries.keys()]).toStrictEqual([birth.id]);
    expect(summaries.get(birth.id)?.parentRunId).toBe(PARENT_RUN);
  });
});

describe("the shell projection carrying a child-run summary", () => {
  it("stamps the member on the creation row and on no other row", () => {
    const birth = childBirth(2, { parentRunId: PARENT_RUN });
    const { rows } = projectFixtureShellRows([
      event(1, "run.running", { sessionId: SESSION_ID, runId: PARENT_RUN }),
      birth,
      childTransition(3, "running"),
    ]);

    const carrying = rows.filter((row) => row.childRunSummary !== undefined);
    expect(carrying).toHaveLength(1);
    expect(carrying[0]?.id).toBe(birth.id);
    expect(carrying[0]?.childRunSummary?.parentRunId).toBe(PARENT_RUN);
  });

  it("leaves the member absent rather than present-and-undefined elsewhere", () => {
    // The retention table compares own keys with `Object.is`, so a row carrying
    // `childRunSummary: undefined` is a different row from one carrying no key at
    // all — and every such row would lose its place on every projection pass.
    const { rows } = projectFixtureShellRows([
      event(1, "run.running", { sessionId: SESSION_ID, runId: PARENT_RUN }),
      childBirth(2, { parentRunId: PARENT_RUN }),
    ]);

    expect(rows[0]).not.toHaveProperty("childRunSummary");
  });
});

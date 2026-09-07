// Which runs the page asks about, and which questions it therefore does not put.
//
// The distinction under test is the one the whole page is built on: a subject that
// does not exist produces NO question, and a question nobody put is not an answer
// saying nothing is wrong.

import { describe, expect, it } from "vitest";

import { runEntity } from "../../../settings-page-mount.test-support.js";
import { NO_DIAGNOSTICS_RUN_SUBJECTS, resolveDiagnosticsRunSubjects } from "./run-subjects.js";
import type { ConsoleEntity } from "../../../../store/index.js";

function partitionOf(runs: readonly ConsoleEntity[]): Record<string, ConsoleEntity> {
  return Object.fromEntries(runs.map((run) => [run.id, run]));
}

describe("resolveDiagnosticsRunSubjects", () => {
  it("addresses the stall question to a run that is still moving", () => {
    const subjects = resolveDiagnosticsRunSubjects(
      partitionOf([runEntity("run-live", "running"), runEntity("run-done", "completed")]),
    );

    expect(subjects.stalledCandidateRunId).toBe("run-live");
  });

  it("addresses the failure question to a run that failed, never to the live one", () => {
    const subjects = resolveDiagnosticsRunSubjects(
      partitionOf([runEntity("run-live", "running"), runEntity("run-bad", "failed")]),
    );

    expect(subjects).toEqual({
      stalledCandidateRunId: "run-live",
      failedCandidateRunId: "run-bad",
    });
  });

  it("puts neither question where the session holds no run of either kind", () => {
    const subjects = resolveDiagnosticsRunSubjects(
      partitionOf([runEntity("run-done", "completed"), runEntity("run-gone", "interrupted")]),
    );

    expect(subjects).toEqual(NO_DIAGNOSTICS_RUN_SUBJECTS);
  });

  it("takes the newest-touched of several moving runs", () => {
    const subjects = resolveDiagnosticsRunSubjects(
      partitionOf([
        runEntity("run-older", "running", "2026-01-01T08:00:00.000Z"),
        runEntity("run-newer", "running", "2026-01-01T08:05:00.000Z"),
      ]),
    );

    expect(subjects.stalledCandidateRunId).toBe("run-newer");
  });

  it("treats a state this build has never heard of as neither moving nor failed", () => {
    // The fail-closed direction: an unknown word produces no question rather than a
    // question about a run whose state nothing here can read.
    const subjects = resolveDiagnosticsRunSubjects(
      partitionOf([runEntity("run-strange", "hibernating")]),
    );

    expect(subjects).toEqual(NO_DIAGNOSTICS_RUN_SUBJECTS);
  });

  it("negative control: the same run in a state this build does read is a subject", () => {
    const subjects = resolveDiagnosticsRunSubjects(
      partitionOf([runEntity("run-strange", "waiting_for_input")]),
    );

    expect(subjects.stalledCandidateRunId).toBe("run-strange");
  });

  it("puts neither question for a session holding nothing at all", () => {
    expect(resolveDiagnosticsRunSubjects({})).toEqual(NO_DIAGNOSTICS_RUN_SUBJECTS);
  });
});

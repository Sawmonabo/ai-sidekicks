// The mixed window both run group suites fold.
//
// Two files fold the same rows — one about how the fold partitions them, one about
// which of the resulting run groups is open — and both need the same window and the
// same way of naming one run group out of it. Written twice they would drift, and the
// collapse suite's claims would quietly stop being about the same run groups the fold
// suite pinned.

import type { TimelineRow } from "@ai-sidekicks/contracts";

import { type RunGroup } from "./run-groups.js";
import { generalRow, runRow } from "../timeline-rows.test-support.js";

export function mixedWindow(): readonly TimelineRow[] {
  return [
    runRow({
      id: "a1",
      sequence: 1,
      type: "run.queued",
      runId: "run-a",
      position: 1,
      actor: "agent-one",
    }),
    generalRow({ id: "s1", sequence: 2, type: "session.renamed", category: "session_lifecycle" }),
    runRow({
      id: "b1",
      sequence: 3,
      type: "run.queued",
      runId: "run-b",
      position: 1,
      actor: "agent-two",
    }),
    runRow({ id: "a2", sequence: 4, type: "run.running", runId: "run-a", position: 2 }),
    runRow({ id: "b2", sequence: 5, type: "run.completed", runId: "run-b", position: 2 }),
  ];
}

export function findRunGroup(runGroups: readonly RunGroup[], runId: string): RunGroup {
  const runGroup = runGroups.find((candidate) => candidate.runId === runId);
  if (runGroup === undefined) {
    throw new Error(`no run group for ${runId}`);
  }
  return runGroup;
}

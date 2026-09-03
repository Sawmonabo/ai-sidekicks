// The outputs a finished phase left behind.
//
// One of the workflow fixture's four data modules; `workflow-fixture-ids.ts` carries
// the framing all four share and the phase id this table's read is addressed by.

import type { WorkflowPhaseOutput } from "../workflow-projection.js";

import { PHASE_DRAFT } from "./workflow-fixture-ids.js";

/**
 * The phase whose outputs the phase-output read answers for.
 *
 * Named here rather than beside the phase ids because the role is this module's: the
 * runs table sequences all five phases and none of them is privileged there, while
 * `workflow.phaseOutputRead` addresses exactly this one.
 */
export const WORKFLOWS_COMPLETED_PHASE_ID: string = PHASE_DRAFT;

/**
 * The outputs `workflow.phaseOutputRead` answers for the parked run's finished phase.
 *
 * Both value kinds, because they render differently and a fixture carrying one would
 * leave the other undrawn: an inline summary a surface shows verbatim, and an artifact
 * reference a surface links rather than renders. `valueKind` is stated on both rather
 * than left to the presence of `artifactId`, which is the older daemon's fallback
 * reading and not the shape this fixture models.
 */
export const WORKFLOWS_SCENARIO_PHASE_OUTPUTS: readonly WorkflowPhaseOutput[] = [
  {
    valueKind: "inline",
    summary: "Release notes drafted for 14 merged pull requests across 3 packages.",
    producedAt: "2026-01-01T09:38:00.000Z",
  },
  {
    valueKind: "artifact_ref",
    artifactId: "019b7a10-0280-7ab2-8100-a2711fac0001",
    summary: "changelog.md",
    producedAt: "2026-01-01T09:38:00.000Z",
  },
];

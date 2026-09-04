// The three workflow reads the scenario answers by COMPUTING rather than by tabling.
//
// The sibling `workflow-fixture-*.ts` modules hold the session's records; this one
// holds the reading of them, which is a different job and moves for different reasons.
// A change to what a read answers lands here and leaves the scenario declaration — the
// beats, the roster, the reply script — untouched.
//
// HOW THE WORKFLOW STATE REACHES A SURFACE
//
// Every read is a scripted reply. A served growth operation answers through
// `answerFromScriptedReply(engine, "<call>", …)`, which is the one seam
// `bridge/scripted-reply.ts` owns, so a workflow read gets the script, the frozen
// clock's loading window, and the two non-arrival refusals a real read has. The
// engine matches a reply on the call name alone, so there is one reply per call and a
// second for the same call is a wire-truth defect precisely because it could never be
// served.
//
// THE TWO SNAPSHOT READS ARE ANSWERED PER REQUEST, and that is what makes the four
// runs openable. One reply per call and a FIXED value in it meant `workflow.runRead`
// answered with the parked run whatever it was asked — held to that run by the port's
// own scope check, so the destination listed four runs as openable and three of them
// refused `workflow.not_found` against a list this same fixture had just served. The
// reply is a `resultFor` instead, which is the seam's own request-keyed shape: it
// picks the snapshot out of the very table the enumeration is built from, so a listed
// run and a read run are one object and cannot come apart. A run this fixture holds no
// snapshot for still refuses, through the one constructor the scope module owns.
//
// The two differ in what the corpus registers, and that difference is on the slate
// rather than in this file: the run READ is one of the thirteen registered workflow
// methods and rides `workflow-run-control`, while the run ENUMERATION is registered
// nowhere — every registered run operation addresses one run by an id the caller must
// already hold — and rides `workflow-run-enumeration`. Both are fixture-only, and the
// port refuses both under a live bridge.

import { WORKFLOWS_SCENARIO_DEFINITIONS } from "./workflow-fixture-definitions.js";
import {
  WORKFLOWS_COMPLETED_PHASE_ID,
  WORKFLOWS_SCENARIO_PHASE_OUTPUTS,
} from "./workflow-fixture-phase-outputs.js";
import { WORKFLOWS_PARKED_RUN, WORKFLOWS_SCENARIO_RUNS } from "./workflow-fixture-runs.js";
import { workflowSubjectNotFound } from "../fixture-workflow-scope.js";
import { readUnknownStringMember } from "../unknown-member.js";
import type {
  WorkflowDefinitionSummary,
  WorkflowRunListEntry,
  WorkflowRunSnapshot,
} from "../workflow-projection.js";

/**
 * Which definition each scripted run was started from, by the version it is pinned to.
 *
 * The pairing lives HERE, on the reply, rather than on the run rows next door,
 * because it is a fact about what the ENUMERATION answers with: `workflow.runRead`
 * carries a run's pinned version and nothing about its definition, and no registered
 * read maps a version id back to a definition — so a daemon serving a run list joins
 * the two rows and a fixture has to do the same work.
 *
 * Keyed by version id rather than by run id or by position: three of the four runs
 * are pinned to their definition's own latest, so their key is the value the
 * definition table already publishes, and the fourth is the deliberately frozen pin —
 * version 1 of `Ship pipeline` — which is exactly the case no derivation can recover.
 * `runListEntries` refuses a run this table does not name, so a version id edited in
 * the data file next door fails the scenario's own test loudly instead of quietly
 * dropping a run's definition.
 */
const DEFINITION_NAME_BY_RUN_VERSION: Readonly<Record<string, string>> = {
  // `Release checks`, at its own latest — the working run.
  "019b7a10-0280-7d22-8100-be5100150004": "Release checks",
  // `Ship pipeline`, at its own latest — the parked run.
  "019b7a10-0280-7d22-8100-be5100150003": "Ship pipeline",
  // `Incident triage`, at its own latest — the cancelled run.
  "019b7a10-0280-7d22-8100-be5100150002": "Incident triage",
  // `Ship pipeline` version 1, whose definition has since moved to version 3 — the
  // frozen pin, and the only run whose definition no match against the definition
  // table's latest ids could find.
  "019b7a10-0280-7d22-8100-be5100150001": "Ship pipeline",
};

/**
 * The definition a run's name resolves to, most-specific-first as the daemon would.
 *
 * Two definitions share each of two names in this fixture, which is what makes the
 * browser's resolution mark say anything — so a name alone does not identify a row,
 * and the entry takes the one the enumeration marked as resolving here. That is the
 * definition a run started from this context would have been pinned to.
 */
function resolvedDefinitionNamed(name: string): WorkflowDefinitionSummary {
  const resolved = WORKFLOWS_SCENARIO_DEFINITIONS.find(
    (definition) => definition.name === name && definition.resolvesAtThisContext,
  );
  if (resolved === undefined) {
    throw new Error(`the workflows fixture names no resolving definition called ${name}`);
  }
  return resolved;
}

/**
 * The four runs as the ENUMERATION answers with them: each run's own row plus the
 * definition facts a list needs and a single-run read never carries.
 */
export function runListEntries(): readonly WorkflowRunListEntry[] {
  return WORKFLOWS_SCENARIO_RUNS.map((run) => {
    const definitionName = DEFINITION_NAME_BY_RUN_VERSION[run.workflowVersionId];
    if (definitionName === undefined) {
      throw new Error(`the workflows fixture pairs no definition with run ${run.workflowRunId}`);
    }
    const definition = resolvedDefinitionNamed(definitionName);
    return {
      ...run,
      definitionName: definition.name,
      definitionLatestWorkflowVersionId: definition.latestWorkflowVersionId,
    };
  });
}

/**
 * The snapshot this scenario answers `workflow.runRead` with, for the run asked about.
 *
 * Read out of `WORKFLOWS_SCENARIO_RUNS`, which is the same table `runListEntries`
 * widens into the enumeration — so every run the destination lists is a run the pane
 * can open, and the snapshot it opens on IS the row that was listed rather than a
 * second copy that agrees today.
 *
 * The two absences are two facts. A call carrying no run at all is the growth port's
 * request-less probe, and `undefined` settles it exactly as an unscripted call settles
 * — the seam's own rule for a computed reply asked about nothing. A call naming a run
 * this fixture holds no snapshot for is a read the daemon would refuse, so it refuses,
 * with the code and sentence `fixture-workflow-scope.ts` owns for every workflow
 * subject a scenario cannot answer for.
 */
export function runSnapshotFor(request: unknown): WorkflowRunSnapshot | undefined {
  const requestedRunId = readUnknownStringMember(request, "workflowRunId");
  if (requestedRunId === undefined) {
    return undefined;
  }
  const run = WORKFLOWS_SCENARIO_RUNS.find(
    (candidate) => candidate.workflowRunId === requestedRunId,
  );
  if (run === undefined) {
    throw workflowSubjectNotFound("run", requestedRunId);
  }
  return run;
}

/**
 * The outputs this scenario answers `workflow.phaseOutputRead` with, for both of the
 * identifiers that read is addressed by.
 *
 * Computed for the run read's reason and pinned rather than tabled: these outputs
 * belong to ONE finished phase of ONE run, so a read naming another run would report
 * that run as having produced them. It was the run read's fixed value that used to pin
 * this — the port held both reads to the one run that reply named — and a run read
 * answering four runs can no longer stand in for a pin only this reply knows.
 */
export function phaseOutputsFor(request: unknown): unknown {
  const requestedRunId = readUnknownStringMember(request, "workflowRunId");
  const requestedPhaseId = readUnknownStringMember(request, "phaseId");
  if (requestedRunId === undefined || requestedPhaseId === undefined) {
    return undefined;
  }
  if (requestedRunId !== WORKFLOWS_PARKED_RUN.workflowRunId) {
    throw workflowSubjectNotFound("run", requestedRunId);
  }
  if (requestedPhaseId !== WORKFLOWS_COMPLETED_PHASE_ID) {
    throw workflowSubjectNotFound("phase", requestedPhaseId);
  }
  return {
    phaseId: WORKFLOWS_COMPLETED_PHASE_ID,
    state: "completed",
    outputs: WORKFLOWS_SCENARIO_PHASE_OUTPUTS,
  };
}

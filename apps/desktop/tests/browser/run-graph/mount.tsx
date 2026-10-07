// A fixture run's graph mounted on real layout, for the run-graph suites: the run and the document
// it ran, found by the run's id, and the canvas drawn over them once it is fitted, painted and
// placed.

import { useState } from "react";
import { act } from "@testing-library/react";

import type { WorkflowDocument } from "@ai-sidekicks/contracts/workflow/definition/document";
import type {
  WorkflowEdgeItemCount,
  WorkflowRunReadResponse,
} from "@ai-sidekicks/contracts/workflow/run/records";
import type { WorkflowStep } from "@ai-sidekicks/contracts/workflow/run/step/record";

import { renderSettled } from "../../helpers/app/harness.js";
import { crossMacrotaskBoundary } from "../../helpers/macrotask-boundary.js";
import { awaitRunGraphSettled } from "../../helpers/run-graph-settled.js";
import { WORKFLOW_FIXTURE_NOW_MS } from "#fixtures/data/workflow/clock.js";
import {
  WORKFLOW_DEFINITION_RECORDS,
  WORKFLOW_RUN_RECORDS,
} from "#fixtures/data/workflow/run/records.js";
import { installMeridianTokens } from "#renderer/app/token-installation.js";
import { RunGraphCanvas } from "#renderer/features/workflows/runs/page/graph/RunGraphCanvas.js";

/** A fixture run and the document it ran. */
export interface FixtureRun {
  readonly run: WorkflowRunReadResponse;
  readonly workflowDocument: WorkflowDocument;
}

/** A mounted run graph and how to show it other steps, as a run's next read would. */
export interface MountedRunGraph {
  readonly container: HTMLElement;
  readonly showSteps: (steps: WorkflowStep[]) => Promise<void>;
}

/** The fixture run `runId` and the document it ran. Throws when the fixture lacks either. */
export function fixtureRun(runId: string): FixtureRun {
  const run = WORKFLOW_RUN_RECORDS.find((record) => record.read.workflowRunId === runId)?.read;
  const workflowDocument = WORKFLOW_DEFINITION_RECORDS.flatMap((record) => record.versions).find(
    (version) => version.versionId === run?.workflowVersionId,
  )?.document;
  if (run === undefined || workflowDocument === undefined) {
    throw new Error(`the fixture's run ${runId} or its document is missing`);
  }
  return { run, workflowDocument };
}

/**
 * Mounts `fixture`'s graph with its own steps, under `edgeItemCounts` or the run's, and waits until
 * it is fitted, painted and placed.
 */
export async function mountRunGraph(
  fixture: FixtureRun,
  edgeItemCounts: readonly WorkflowEdgeItemCount[] = fixture.run.edgeItemCounts,
): Promise<MountedRunGraph> {
  let setSteps: (steps: WorkflowStep[]) => void = () => undefined;
  function RunGraph(): React.JSX.Element {
    const [steps, setStepsState] = useState<WorkflowStep[]>(fixture.run.steps);
    setSteps = setStepsState;
    return (
      <div className="meridian-run-graph">
        <RunGraphCanvas
          document={fixture.workflowDocument}
          steps={steps}
          edgeItemCounts={edgeItemCounts}
          selectedNodeId={undefined}
          nowMs={WORKFLOW_FIXTURE_NOW_MS}
          onSelectNode={() => undefined}
        />
      </div>
    );
  }
  installMeridianTokens(document);
  const { container } = await renderSettled(<RunGraph />);
  await awaitRunGraphSettled(container);
  return {
    container,
    showSteps: async (steps) => {
      await act(async () => {
        setSteps(steps);
        await crossMacrotaskBoundary();
      });
    },
  };
}

// What every run-snapshot suite needs before it can drive the read.
//
// Three suites now put this hook: the four endings, the port half of the address, and
// the ROUND that re-arms it. All three mount the same probe, wait the same way, and
// need a port that actually answers the run read — so that lives here once, rather
// than in whichever file was written first with the others deep-importing it.
//
// WHAT IS DELIBERATELY NOT HERE is anything one suite reads. The scripted-refusal
// scenario, the commit observer's first-round adapter, the phase-truncating port and
// its counter each have exactly one caller and stay beside it: a helper hoisted before
// it has a second caller is a helper whose shape is decided by nobody.

import { act, render } from "@testing-library/react";

import { createRefusingGrowthPort, type GrowthPort } from "../../../bridge/index.js";
import { WORKFLOWS_SCENARIO_RUNS } from "../../../bridge/scenarios/workflow-fixture-runs.js";
import { useWorkflowRunSnapshot, type WorkflowRunSnapshotState } from "./run-snapshot.js";

/**
 * The round every case but the re-arm ones reads at.
 *
 * A read is put once per round, and a caller that never has an act served never
 * advances past the first — which is what every case outside the re-arm group is
 * about, so they name it rather than each choosing a number.
 */
export const FIRST_ROUND = 0;

export function SnapshotProbe(props: {
  readonly growth: GrowthPort;
  readonly workflowRunId: string | undefined;
  readonly readRound?: number;
  readonly onObserve: (state: WorkflowRunSnapshotState) => void;
}): React.JSX.Element {
  props.onObserve(
    useWorkflowRunSnapshot(props.growth, props.workflowRunId, props.readRound ?? FIRST_ROUND),
  );
  return <></>;
}

/** Let every already-resolved microtask land, inside React's own batching. */
export async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

/** The real port answering the run read from the fixture's own runs, by id. */
export function runReadingGrowthPort(): GrowthPort {
  return {
    ...createRefusingGrowthPort(),
    workflowRunRead: async ({ workflowRunId }) => {
      const run = WORKFLOWS_SCENARIO_RUNS.find(
        (candidate) => candidate.workflowRunId === workflowRunId,
      );
      if (run === undefined) {
        throw new Error(`no fixture run with id ${workflowRunId}`);
      }
      return { status: "served", value: run };
    },
  };
}

/**
 * A port that answers the run read and counts how many times it was asked.
 *
 * The counter is the instrument of the re-arm claim in both directions: a hook that
 * never re-read leaves it at one, and a hook that re-read on every render — the
 * polling this read forbids — climbs without a round ever advancing. Deliberately not
 * a spy on the served port: what is being counted is calls that were actually
 * answered, so the wrapper answers them.
 */
export function countingRunReadPort(): {
  readonly growth: GrowthPort;
  readonly readCount: () => number;
} {
  const served = runReadingGrowthPort();
  let reads = 0;
  return {
    growth: {
      ...served,
      workflowRunRead: async (request) => {
        reads += 1;
        return served.workflowRunRead(request);
      },
    },
    readCount: () => reads,
  };
}

/** The probe mounted, with the handle a re-render at another round needs. */
export function observeRounds(growth: GrowthPort): {
  readonly observed: readonly WorkflowRunSnapshotState[];
  readonly renderAtRound: (workflowRunId: string, readRound: number) => void;
} {
  const observed: WorkflowRunSnapshotState[] = [];
  const collect = (state: WorkflowRunSnapshotState): void => {
    observed.push(state);
  };
  let view: ReturnType<typeof render> | undefined;
  return {
    observed,
    renderAtRound: (workflowRunId, readRound) => {
      const element = (
        <SnapshotProbe
          growth={growth}
          workflowRunId={workflowRunId}
          readRound={readRound}
          onObserve={collect}
        />
      );
      if (view === undefined) {
        view = render(element);
        return;
      }
      // A re-render and never a second mount: the pane is not remounted when a round
      // advances, and a fresh mount would put its first read for a reason no operator
      // caused.
      view.rerender(element);
    },
  };
}

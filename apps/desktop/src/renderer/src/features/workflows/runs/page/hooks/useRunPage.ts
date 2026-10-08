import { useCallback, useEffect, useState } from "react";

import { type WorkflowWaitCause } from "@ai-sidekicks/contracts/workflow/run/status";
import { type WorkflowRunId } from "@ai-sidekicks/contracts/workflow/run/id";
import { WORKFLOW_NOT_FOUND_CODE } from "@ai-sidekicks/contracts/workflow/run/failures";
import {
  type WorkflowStep,
  type WorkflowStepResolution,
} from "@ai-sidekicks/contracts/workflow/run/step/record";
import type { WorkflowRunReadResponse } from "@ai-sidekicks/contracts/workflow/run/records";

import type { PushDrivenReadState } from "#renderer/store/reads/push-driven.js";
import { useWorkflowCommandTarget } from "#renderer/features/workflows/hooks/useWorkflowCommandTarget.js";
import { useWorkflowRead } from "#renderer/features/workflows/hooks/useWorkflowRead.js";
import { useWorkflowCommandTargets } from "#renderer/features/workflows/hooks/useWorkflowCommandTargets.js";
import { createRunRead, type WorkflowReadSources } from "#renderer/features/workflows/reading.js";
import { isPersonWaitCause, latestStepWith } from "../../steps.js";
import { stepKeyText } from "../step/key-text.js";
import { useRunDocument, type RunDocumentHold } from "./useRunDocument.js";

/** The two members that name a step inside its run. */
export type StepAddress = Pick<WorkflowStep, "nodeId" | "executionIndex">;

/** Everything one run's page draws, and the acts on what it shows. */
export interface RunPageHold {
  readonly runState: PushDrivenReadState<WorkflowRunReadResponse>;
  readonly readRunAgain: () => void;
  readonly document: RunDocumentHold;
  /** The node whose step the panel shows, or `undefined` while the panel is closed. */
  readonly selectedNodeId: string | undefined;
  readonly selectNode: (nodeId: string | undefined) => void;
  /** The answers this sitting gave, by step. */
  readonly answers: ReadonlyMap<string, WorkflowStepResolution>;
  /**
   * Keep the panel on a step a person just answered, and the answer, which its receipt reads,
   * until the run reads back answered.
   */
  readonly holdAnswered: (step: StepAddress, answer: WorkflowStepResolution) => void;
}

/**
 * One run's page: its record, kept current by the frames that name it; the version it pinned;
 * which step the panel shows; and the answers given. A run waiting on a person opens with
 * the panel on the step that waits, and a failed run on the step that failed. A run the daemon
 * does not have is reported once, so the screen can open the list with its one line.
 */
export function useRunPage(options: {
  readonly sources: WorkflowReadSources;
  readonly workflowRunId: string;
  readonly onRunMissing: () => void;
  readonly onAnswered: () => void;
}): RunPageHold {
  const { sources, workflowRunId, onRunMissing, onAnswered } = options;
  const { read: runRead, state: runState } = useWorkflowRead(
    sources.bridge,
    sources,
    workflowRunId,
    () => createRunRead(sources, workflowRunId as WorkflowRunId),
  );
  const run = runState.kind === "loaded" ? runState.value : undefined;
  const document = useRunDocument(sources.bridge, run?.definitionId, run?.workflowVersionId);
  // `undefined` until a person picks or closes, so the page opens on its default.
  const [picked, setPicked] = useState<{ readonly nodeId: string | undefined } | undefined>();
  // The step the page opened on, kept once the run is first read: a wait answered elsewhere
  // leaves the panel on its receipt rather than closing it.
  const [opened, setOpened] = useState<{ readonly nodeId: string | undefined } | undefined>();
  useEffect(() => {
    if (run !== undefined && opened === undefined) {
      setOpened({ nodeId: openingNode(run) });
    }
  }, [run, opened]);
  const [answers, setAnswers] = useState<ReadonlyMap<string, WorkflowStepResolution>>(
    () => new Map(),
  );

  const isMissing = runState.kind === "failed" && runState.refusal.code === WORKFLOW_NOT_FOUND_CODE;
  useEffect(() => {
    if (isMissing) {
      onRunMissing();
    }
  }, [isMissing, onRunMissing]);

  const selectNode = useCallback((nodeId: string | undefined) => {
    setPicked({ nodeId });
  }, []);
  // `Answer this run` with no answer on screen opens the panel on the step waiting on a person,
  // and the press goes on to that step's answer once it is offered.
  const commandTargets = useWorkflowCommandTargets();
  // A chain wait is answered on the chain's question, which offers its own answer.
  const answerNode = personWaitNode(run);
  useWorkflowCommandTarget(
    commandTargets.answerThisRun,
    {
      unavailable: () =>
        run === undefined
          ? "Still reading this run."
          : answerNode === undefined || answerNode.cause === "chain"
            ? "This run is not waiting on you."
            : undefined,
      take: () => {
        if (answerNode !== undefined) {
          setPicked({ nodeId: answerNode.nodeId });
        }
      },
    },
    "fallback",
  );
  const holdAnswered = useCallback(
    (step: StepAddress, answer: WorkflowStepResolution) => {
      setAnswers((held) => new Map(held).set(stepKeyText(step), answer));
      // Held on the answered step: once it stops waiting, the default would close the panel.
      setPicked({ nodeId: step.nodeId });
      onAnswered();
    },
    [onAnswered],
  );
  return {
    runState,
    readRunAgain: () => {
      runRead?.refresh("user-request");
    },
    document,
    selectedNodeId: (picked ?? opened ?? { nodeId: openingNode(run) }).nodeId,
    selectNode,
    answers,
    holdAnswered,
  };
}

/** The node the panel opens on: the step waiting on a person, or a failed run's failed step. */
function openingNode(run: WorkflowRunReadResponse | undefined): string | undefined {
  return run?.status === "failed"
    ? latestStepWith(run.steps, "failed")?.nodeId
    : personWaitNode(run)?.nodeId;
}

/** The step waiting on a person: its node, and what it waits for. */
function personWaitNode(
  run: WorkflowRunReadResponse | undefined,
): { readonly nodeId: string; readonly cause: WorkflowWaitCause } | undefined {
  const waiting = run === undefined ? undefined : latestStepWith(run.steps, "waiting");
  return waiting?.waitCause !== undefined && isPersonWaitCause(waiting.waitCause)
    ? { nodeId: waiting.nodeId, cause: waiting.waitCause }
    : undefined;
}

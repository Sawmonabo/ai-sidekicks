// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The step record every workflow run method and event shares: one execution of one node, with its payload references, cost, spent account, question, resolution and review pause, and the key that addresses it.

import type { AgentResolvedConfiguration } from "../../../agent/definition.js";
import type { ArtifactId } from "../../../artifacts/id.js";
import type { WireInstant } from "../../../internal/wire-scalars.js";
import type { ProviderAccountId } from "../../../provider/account/record.js";
import type { ProviderId } from "../../../provider/id.js";
import type { QuestionId } from "../../../question.js";
import type { UsdMicros } from "../../../session/cost.js";
import type { WorkflowNodeId } from "../../definition/document.js";
import type { WorkflowItem, WorkflowStepError } from "../../definition/item.js";
import type { WorkflowRunId } from "../id.js";
import type { WorkflowRunEpoch, WorkflowRunPauseNumber } from "../snapshot.js";

/**
 * The most bytes a step payload is carried inline, counted on its JSON encoding. A larger
 * payload is stored as an artifact and referenced, and the panel says which.
 */
export const WORKFLOW_STEP_PAYLOAD_INLINE_BYTE_CAP = 65536 as const;

/** How a person answers a step that waited on them. */
export const WORKFLOW_STEP_RESOLUTION_KINDS = [
  "approved",
  "rejected",
  "answered",
  "declined",
] as const;

/**
 * A step payload by reference: inline items up to the cap, an artifact above it, which names how
 * many items it holds so a count is drawn without reading it. Step data is kept until the person
 * deletes the run or its session; nothing expires it on its own.
 */
export type WorkflowPayloadRef =
  | {
      kind: "inline";
      /**
       * The items.
       */
      items: WorkflowItem[];
    }
  | {
      kind: "artifact";
      /**
       * The artifact.
       */
      artifactId: ArtifactId;
      /**
       * Its size in bytes.
       */
      sizeBytes: number;
      /**
       * How many items it holds.
       */
      itemCount: number;
    };
/**
 * How a person answered a step that waited on them. `declined` is the `Decline` on a command
 * step's own approval card, which fails that step.
 */
export type WorkflowStepResolutionKind = "approved" | "rejected" | "answered" | "declined";
/**
 * The snapshot an approval pause took, which Review opens on: pinned to an execution of the run
 * and one of its pauses, or missing with the daemon's words for why it could not be taken.
 */
export type WorkflowStepReviewPause =
  | {
      state: "pinned";
      /**
       * Which execution of the run; each re-execution opens the next epoch.
       */
      epoch: WorkflowRunEpoch;
      /**
       * Which of that execution's approval pauses, counted from 1.
       */
      pauseNumber: WorkflowRunPauseNumber;
    }
  | {
      state: "missing";
      /**
       * Why the snapshot could not be taken; `Open in Review` stays in place saying so.
       */
      reason: string;
    };
/**
 * How a failed step's process ended on its own: exactly one of its exit code and the signal that
 * ended it, and the last lines it printed. A step never ends for silence, which only a provider
 * service the daemon ends records.
 */
export type WorkflowStepProcessExit =
  | {
      /**
       * The exit code.
       */
      exitCode: number;
      /**
       * Never present beside an exit code.
       */
      signal?: never;
      /**
       * Never present beside an exit code.
       */
      silentSeconds?: never;
      /**
       * The last lines it printed.
       */
      outputTail: string;
    }
  | {
      /**
       * The signal's name.
       */
      signal: string;
      /**
       * Never present beside a signal.
       */
      exitCode?: never;
      /**
       * Never present beside a signal.
       */
      silentSeconds?: never;
      /**
       * The last lines it printed.
       */
      outputTail: string;
    };
/**
 * One execution of one node, told apart by its `status`. `executionIndex` is per run and
 * increasing, so it orders a branching run faithfully; `source` records, per input slot, the edge
 * that actually fed it and which execution of the source produced it. Only a waiting step names
 * what it waits on, only a failed one its process exit, and only one no longer waiting how a
 * person answered it.
 */
export type WorkflowStep =
  | {
      status: "pending";
      /**
       * The run.
       */
      workflowRunId: WorkflowRunId;
      /**
       * The node.
       */
      nodeId: WorkflowNodeId;
      /**
       * Which attempt at the step, counted from 1: each retry is a new attempt.
       */
      attempt: number;
      /**
       * Which execution of the node, increasing through the run.
       */
      executionIndex: number;
      /**
       * Per input slot, the feed that actually fed it, or `null` for a slot nothing fed.
       */
      source: (WorkflowStepSource | null)[];
      /**
       * When it started.
       */
      startedAt: WireInstant;
      /**
       * When it finished; absent while it has not.
       */
      finishedAt?: WireInstant;
      /**
       * The input it ran on.
       */
      inputRef: WorkflowPayloadRef;
      /**
       * The output it produced.
       */
      outputRef: WorkflowPayloadRef;
      /**
       * Its log.
       */
      logRef: WorkflowPayloadRef;
      /**
       * What it cost; absent where no provider was billed.
       */
      cost?: WorkflowCost;
      /**
       * Its error.
       */
      error?: WorkflowStepError;
      /**
       * Non-fatal hints the step attached; never errors.
       */
      advisories?: string[];
      /**
       * Every field of the agent it ran as actually applied, where it ran one.
       */
      resolvedConfiguration?: AgentResolvedConfiguration;
      /**
       * Present on an approval step of a run that captured its checkout: its pause's
       * snapshot.
       */
      reviewPause?: WorkflowStepReviewPause;
      /**
       * Present on an `Execute workflow` step once it started its child run, which it
       * links to.
       */
      childWorkflowRunId?: WorkflowRunId;
      /**
       * The milliseconds the memory gate held the step before it started, summed over
       * every hold; `0` where it was never held.
       */
      totalPoolWaitMs: number;
      /**
       * Never present: only a waiting step names a cause.
       */
      waitCause?: never;
      /**
       * Never present: only a waiting step names a spent account.
       */
      waitAccount?: never;
      /**
       * Never present: only a waiting step resumes itself.
       */
      resumeAt?: never;
      /**
       * Never present: only a waiting step gives up.
       */
      waitDeadlineAt?: never;
      /**
       * Never present: only a waiting step holds a question.
       */
      question?: never;
      /**
       * Never present: only a failed step names a process exit.
       */
      processExit?: never;
      /**
       * Present once a person has answered this step.
       */
      resolution?: WorkflowStepResolution;
    }
  | {
      status: "running";
      /**
       * The run.
       */
      workflowRunId: WorkflowRunId;
      /**
       * The node.
       */
      nodeId: WorkflowNodeId;
      /**
       * Which attempt at the step, counted from 1: each retry is a new attempt.
       */
      attempt: number;
      /**
       * Which execution of the node, increasing through the run.
       */
      executionIndex: number;
      /**
       * Per input slot, the feed that actually fed it, or `null` for a slot nothing fed.
       */
      source: (WorkflowStepSource | null)[];
      /**
       * When it started.
       */
      startedAt: WireInstant;
      /**
       * When it finished; absent while it has not.
       */
      finishedAt?: WireInstant;
      /**
       * The input it ran on.
       */
      inputRef: WorkflowPayloadRef;
      /**
       * The output it produced.
       */
      outputRef: WorkflowPayloadRef;
      /**
       * Its log.
       */
      logRef: WorkflowPayloadRef;
      /**
       * What it cost; absent where no provider was billed.
       */
      cost?: WorkflowCost;
      /**
       * Its error.
       */
      error?: WorkflowStepError;
      /**
       * Non-fatal hints the step attached; never errors.
       */
      advisories?: string[];
      /**
       * Every field of the agent it ran as actually applied, where it ran one.
       */
      resolvedConfiguration?: AgentResolvedConfiguration;
      /**
       * Present on an approval step of a run that captured its checkout: its pause's
       * snapshot.
       */
      reviewPause?: WorkflowStepReviewPause;
      /**
       * Present on an `Execute workflow` step once it started its child run, which it
       * links to.
       */
      childWorkflowRunId?: WorkflowRunId;
      /**
       * The milliseconds the memory gate held the step before it started, summed over
       * every hold; `0` where it was never held.
       */
      totalPoolWaitMs: number;
      /**
       * Never present: only a waiting step names a cause.
       */
      waitCause?: never;
      /**
       * Never present: only a waiting step names a spent account.
       */
      waitAccount?: never;
      /**
       * Never present: only a waiting step resumes itself.
       */
      resumeAt?: never;
      /**
       * Never present: only a waiting step gives up.
       */
      waitDeadlineAt?: never;
      /**
       * Never present: only a waiting step holds a question.
       */
      question?: never;
      /**
       * Never present: only a failed step names a process exit.
       */
      processExit?: never;
      /**
       * Present once a person has answered this step.
       */
      resolution?: WorkflowStepResolution;
    }
  | ((
      | {
          waitCause: "account";
          /**
           * The run.
           */
          workflowRunId: WorkflowRunId;
          /**
           * The node.
           */
          nodeId: WorkflowNodeId;
          /**
           * Which attempt at the step, counted from 1: each retry is a new attempt.
           */
          attempt: number;
          /**
           * Which execution of the node, increasing through the run.
           */
          executionIndex: number;
          /**
           * Per input slot, the feed that actually fed it, or `null` for a slot nothing fed.
           */
          source: (WorkflowStepSource | null)[];
          /**
           * When it started.
           */
          startedAt: WireInstant;
          /**
           * When it finished; absent while it has not.
           */
          finishedAt?: WireInstant;
          /**
           * The input it ran on.
           */
          inputRef: WorkflowPayloadRef;
          /**
           * The output it produced.
           */
          outputRef: WorkflowPayloadRef;
          /**
           * Its log.
           */
          logRef: WorkflowPayloadRef;
          /**
           * What it cost; absent where no provider was billed.
           */
          cost?: WorkflowCost;
          /**
           * Its error.
           */
          error?: WorkflowStepError;
          /**
           * Non-fatal hints the step attached; never errors.
           */
          advisories?: string[];
          /**
           * Every field of the agent it ran as actually applied, where it ran one.
           */
          resolvedConfiguration?: AgentResolvedConfiguration;
          /**
           * Present on an approval step of a run that captured its checkout: its pause's
           * snapshot.
           */
          reviewPause?: WorkflowStepReviewPause;
          /**
           * Present on an `Execute workflow` step once it started its child run, which it
           * links to.
           */
          childWorkflowRunId?: WorkflowRunId;
          /**
           * The milliseconds the memory gate held the step before it started, summed over
           * every hold; `0` where it was never held.
           */
          totalPoolWaitMs: number;
          /**
           * The spent account.
           */
          waitAccount: WorkflowSpentAccount;
          /**
           * When the wait resumes itself; absent where none is armed, when only the person resumes
           * it.
           */
          resumeAt?: WireInstant;
          /**
           * Never present: only a wait on a person gives up.
           */
          waitDeadlineAt?: never;
          /**
           * Never present: only a chat reply holds a question.
           */
          question?: never;
          /**
           * Never present: a waiting step's process has not ended.
           */
          processExit?: never;
          /**
           * Never present: nobody has answered a waiting step.
           */
          resolution?: never;
        }
      | {
          waitCause: "reply";
          /**
           * The run.
           */
          workflowRunId: WorkflowRunId;
          /**
           * The node.
           */
          nodeId: WorkflowNodeId;
          /**
           * Which attempt at the step, counted from 1: each retry is a new attempt.
           */
          attempt: number;
          /**
           * Which execution of the node, increasing through the run.
           */
          executionIndex: number;
          /**
           * Per input slot, the feed that actually fed it, or `null` for a slot nothing fed.
           */
          source: (WorkflowStepSource | null)[];
          /**
           * When it started.
           */
          startedAt: WireInstant;
          /**
           * When it finished; absent while it has not.
           */
          finishedAt?: WireInstant;
          /**
           * The input it ran on.
           */
          inputRef: WorkflowPayloadRef;
          /**
           * The output it produced.
           */
          outputRef: WorkflowPayloadRef;
          /**
           * Its log.
           */
          logRef: WorkflowPayloadRef;
          /**
           * What it cost; absent where no provider was billed.
           */
          cost?: WorkflowCost;
          /**
           * Its error.
           */
          error?: WorkflowStepError;
          /**
           * Non-fatal hints the step attached; never errors.
           */
          advisories?: string[];
          /**
           * Every field of the agent it ran as actually applied, where it ran one.
           */
          resolvedConfiguration?: AgentResolvedConfiguration;
          /**
           * Present on an approval step of a run that captured its checkout: its pause's
           * snapshot.
           */
          reviewPause?: WorkflowStepReviewPause;
          /**
           * Present on an `Execute workflow` step once it started its child run, which it
           * links to.
           */
          childWorkflowRunId?: WorkflowRunId;
          /**
           * The milliseconds the memory gate held the step before it started, summed over
           * every hold; `0` where it was never held.
           */
          totalPoolWaitMs: number;
          /**
           * Never present: only an account wait names an account.
           */
          waitAccount?: never;
          /**
           * Never present: only an account wait resumes itself.
           */
          resumeAt?: never;
          /**
           * When the wait gives up, where the node sets a `Timeout`.
           */
          waitDeadlineAt?: WireInstant;
          /**
           * The question the chat reply answers.
           */
          question: WorkflowStepQuestion;
          /**
           * Never present: a waiting step's process has not ended.
           */
          processExit?: never;
          /**
           * Never present: nobody has answered a waiting step.
           */
          resolution?: never;
        }
      | {
          waitCause: "approval";
          /**
           * The run.
           */
          workflowRunId: WorkflowRunId;
          /**
           * The node.
           */
          nodeId: WorkflowNodeId;
          /**
           * Which attempt at the step, counted from 1: each retry is a new attempt.
           */
          attempt: number;
          /**
           * Which execution of the node, increasing through the run.
           */
          executionIndex: number;
          /**
           * Per input slot, the feed that actually fed it, or `null` for a slot nothing fed.
           */
          source: (WorkflowStepSource | null)[];
          /**
           * When it started.
           */
          startedAt: WireInstant;
          /**
           * When it finished; absent while it has not.
           */
          finishedAt?: WireInstant;
          /**
           * The input it ran on.
           */
          inputRef: WorkflowPayloadRef;
          /**
           * The output it produced.
           */
          outputRef: WorkflowPayloadRef;
          /**
           * Its log.
           */
          logRef: WorkflowPayloadRef;
          /**
           * What it cost; absent where no provider was billed.
           */
          cost?: WorkflowCost;
          /**
           * Its error.
           */
          error?: WorkflowStepError;
          /**
           * Non-fatal hints the step attached; never errors.
           */
          advisories?: string[];
          /**
           * Every field of the agent it ran as actually applied, where it ran one.
           */
          resolvedConfiguration?: AgentResolvedConfiguration;
          /**
           * Present on an approval step of a run that captured its checkout: its pause's
           * snapshot.
           */
          reviewPause?: WorkflowStepReviewPause;
          /**
           * Present on an `Execute workflow` step once it started its child run, which it
           * links to.
           */
          childWorkflowRunId?: WorkflowRunId;
          /**
           * The milliseconds the memory gate held the step before it started, summed over
           * every hold; `0` where it was never held.
           */
          totalPoolWaitMs: number;
          /**
           * Never present: only an account wait names an account.
           */
          waitAccount?: never;
          /**
           * Never present: only an account wait resumes itself.
           */
          resumeAt?: never;
          /**
           * When the wait gives up, where the node sets a `Timeout`.
           */
          waitDeadlineAt?: WireInstant;
          /**
           * Never present: only a chat reply holds a question.
           */
          question?: never;
          /**
           * Never present: a waiting step's process has not ended.
           */
          processExit?: never;
          /**
           * Never present: nobody has answered a waiting step.
           */
          resolution?: never;
        }
      | {
          waitCause: "form";
          /**
           * The run.
           */
          workflowRunId: WorkflowRunId;
          /**
           * The node.
           */
          nodeId: WorkflowNodeId;
          /**
           * Which attempt at the step, counted from 1: each retry is a new attempt.
           */
          attempt: number;
          /**
           * Which execution of the node, increasing through the run.
           */
          executionIndex: number;
          /**
           * Per input slot, the feed that actually fed it, or `null` for a slot nothing fed.
           */
          source: (WorkflowStepSource | null)[];
          /**
           * When it started.
           */
          startedAt: WireInstant;
          /**
           * When it finished; absent while it has not.
           */
          finishedAt?: WireInstant;
          /**
           * The input it ran on.
           */
          inputRef: WorkflowPayloadRef;
          /**
           * The output it produced.
           */
          outputRef: WorkflowPayloadRef;
          /**
           * Its log.
           */
          logRef: WorkflowPayloadRef;
          /**
           * What it cost; absent where no provider was billed.
           */
          cost?: WorkflowCost;
          /**
           * Its error.
           */
          error?: WorkflowStepError;
          /**
           * Non-fatal hints the step attached; never errors.
           */
          advisories?: string[];
          /**
           * Every field of the agent it ran as actually applied, where it ran one.
           */
          resolvedConfiguration?: AgentResolvedConfiguration;
          /**
           * Present on an approval step of a run that captured its checkout: its pause's
           * snapshot.
           */
          reviewPause?: WorkflowStepReviewPause;
          /**
           * Present on an `Execute workflow` step once it started its child run, which it
           * links to.
           */
          childWorkflowRunId?: WorkflowRunId;
          /**
           * The milliseconds the memory gate held the step before it started, summed over
           * every hold; `0` where it was never held.
           */
          totalPoolWaitMs: number;
          /**
           * Never present: only an account wait names an account.
           */
          waitAccount?: never;
          /**
           * Never present: only an account wait resumes itself.
           */
          resumeAt?: never;
          /**
           * When the wait gives up, where the node sets a `Timeout`.
           */
          waitDeadlineAt?: WireInstant;
          /**
           * Never present: only a chat reply holds a question.
           */
          question?: never;
          /**
           * Never present: a waiting step's process has not ended.
           */
          processExit?: never;
          /**
           * Never present: nobody has answered a waiting step.
           */
          resolution?: never;
        }
      | {
          waitCause: "chain";
          /**
           * The run.
           */
          workflowRunId: WorkflowRunId;
          /**
           * The node.
           */
          nodeId: WorkflowNodeId;
          /**
           * Which attempt at the step, counted from 1: each retry is a new attempt.
           */
          attempt: number;
          /**
           * Which execution of the node, increasing through the run.
           */
          executionIndex: number;
          /**
           * Per input slot, the feed that actually fed it, or `null` for a slot nothing fed.
           */
          source: (WorkflowStepSource | null)[];
          /**
           * When it started.
           */
          startedAt: WireInstant;
          /**
           * When it finished; absent while it has not.
           */
          finishedAt?: WireInstant;
          /**
           * The input it ran on.
           */
          inputRef: WorkflowPayloadRef;
          /**
           * The output it produced.
           */
          outputRef: WorkflowPayloadRef;
          /**
           * Its log.
           */
          logRef: WorkflowPayloadRef;
          /**
           * What it cost; absent where no provider was billed.
           */
          cost?: WorkflowCost;
          /**
           * Its error.
           */
          error?: WorkflowStepError;
          /**
           * Non-fatal hints the step attached; never errors.
           */
          advisories?: string[];
          /**
           * Every field of the agent it ran as actually applied, where it ran one.
           */
          resolvedConfiguration?: AgentResolvedConfiguration;
          /**
           * Present on an approval step of a run that captured its checkout: its pause's
           * snapshot.
           */
          reviewPause?: WorkflowStepReviewPause;
          /**
           * Present on an `Execute workflow` step once it started its child run, which it
           * links to.
           */
          childWorkflowRunId?: WorkflowRunId;
          /**
           * The milliseconds the memory gate held the step before it started, summed over
           * every hold; `0` where it was never held.
           */
          totalPoolWaitMs: number;
          /**
           * Never present: only an account wait names an account.
           */
          waitAccount?: never;
          /**
           * Never present: only an account wait resumes itself.
           */
          resumeAt?: never;
          /**
           * Never present: only a wait on a person gives up.
           */
          waitDeadlineAt?: never;
          /**
           * Never present: only a chat reply holds a question.
           */
          question?: never;
          /**
           * Never present: a waiting step's process has not ended.
           */
          processExit?: never;
          /**
           * Never present: nobody has answered a waiting step.
           */
          resolution?: never;
        }
    ) & {
      status: "waiting";
    })
  | {
      status: "waitingMemory";
      /**
       * The run.
       */
      workflowRunId: WorkflowRunId;
      /**
       * The node.
       */
      nodeId: WorkflowNodeId;
      /**
       * Which attempt at the step, counted from 1: each retry is a new attempt.
       */
      attempt: number;
      /**
       * Which execution of the node, increasing through the run.
       */
      executionIndex: number;
      /**
       * Per input slot, the feed that actually fed it, or `null` for a slot nothing fed.
       */
      source: (WorkflowStepSource | null)[];
      /**
       * When it started.
       */
      startedAt: WireInstant;
      /**
       * When it finished; absent while it has not.
       */
      finishedAt?: WireInstant;
      /**
       * The input it ran on.
       */
      inputRef: WorkflowPayloadRef;
      /**
       * The output it produced.
       */
      outputRef: WorkflowPayloadRef;
      /**
       * Its log.
       */
      logRef: WorkflowPayloadRef;
      /**
       * What it cost; absent where no provider was billed.
       */
      cost?: WorkflowCost;
      /**
       * Its error.
       */
      error?: WorkflowStepError;
      /**
       * Non-fatal hints the step attached; never errors.
       */
      advisories?: string[];
      /**
       * Every field of the agent it ran as actually applied, where it ran one.
       */
      resolvedConfiguration?: AgentResolvedConfiguration;
      /**
       * Present on an approval step of a run that captured its checkout: its pause's
       * snapshot.
       */
      reviewPause?: WorkflowStepReviewPause;
      /**
       * Present on an `Execute workflow` step once it started its child run, which it
       * links to.
       */
      childWorkflowRunId?: WorkflowRunId;
      /**
       * The milliseconds the memory gate held the step before it started, summed over
       * every hold; `0` where it was never held.
       */
      totalPoolWaitMs: number;
      /**
       * Never present: only a waiting step names a cause.
       */
      waitCause?: never;
      /**
       * Never present: only a waiting step names a spent account.
       */
      waitAccount?: never;
      /**
       * Never present: only a waiting step resumes itself.
       */
      resumeAt?: never;
      /**
       * Never present: only a waiting step gives up.
       */
      waitDeadlineAt?: never;
      /**
       * Never present: only a waiting step holds a question.
       */
      question?: never;
      /**
       * Never present: only a failed step names a process exit.
       */
      processExit?: never;
      /**
       * Present once a person has answered this step.
       */
      resolution?: WorkflowStepResolution;
    }
  | {
      status: "succeeded";
      /**
       * The run.
       */
      workflowRunId: WorkflowRunId;
      /**
       * The node.
       */
      nodeId: WorkflowNodeId;
      /**
       * Which attempt at the step, counted from 1: each retry is a new attempt.
       */
      attempt: number;
      /**
       * Which execution of the node, increasing through the run.
       */
      executionIndex: number;
      /**
       * Per input slot, the feed that actually fed it, or `null` for a slot nothing fed.
       */
      source: (WorkflowStepSource | null)[];
      /**
       * When it started.
       */
      startedAt: WireInstant;
      /**
       * When it finished; absent while it has not.
       */
      finishedAt?: WireInstant;
      /**
       * The input it ran on.
       */
      inputRef: WorkflowPayloadRef;
      /**
       * The output it produced.
       */
      outputRef: WorkflowPayloadRef;
      /**
       * Its log.
       */
      logRef: WorkflowPayloadRef;
      /**
       * What it cost; absent where no provider was billed.
       */
      cost?: WorkflowCost;
      /**
       * Its error.
       */
      error?: WorkflowStepError;
      /**
       * Non-fatal hints the step attached; never errors.
       */
      advisories?: string[];
      /**
       * Every field of the agent it ran as actually applied, where it ran one.
       */
      resolvedConfiguration?: AgentResolvedConfiguration;
      /**
       * Present on an approval step of a run that captured its checkout: its pause's
       * snapshot.
       */
      reviewPause?: WorkflowStepReviewPause;
      /**
       * Present on an `Execute workflow` step once it started its child run, which it
       * links to.
       */
      childWorkflowRunId?: WorkflowRunId;
      /**
       * The milliseconds the memory gate held the step before it started, summed over
       * every hold; `0` where it was never held.
       */
      totalPoolWaitMs: number;
      /**
       * Never present: only a waiting step names a cause.
       */
      waitCause?: never;
      /**
       * Never present: only a waiting step names a spent account.
       */
      waitAccount?: never;
      /**
       * Never present: only a waiting step resumes itself.
       */
      resumeAt?: never;
      /**
       * Never present: only a waiting step gives up.
       */
      waitDeadlineAt?: never;
      /**
       * Never present: only a waiting step holds a question.
       */
      question?: never;
      /**
       * Never present: only a failed step names a process exit.
       */
      processExit?: never;
      /**
       * Present once a person has answered this step.
       */
      resolution?: WorkflowStepResolution;
    }
  | {
      status: "failed";
      /**
       * The run.
       */
      workflowRunId: WorkflowRunId;
      /**
       * The node.
       */
      nodeId: WorkflowNodeId;
      /**
       * Which attempt at the step, counted from 1: each retry is a new attempt.
       */
      attempt: number;
      /**
       * Which execution of the node, increasing through the run.
       */
      executionIndex: number;
      /**
       * Per input slot, the feed that actually fed it, or `null` for a slot nothing fed.
       */
      source: (WorkflowStepSource | null)[];
      /**
       * When it started.
       */
      startedAt: WireInstant;
      /**
       * When it finished; absent while it has not.
       */
      finishedAt?: WireInstant;
      /**
       * The input it ran on.
       */
      inputRef: WorkflowPayloadRef;
      /**
       * The output it produced.
       */
      outputRef: WorkflowPayloadRef;
      /**
       * Its log.
       */
      logRef: WorkflowPayloadRef;
      /**
       * What it cost; absent where no provider was billed.
       */
      cost?: WorkflowCost;
      /**
       * Its error.
       */
      error?: WorkflowStepError;
      /**
       * Non-fatal hints the step attached; never errors.
       */
      advisories?: string[];
      /**
       * Every field of the agent it ran as actually applied, where it ran one.
       */
      resolvedConfiguration?: AgentResolvedConfiguration;
      /**
       * Present on an approval step of a run that captured its checkout: its pause's
       * snapshot.
       */
      reviewPause?: WorkflowStepReviewPause;
      /**
       * Present on an `Execute workflow` step once it started its child run, which it
       * links to.
       */
      childWorkflowRunId?: WorkflowRunId;
      /**
       * The milliseconds the memory gate held the step before it started, summed over
       * every hold; `0` where it was never held.
       */
      totalPoolWaitMs: number;
      /**
       * Never present: only a waiting step names a cause.
       */
      waitCause?: never;
      /**
       * Never present: only a waiting step names a spent account.
       */
      waitAccount?: never;
      /**
       * Never present: only a waiting step resumes itself.
       */
      resumeAt?: never;
      /**
       * Never present: only a waiting step gives up.
       */
      waitDeadlineAt?: never;
      /**
       * Never present: only a waiting step holds a question.
       */
      question?: never;
      /**
       * Present where the step's process ended on its own: its exit and last lines.
       */
      processExit?: WorkflowStepProcessExit;
      /**
       * Present once a person has answered this step.
       */
      resolution?: WorkflowStepResolution;
    }
  | {
      status: "skipped";
      /**
       * The run.
       */
      workflowRunId: WorkflowRunId;
      /**
       * The node.
       */
      nodeId: WorkflowNodeId;
      /**
       * Which attempt at the step, counted from 1: each retry is a new attempt.
       */
      attempt: number;
      /**
       * Which execution of the node, increasing through the run.
       */
      executionIndex: number;
      /**
       * Per input slot, the feed that actually fed it, or `null` for a slot nothing fed.
       */
      source: (WorkflowStepSource | null)[];
      /**
       * When it started.
       */
      startedAt: WireInstant;
      /**
       * When it finished; absent while it has not.
       */
      finishedAt?: WireInstant;
      /**
       * The input it ran on.
       */
      inputRef: WorkflowPayloadRef;
      /**
       * The output it produced.
       */
      outputRef: WorkflowPayloadRef;
      /**
       * Its log.
       */
      logRef: WorkflowPayloadRef;
      /**
       * What it cost; absent where no provider was billed.
       */
      cost?: WorkflowCost;
      /**
       * Its error.
       */
      error?: WorkflowStepError;
      /**
       * Non-fatal hints the step attached; never errors.
       */
      advisories?: string[];
      /**
       * Every field of the agent it ran as actually applied, where it ran one.
       */
      resolvedConfiguration?: AgentResolvedConfiguration;
      /**
       * Present on an approval step of a run that captured its checkout: its pause's
       * snapshot.
       */
      reviewPause?: WorkflowStepReviewPause;
      /**
       * Present on an `Execute workflow` step once it started its child run, which it
       * links to.
       */
      childWorkflowRunId?: WorkflowRunId;
      /**
       * The milliseconds the memory gate held the step before it started, summed over
       * every hold; `0` where it was never held.
       */
      totalPoolWaitMs: number;
      /**
       * Never present: only a waiting step names a cause.
       */
      waitCause?: never;
      /**
       * Never present: only a waiting step names a spent account.
       */
      waitAccount?: never;
      /**
       * Never present: only a waiting step resumes itself.
       */
      resumeAt?: never;
      /**
       * Never present: only a waiting step gives up.
       */
      waitDeadlineAt?: never;
      /**
       * Never present: only a waiting step holds a question.
       */
      question?: never;
      /**
       * Never present: only a failed step names a process exit.
       */
      processExit?: never;
      /**
       * Present once a person has answered this step.
       */
      resolution?: WorkflowStepResolution;
    }
  | {
      status: "canceled";
      /**
       * The run.
       */
      workflowRunId: WorkflowRunId;
      /**
       * The node.
       */
      nodeId: WorkflowNodeId;
      /**
       * Which attempt at the step, counted from 1: each retry is a new attempt.
       */
      attempt: number;
      /**
       * Which execution of the node, increasing through the run.
       */
      executionIndex: number;
      /**
       * Per input slot, the feed that actually fed it, or `null` for a slot nothing fed.
       */
      source: (WorkflowStepSource | null)[];
      /**
       * When it started.
       */
      startedAt: WireInstant;
      /**
       * When it finished; absent while it has not.
       */
      finishedAt?: WireInstant;
      /**
       * The input it ran on.
       */
      inputRef: WorkflowPayloadRef;
      /**
       * The output it produced.
       */
      outputRef: WorkflowPayloadRef;
      /**
       * Its log.
       */
      logRef: WorkflowPayloadRef;
      /**
       * What it cost; absent where no provider was billed.
       */
      cost?: WorkflowCost;
      /**
       * Its error.
       */
      error?: WorkflowStepError;
      /**
       * Non-fatal hints the step attached; never errors.
       */
      advisories?: string[];
      /**
       * Every field of the agent it ran as actually applied, where it ran one.
       */
      resolvedConfiguration?: AgentResolvedConfiguration;
      /**
       * Present on an approval step of a run that captured its checkout: its pause's
       * snapshot.
       */
      reviewPause?: WorkflowStepReviewPause;
      /**
       * Present on an `Execute workflow` step once it started its child run, which it
       * links to.
       */
      childWorkflowRunId?: WorkflowRunId;
      /**
       * The milliseconds the memory gate held the step before it started, summed over
       * every hold; `0` where it was never held.
       */
      totalPoolWaitMs: number;
      /**
       * Never present: only a waiting step names a cause.
       */
      waitCause?: never;
      /**
       * Never present: only a waiting step names a spent account.
       */
      waitAccount?: never;
      /**
       * Never present: only a waiting step resumes itself.
       */
      resumeAt?: never;
      /**
       * Never present: only a waiting step gives up.
       */
      waitDeadlineAt?: never;
      /**
       * Never present: only a waiting step holds a question.
       */
      question?: never;
      /**
       * Never present: only a failed step names a process exit.
       */
      processExit?: never;
      /**
       * Present once a person has answered this step.
       */
      resolution?: WorkflowStepResolution;
    };

/**
 * What a step or a run cost, in whole micro-dollars, and the account that paid. Present only where
 * a provider was billed; a step that spent nothing carries none.
 */
export interface WorkflowCost {
  /**
   * The cost.
   */
  usdMicros: UsdMicros;
  /**
   * The account that paid.
   */
  providerAccountId: ProviderAccountId;
}
/**
 * A spent provider account as a wait names it: its id, its provider and the label every surface
 * names an account by, so no account id reaches the screen.
 */
export interface WorkflowSpentAccount {
  /**
   * The account.
   */
  providerAccountId: ProviderAccountId;
  /**
   * Its provider.
   */
  provider: ProviderId;
  /**
   * Its label.
   */
  label: string;
}
/**
 * One input slot's feed: the node, its output and which execution of it fed the slot.
 */
export interface WorkflowStepSource {
  /**
   * The node that fed the slot.
   */
  nodeId: WorkflowNodeId;
  /**
   * Which of its outputs.
   */
  outputIndex: number;
  /**
   * Which execution of it.
   */
  executionIndex: number;
}
/**
 * The question a step waiting for a chat reply holds. `questionId` is the record
 * `question.resolve` answers and `waitId` the wait it settles, so the step panel and the session's
 * question card answer one wait and the first answer through either settles both.
 */
export interface WorkflowStepQuestion {
  /**
   * The question record.
   */
  questionId: QuestionId;
  /**
   * The wait it settles.
   */
  waitId: string;
  /**
   * What it asks.
   */
  prompt: string;
}
/**
 * The record of how a person answered a step and when, kept on the step so the receipt it earns,
 * `Approved at 2:14 PM` or `Declined at 2:14 PM · use the test database`, reads the same after a
 * reload.
 */
export interface WorkflowStepResolution {
  /**
   * How the person answered.
   */
  kind: WorkflowStepResolutionKind;
  /**
   * When.
   */
  at: WireInstant;
  /**
   * The words the person typed on the `Decline`'s `why not` line; present only on a `declined`
   * resolution whose Decline carried words.
   */
  declineReason?: string;
}
/**
 * The four members that address one step: the run, the node, the attempt and which
 * execution. It is the whole input of a form read and a fix session.
 */
export interface WorkflowStepKey {
  /**
   * The run.
   */
  workflowRunId: WorkflowRunId;
  /**
   * The node.
   */
  nodeId: WorkflowNodeId;
  /**
   * Which attempt at the step, counted from 1: each retry is a new attempt.
   */
  attempt: number;
  /**
   * Which execution of the node, increasing through the run.
   */
  executionIndex: number;
}

export {
  validateWorkflowCost,
  validateWorkflowPayloadRef,
  validateWorkflowSpentAccount,
  validateWorkflowStep,
  validateWorkflowStepKey,
  validateWorkflowStepProcessExit,
  validateWorkflowStepQuestion,
  validateWorkflowStepResolution,
  validateWorkflowStepResolutionKind,
  validateWorkflowStepReviewPause,
  validateWorkflowStepSource,
} from "../../../checks/workflow/run/step/record.js";

// Worktree setup contracts: the setup card's live status and its retry.
//
// IMPORT DIRECTION IS ONE-WAY: this module imports nothing from `./event.js` and nothing whose
// import closure reaches it (see the header of `repo.ts`).
import { z } from "zod";

import { SubscribeAckResponseSchema, type SubscribeAckResponse } from "./jsonrpc-streaming.js";
import { PROJECT_SETUP_COMMAND_MAX_LEN } from "./project.js";
import { wireFreeFormString } from "./session.js";
import { WORKSPACE_LAST_ERROR_MAX_LEN } from "./workspace.js";
import { WorktreeIdSchema, type WorktreeId } from "./worktree.js";

// Setting a new tree up runs three stages in the composer card: making the tree, the project's own
// setup steps, and warming what the session reads first. The steps are kept, so the card reads the
// same after leaving the session and coming back; a failed step stops the run and the card stays
// until it is retried from that step.

/**
 * The longest step output the card carries. A setup command's captured output,
 * bounded like a single captured failure detail, the tail kept when it is longer.
 */
export const WORKTREE_SETUP_OUTPUT_MAX_LEN = 32768;

/** The three stages of setting a tree up, in the order they run. */
export type WorktreeSetupStage = "make_tree" | "project_steps" | "warm_caches";
/** Where one setup step stands. */
export type WorktreeSetupStepState = "pending" | "running" | "succeeded" | "failed";

/**
 * One step of the setup card, in run order. `label` names the step (the command,
 * for a project step); `error` and `output` are present on a failed step, and
 * `elapsedMs` once the step has run.
 */
export interface WorktreeSetupStep {
  stage: WorktreeSetupStage;
  label: string;
  state: WorktreeSetupStepState;
  elapsedMs?: number | undefined;
  error?: string | undefined;
  output?: string | undefined;
}

/** One `repo.worktreeSetupSubscribe` emission: the whole card for one tree. */
export interface WorktreeSetupStatus {
  worktreeId: WorktreeId;
  state: "running" | "succeeded" | "failed";
  steps: WorktreeSetupStep[];
}
/** Wire schema for {@link WorktreeSetupStatus}. */
export const WorktreeSetupStatusSchema: z.ZodType<WorktreeSetupStatus> = z
  .object({
    worktreeId: WorktreeIdSchema,
    state: z.enum(["running", "succeeded", "failed"]),
    steps: z.array(
      z
        .object({
          stage: z.enum(["make_tree", "project_steps", "warm_caches"]),
          label: wireFreeFormString(PROJECT_SETUP_COMMAND_MAX_LEN, "WorktreeSetupStep.label"),
          state: z.enum(["pending", "running", "succeeded", "failed"]),
          elapsedMs: z.number().int().nonnegative().optional(),
          error: wireFreeFormString(
            WORKSPACE_LAST_ERROR_MAX_LEN,
            "WorktreeSetupStep.error",
          ).optional(),
          output: z.string().max(WORKTREE_SETUP_OUTPUT_MAX_LEN).optional(),
        })
        .strict(),
    ),
  })
  .strict();

/** The tree whose setup a card follows or retries. */
export interface WorktreeSetupRequest {
  worktreeId: WorktreeId;
}
/**
 * Wire schema for {@link WorktreeSetupRequest}: `repo.worktreeSetupSubscribe`
 * and `repo.worktreeSetupRetry` each take only the tree. A retry runs the
 * failed step and the ones after it.
 */
export const WorktreeSetupRequestSchema: z.ZodType<WorktreeSetupRequest, WorktreeSetupRequest> = z
  .object({ worktreeId: WorktreeIdSchema })
  .strict();

/** The `repo.worktreeSetupSubscribe` acknowledgement. */
export type WorktreeSetupSubscribeResponse = SubscribeAckResponse;
/** Wire schema for {@link WorktreeSetupSubscribeResponse}. */
export const WorktreeSetupSubscribeResponseSchema: z.ZodType<WorktreeSetupSubscribeResponse> =
  SubscribeAckResponseSchema;

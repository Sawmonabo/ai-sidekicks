// Worktree setup contracts: the setup card's live status and its retry.
//
// This module imports nothing from `./event.js` and nothing whose import closure reaches it, for
// the module-cycle reason in the header of `repo.ts`.
import { z } from "zod";

import { SubscribeAckResponseSchema, type SubscribeAckResponse } from "./jsonrpc-streaming.js";
import { PROJECT_SETUP_COMMAND_MAX_LEN } from "./project.js";
import { wireFreeFormString } from "./session.js";
import { WORKSPACE_LAST_ERROR_MAX_LEN } from "./workspace.js";
import { WorktreeIdSchema, type WorktreeId } from "./worktree.js";
import { countSchema } from "./internal/wire-scalars.js";

// Setting a new tree up runs three stages in the composer card: making the tree, the project's own
// setup steps, and warming what the session reads first. The steps are kept, so the card reads the
// same after leaving the session and coming back; a failed step stops the run and the card stays
// until it is retried from that step.

/**
 * The longest captured output a setup step carries, in UTF-16 code units; the daemon keeps the
 * tail of a longer output.
 */
export const WORKTREE_SETUP_OUTPUT_MAX_LEN = 32768;

const WORKTREE_SETUP_STAGES = ["make_tree", "project_steps", "warm_caches"] as const;
const WORKTREE_SETUP_STEP_STATES = ["pending", "running", "succeeded", "failed"] as const;
const WORKTREE_SETUP_CARD_STATES = ["running", "succeeded", "failed"] as const;

/** The stages of setting a tree up, in the order they run. */
export type WorktreeSetupStage = (typeof WORKTREE_SETUP_STAGES)[number];
/** Where one setup step stands. */
export type WorktreeSetupStepState = (typeof WORKTREE_SETUP_STEP_STATES)[number];

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
  state: (typeof WORKTREE_SETUP_CARD_STATES)[number];
  steps: WorktreeSetupStep[];
}
/** Wire schema for {@link WorktreeSetupStatus}. */
export const WorktreeSetupStatusSchema: z.ZodType<WorktreeSetupStatus> = z
  .object({
    worktreeId: WorktreeIdSchema,
    state: z.enum(WORKTREE_SETUP_CARD_STATES),
    steps: z.array(
      z
        .object({
          stage: z.enum(WORKTREE_SETUP_STAGES),
          label: wireFreeFormString(PROJECT_SETUP_COMMAND_MAX_LEN, "WorktreeSetupStep.label"),
          state: z.enum(WORKTREE_SETUP_STEP_STATES),
          elapsedMs: countSchema.optional(),
          error: wireFreeFormString(
            WORKSPACE_LAST_ERROR_MAX_LEN,
            "WorktreeSetupStep.error",
          ).optional(),
          output: wireFreeFormString(
            WORKTREE_SETUP_OUTPUT_MAX_LEN,
            "WorktreeSetupStep.output",
          ).optional(),
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

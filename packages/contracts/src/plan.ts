// The plan record and the one call that answers it.
//
// A plan turn ends with a held request on one provider and a plan item on the other; the daemon
// turns either into one plan record the screen renders (`plan.proposed`) and one call answers
// (`plan.resolve`), and records the outcome as `plan.accepted` or `plan.handed_off` so the system
// messages survive a reload. The first answer settles the plan everywhere; a later answer reads
// back the state it settled to rather than applying again.
//
// This file imports nothing from `event.ts`: that module imports the payload schemas below, and
// an import back would close an eager module cycle.
import { z } from "zod";

import { brandedUuidIdSchema } from "./internal/branded.js";
import type { MethodDescriptor } from "./method-descriptor.js";
import { defineMethodDescriptors } from "./method-descriptor.js";
import { ProviderNameSchema, type ProviderName } from "./provider-account.js";
import { RunIdSchema, type RunId } from "./provider-driver.js";
import { FILE_PATH_MAX_LEN, SessionIdSchema, type SessionId } from "./session.js";
import { ExecutionPostureModeSchema, type ExecutionPostureMode } from "./session-controls.js";

/** The daemon-minted id of one plan record, stable across a reload and every device. */
export type PlanId = string & { readonly __brand: "PlanId" };
/** Parses a {@link PlanId}. */
export const PlanIdSchema: z.ZodType<PlanId, PlanId> = brandedUuidIdSchema<PlanId>("PlanId");

/**
 * Where a plan stands: `waiting` while its card is up, `accepted` after it is
 * built here, `handed_off` after it is built in a fresh session, and `open` after
 * the person keeps planning, which answers the held request and leaves the plan
 * as a record the next plan replaces.
 */
export type PlanState = "waiting" | "accepted" | "handed_off" | "open";
/** Parses a {@link PlanState}. */
export const PlanStateSchema: z.ZodType<PlanState, PlanState> = z.enum([
  "waiting",
  "accepted",
  "handed_off",
  "open",
]);

/** Keep planning, build here, or build in a fresh session. */
export type PlanVerdict = "keep" | "build" | "fresh";
/** Parses a {@link PlanVerdict}. */
export const PlanVerdictSchema: z.ZodType<PlanVerdict, PlanVerdict> = z.enum([
  "keep",
  "build",
  "fresh",
]);

/**
 * `plan.proposed`: the record the screen renders. `title` is the plan's first
 * heading and `text` its Markdown as the agent wrote it, taken from the held
 * request or the plan item and never read off the disk. The two counts are the
 * daemon's own read of the plan: its top-level steps and the files it names.
 * `planFilePath` is present only where the provider wrote the plan as a file.
 */
export type PlanProposedPayload = {
  planId: PlanId;
  sessionId: SessionId;
  runId: RunId;
  title: string;
  text: string;
  stepCount: number;
  fileCount: number;
  planFilePath?: string | undefined;
};
/** Parses a {@link PlanProposedPayload}. */
export const PlanProposedPayloadSchema: z.ZodType<PlanProposedPayload> = z
  .object({
    planId: PlanIdSchema,
    sessionId: SessionIdSchema,
    runId: RunIdSchema,
    title: z.string(),
    text: z.string(),
    stepCount: z.number().int().nonnegative(),
    fileCount: z.number().int().nonnegative(),
    planFilePath: z.string().min(1).max(FILE_PATH_MAX_LEN).optional(),
  })
  .strict();

/** `plan.accepted`: the plan is being built in its own session. */
export type PlanAcceptedPayload = {
  planId: PlanId;
  sessionId: SessionId;
};
/** Parses a {@link PlanAcceptedPayload}. */
export const PlanAcceptedPayloadSchema: z.ZodType<PlanAcceptedPayload> = z
  .object({ planId: PlanIdSchema, sessionId: SessionIdSchema })
  .strict();

/** `plan.handed_off`: the plan seeded a fresh session, which the system message opens. */
export type PlanHandedOffPayload = {
  planId: PlanId;
  sessionId: SessionId;
  freshSessionId: SessionId;
};
/** Parses a {@link PlanHandedOffPayload}. */
export const PlanHandedOffPayloadSchema: z.ZodType<PlanHandedOffPayload> = z
  .object({ planId: PlanIdSchema, sessionId: SessionIdSchema, freshSessionId: SessionIdSchema })
  .strict();

/**
 * The session a `fresh` verdict mints: the provider it runs and the level it starts at, the
 * planning session's level or, where that provider cannot give it, one of that provider's levels
 * the person picks. The rest is the planning session's: the same project and worktree, the
 * provider's current account, and the plan as the seed.
 */
export interface PlanFreshSession {
  driverName: ProviderName;
  level: ExecutionPostureMode;
}

/** The verdict on one plan. `fresh` is present exactly on the `fresh` verdict. */
export interface PlanResolveRequest {
  planId: PlanId;
  verdict: PlanVerdict;
  fresh?: PlanFreshSession | undefined;
}
/** Parses a {@link PlanResolveRequest}; `fresh` must be present exactly on the `fresh` verdict. */
export const PlanResolveRequestSchema: z.ZodType<PlanResolveRequest, PlanResolveRequest> = z
  .object({
    planId: PlanIdSchema,
    verdict: PlanVerdictSchema,
    fresh: z
      .object({ driverName: ProviderNameSchema, level: ExecutionPostureModeSchema })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((request, context) => {
    if ((request.verdict === "fresh") !== (request.fresh !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["fresh"],
        message:
          request.verdict === "fresh"
            ? "a fresh verdict names the session to mint"
            : "only a fresh verdict names a session to mint",
      });
    }
  });

/**
 * The plan's state after the verdict, or the state an earlier verdict settled; never
 * `waiting`, which is the record's state only before its first verdict.
 * `freshSessionId` is present exactly when the plan was handed off, so the caller
 * switches to the minted session without another read.
 */
export interface PlanResolveResponse {
  planId: PlanId;
  state: Exclude<PlanState, "waiting">;
  freshSessionId?: SessionId | undefined;
}
/** Parses a {@link PlanResolveResponse}. */
export const PlanResolveResponseSchema: z.ZodType<PlanResolveResponse> = z
  .object({
    planId: PlanIdSchema,
    state: z.enum(["accepted", "handed_off", "open"]),
    freshSessionId: SessionIdSchema.optional(),
  })
  .strict()
  .superRefine((response, context) => {
    if ((response.state === "handed_off") !== (response.freshSessionId !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["freshSessionId"],
        message: "a handed-off plan names its fresh session, and no other plan does",
      });
    }
  });

/** The `plan.*` methods a client calls. */
export interface PlanMethodDescriptors {
  readonly "plan.resolve": MethodDescriptor<
    "plan.resolve",
    PlanResolveRequest,
    PlanResolveResponse
  >;
}

/** The `plan.*` descriptor table. */
export const PLAN_METHOD_DESCRIPTORS: PlanMethodDescriptors = defineMethodDescriptors({
  "plan.resolve": {
    method: "plan.resolve",
    procedureType: "mutation",
    mutating: true,
    requestSchema: PlanResolveRequestSchema,
    responseSchema: PlanResolveResponseSchema,
  },
});

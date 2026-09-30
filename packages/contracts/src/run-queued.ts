// The `run.queued` payload: a run's creation, and the one durable record of how it
// came to be. Kept apart from `run-control.ts` because it names the resolved agent as
// the live agent list does, and the event contract imports this file while nothing
// here imports that contract.
import { z } from "zod";

import { AgentIdSchema, type AgentId } from "./agent-definition.js";
import { AgentListEntrySchema, type AgentListEntry } from "./agent.js";
import { ProviderAccountIdSchema, type ProviderAccountId } from "./provider-account.js";
import { DRIVER_WIRE_HANDLE_MAX_LEN, RunIdSchema, type RunId } from "./provider-driver.js";
import { UsdMicrosSchema } from "./session-cost.js";
import { SessionIdSchema, wireFreeFormString, type SessionId } from "./session.js";

/**
 * How a child run was reached: a provider's own subagent, a run another agent asked
 * for through the bridge, or a workflow step. Internal data the agent index keeps;
 * the screen draws the tree and never this word.
 */
export type RunReachedBy = "provider_subagent" | "bridge_run" | "workflow_step";
const RunReachedBySchema: z.ZodType<RunReachedBy> = z.enum([
  "provider_subagent",
  "bridge_run",
  "workflow_step",
]);

/**
 * The limits admission resolved for a run: the request's own override, else the
 * session's default. Each exists only where the person set one. Kept on the creation
 * row so the token budget and the idle stop rebuild the same on replay, even when
 * the session's defaults change while the run is live.
 */
export interface EffectiveRunConfig {
  tokenLimit?: number | undefined;
  idleTimeoutMs?: number | undefined;
}
const EffectiveRunConfigSchema: z.ZodType<EffectiveRunConfig> = z
  .object({
    tokenLimit: z.number().int().positive().optional(),
    idleTimeoutMs: z.number().int().positive().optional(),
  })
  .strict();

/**
 * A run created and placed in the queue.
 *
 * The linkage members (`agentId`, `parentRunId`, `reachedBy`, `internalHelper`) and
 * `effectiveRunConfig` ride a run another run or a workflow created; the agent index
 * and the per-run limits rebuild from them. Where the request named a saved
 * definition rather than an agent already in the session, the daemon mints the agent
 * with the run and `resolvedAgent` is that agent as the live agent list names it,
 * with the configuration it was resolved from: this row is the record that brings it
 * into the session.
 *
 * The admission stamps ride every provider run, whichever path admitted it, and are
 * never supplied by a client: the unpriced cap on a native-cap admission, the model
 * family as of admission, and the account the run was admitted against.
 *
 * A type rather than an interface, so it meets the envelope's open payload record.
 */
export type RunQueuedPayload = {
  sessionId: SessionId;
  runId: RunId;
  runVersion: number;
  newState: "queued";
  agentId?: AgentId | undefined;
  parentRunId?: RunId | undefined;
  reachedBy?: RunReachedBy | undefined;
  internalHelper?: boolean | undefined;
  effectiveRunConfig?: EffectiveRunConfig | undefined;
  resolvedAgent?: AgentListEntry | undefined;
  admittedUnpricedCapUsdMicros?: number | undefined;
  admittedModelFamily?: string | undefined;
  admittedProviderAccountId?: ProviderAccountId | undefined;
};
export const RunQueuedPayloadSchema: z.ZodType<RunQueuedPayload> = z
  .object({
    sessionId: SessionIdSchema,
    runId: RunIdSchema,
    runVersion: z.number().int().nonnegative(),
    newState: z.literal("queued"),
    agentId: AgentIdSchema.optional(),
    parentRunId: RunIdSchema.optional(),
    reachedBy: RunReachedBySchema.optional(),
    internalHelper: z.boolean().optional(),
    effectiveRunConfig: EffectiveRunConfigSchema.optional(),
    resolvedAgent: AgentListEntrySchema.optional(),
    admittedUnpricedCapUsdMicros: UsdMicrosSchema.optional(),
    admittedModelFamily: wireFreeFormString(
      DRIVER_WIRE_HANDLE_MAX_LEN,
      "RunQueuedPayload.admittedModelFamily",
    ).optional(),
    admittedProviderAccountId: ProviderAccountIdSchema.optional(),
  })
  .strict()
  .refine(
    (payload) =>
      payload.resolvedAgent === undefined ||
      payload.resolvedAgent.resolvedConfiguration !== undefined,
    {
      path: ["resolvedAgent", "resolvedConfiguration"],
      message:
        "An agent resolved from a saved definition names the configuration it was resolved from.",
    },
  );

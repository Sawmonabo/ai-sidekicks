// The `run.queued` payload: a run's creation, and the one durable record of how it came to be.
// Kept apart from `run-control.ts` so the event contract can import it without a cycle.
import { z } from "zod";

import { AgentIdSchema, type AgentId } from "./agent-definition.js";
import { AgentListEntrySchema, type AgentListEntry } from "./agent.js";
import { ProviderAccountIdSchema, type ProviderAccountId } from "./provider-account.js";
import { DRIVER_WIRE_HANDLE_MAX_LEN } from "./provider-driver-wire.js";
import { RunIdSchema, type RunId } from "./provider-driver.js";
import { SessionIdSchema, wireFreeFormString, type SessionId } from "./session.js";

/**
 * How a child run was reached: a provider's own subagent, a run another agent asked for through
 * the bridge, or a workflow step. Internal to the agent index; the screen never shows it.
 */
export type ChildRunProvenance = "provider_subagent" | "bridge_run" | "workflow_step";
const ChildRunProvenanceSchema: z.ZodType<ChildRunProvenance> = z.enum([
  "provider_subagent",
  "bridge_run",
  "workflow_step",
]);

/**
 * The limits admission resolved for a run: the request's own override, else the session's
 * default, each present only where the person set one. Kept on the creation row so replay
 * rebuilds the same limits even if the session's defaults change while the run is live.
 */
export interface EffectiveRunConfig {
  tokenLimit?: number | undefined;
}
const EffectiveRunConfigSchema: z.ZodType<EffectiveRunConfig> = z
  .object({
    tokenLimit: z.number().int().positive().optional(),
  })
  .strict();

/**
 * A run created and placed in the queue. The linkage members (`agentId`, `parentRunId`,
 * `reachedBy`, `internalHelper`) and `effectiveRunConfig` ride a run that another run or a
 * workflow created; the agent index and per-run limits rebuild from them.
 *
 * `agentId` names an agent already in the session; `resolvedAgent` is one the daemon minted from
 * a saved definition with this run, with the configuration it was resolved from. A payload
 * carries one or the other, never both, and neither for the lead's run. The `admitted*` stamps
 * (model family, account) are set by the daemon, never a client. A type rather than an interface
 * so it meets the envelope's open payload record.
 */
export type RunQueuedPayload = {
  sessionId: SessionId;
  runId: RunId;
  runVersion: number;
  newState: "queued";
  agentId?: AgentId | undefined;
  parentRunId?: RunId | undefined;
  reachedBy?: ChildRunProvenance | undefined;
  internalHelper?: boolean | undefined;
  effectiveRunConfig?: EffectiveRunConfig | undefined;
  resolvedAgent?: AgentListEntry | undefined;
  admittedModelFamily?: string | undefined;
  admittedProviderAccountId?: ProviderAccountId | undefined;
};
/** Parses a {@link RunQueuedPayload}. */
export const RunQueuedPayloadSchema: z.ZodType<RunQueuedPayload> = z
  .object({
    sessionId: SessionIdSchema,
    runId: RunIdSchema,
    runVersion: z.number().int().nonnegative(),
    newState: z.literal("queued"),
    agentId: AgentIdSchema.optional(),
    parentRunId: RunIdSchema.optional(),
    reachedBy: ChildRunProvenanceSchema.optional(),
    internalHelper: z.boolean().optional(),
    effectiveRunConfig: EffectiveRunConfigSchema.optional(),
    resolvedAgent: AgentListEntrySchema.optional(),
    admittedModelFamily: wireFreeFormString(
      DRIVER_WIRE_HANDLE_MAX_LEN,
      "RunQueuedPayload.admittedModelFamily",
    ).optional(),
    admittedProviderAccountId: ProviderAccountIdSchema.optional(),
  })
  .strict()
  .refine((payload) => payload.agentId === undefined || payload.resolvedAgent === undefined, {
    path: ["resolvedAgent"],
    message:
      "A run names an agent already in the session or one resolved from a definition, never both.",
  })
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

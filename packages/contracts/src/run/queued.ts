// The `run.queued` payload: a run's creation, and the one durable record of how it came to be.
// Kept apart from `run/control.ts` so the event contract can import it without a cycle.
import { z } from "zod";

import { AgentIdSchema, type AgentId } from "../agent/definition.js";
import { AgentListEntrySchema, type AgentListEntry } from "../agent/methods.js";
import { ProviderAccountIdSchema, type ProviderAccountId } from "../provider/account/record.js";
import { DRIVER_WIRE_HANDLE_MAX_LEN } from "../provider/driver/methods.js";
import { RunIdSchema, type RunId } from "./id.js";
import { wireFreeFormString } from "../free-form-string.js";
import { OrchestrationRunConfigSchema, type OrchestrationRunConfig } from "../orchestration.js";
import { SessionIdSchema, type SessionId } from "../session/id.js";
import { countSchema } from "../internal/wire-scalars.js";

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
 * A run created and placed in the queue. It names its agent exactly once: `agentId` for an agent
 * already in the session, the lead's run naming the session's lead this way, or `resolvedAgent`
 * for one minted from a saved definition with this run. `effectiveRunConfig` holds the limits
 * admission resolved, the request's own else the session's default, so a rebuild restores them
 * even if the defaults change mid-run.
 */
export type RunQueuedPayload = {
  sessionId: SessionId;
  runId: RunId;
  runVersion: number;
  newState: "queued";
  agentId?: AgentId | undefined;
  parentRunId?: RunId | undefined;
  reachedBy?: ChildRunProvenance | undefined;
  effectiveRunConfig?: OrchestrationRunConfig | undefined;
  resolvedAgent?: AgentListEntry | undefined;
  admittedModelFamily?: string | undefined;
  admittedProviderAccountId?: ProviderAccountId | undefined;
};
/** Parses a {@link RunQueuedPayload}. */
export const RunQueuedPayloadSchema: z.ZodType<RunQueuedPayload> = z
  .object({
    sessionId: SessionIdSchema,
    runId: RunIdSchema,
    runVersion: countSchema,
    newState: z.literal("queued"),
    agentId: AgentIdSchema.optional(),
    parentRunId: RunIdSchema.optional(),
    reachedBy: ChildRunProvenanceSchema.optional(),
    effectiveRunConfig: OrchestrationRunConfigSchema.optional(),
    resolvedAgent: AgentListEntrySchema.optional(),
    admittedModelFamily: wireFreeFormString(
      DRIVER_WIRE_HANDLE_MAX_LEN,
      "RunQueuedPayload.admittedModelFamily",
    ).optional(),
    admittedProviderAccountId: ProviderAccountIdSchema.optional(),
  })
  .strict()
  .refine((payload) => (payload.agentId === undefined) !== (payload.resolvedAgent === undefined), {
    path: ["agentId"],
    message: "A run names exactly one agent: one in the session or one resolved from a definition.",
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

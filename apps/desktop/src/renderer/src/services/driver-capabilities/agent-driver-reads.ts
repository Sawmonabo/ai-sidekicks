// The two log reads that say which driver a run is bound to. `driver.listCapabilities` is
// addressed at the daemon and names no run, but the session's log does: `session.created` carries
// the lead, `run.queued` an agent started from a saved definition, and the run-lifecycle projector
// carries a run's `agentId` onto its body. Both are read through a schema because the payload and
// body are `unknown`, and a hand-shaped read would take a number or an empty string as a binding.

import { z } from "zod";
import { RunQueuedPayloadSchema } from "@ai-sidekicks/contracts/run/queued";
import { SessionCreatedPayloadSchema } from "@ai-sidekicks/contracts/session/created";
import type { AgentListEntry } from "@ai-sidekicks/contracts/agent/methods";
import type { ProviderName } from "@ai-sidekicks/contracts/provider/name";
import type { SessionEventType } from "@ai-sidekicks/contracts/event/registry";

import {
  type StoredEntity,
  type ProjectedSessionEvent,
} from "#renderer/store/session/entities/vocabulary.js";
import { RUN_QUEUED_EVENT_KIND } from "#renderer/store/session/events/run/state-kinds.js";

/**
 * The event kind of the session's birth, which brings the lead into the session; a run's creation
 * (`RUN_QUEUED_EVENT_KIND`) brings an agent started from a saved definition. Typed against the
 * taxonomy so a misspelling fails to compile.
 */
const SESSION_CREATED_EVENT_KIND: Extract<SessionEventType, "session.created"> = "session.created";

/** The one member of a run's body this read takes. */
const runAgentBindingSchema = z.object({ agentId: z.string().min(1) });

/**
 * Each agent's declared driver, from the rows that bring agents into the session. A payload naming
 * another session is ignored.
 */
export function readAgentDriverNames(
  transcript: readonly ProjectedSessionEvent[],
): ReadonlyMap<string, ProviderName> {
  const driverNameByAgentId = new Map<string, ProviderName>();
  for (const entry of transcript) {
    const agent = agentBroughtInBy(entry);
    if (agent !== undefined) {
      driverNameByAgentId.set(agent.agentId, agent.binding.driverName);
    }
  }
  return driverNameByAgentId;
}

/** The agent a run was created for, or `undefined` where its body names none. */
export function readRunAgentId(run: StoredEntity): string | undefined {
  const binding = runAgentBindingSchema.safeParse(run.body);
  return binding.success ? binding.data.agentId : undefined;
}

/** The agent this row brings into its own session, or `undefined` where it brings none. */
function agentBroughtInBy(entry: ProjectedSessionEvent): AgentListEntry | undefined {
  if (entry.kind === SESSION_CREATED_EVENT_KIND) {
    const parsed = SessionCreatedPayloadSchema.safeParse(entry.payload);
    return parsed.success && parsed.data.sessionId === entry.sessionId
      ? parsed.data.mainAgent
      : undefined;
  }
  if (entry.kind === RUN_QUEUED_EVENT_KIND) {
    const parsed = RunQueuedPayloadSchema.safeParse(entry.payload);
    return parsed.success && parsed.data.sessionId === entry.sessionId
      ? parsed.data.resolvedAgent
      : undefined;
  }
  return undefined;
}

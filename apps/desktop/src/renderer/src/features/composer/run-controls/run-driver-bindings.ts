// Which driver each run in one session is bound to: the session's runs joined to their
// agents' declared drivers. A run whose agent cannot be resolved contributes nothing rather
// than a default, so a gated control is taken off screen instead of guessed.

import type { ProviderName } from "@ai-sidekicks/contracts/provider/account/account";

import {
  readAgentDriverNames,
  readRunAgentId,
} from "@renderer/services/driver-capabilities/agent-driver-reads.js";
import {
  type StoredEntity,
  type ProjectedSessionEvent,
} from "@renderer/store/session/entities/entities.js";

/**
 * Joins the session's runs to their agents' declared drivers. A run this cannot resolve is
 * absent from the answer, the same fact as a read that has not landed.
 */
export function foldRunDriverBindings(
  runs: Readonly<Record<string, StoredEntity>>,
  transcript: readonly ProjectedSessionEvent[],
): ReadonlyMap<string, ProviderName> {
  const driverNameByAgentId = readAgentDriverNames(transcript);
  const driverNameByRunId = new Map<string, ProviderName>();
  for (const run of Object.values(runs)) {
    const agentId = readRunAgentId(run);
    const driverName = agentId === undefined ? undefined : driverNameByAgentId.get(agentId);
    if (driverName !== undefined) {
      driverNameByRunId.set(run.id, driverName);
    }
  }
  return driverNameByRunId;
}

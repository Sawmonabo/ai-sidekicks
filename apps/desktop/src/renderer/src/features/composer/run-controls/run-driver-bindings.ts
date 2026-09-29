// Which driver each run in one session is bound to: the session's runs joined to their
// agents' declared drivers.
//
// NEITHER HALF IS GUESSED. A run whose body names no agent, an agent no attach beat
// named, and an attach beat naming another session all contribute NOTHING rather than a
// default — the map's absence is `boundDriverNameForRun`'s "the console cannot say",
// which takes a gated control off screen rather than offering one the daemon would
// refuse or hiding one it would have honored.

import {
  readAgentDriverNames,
  readRunAgentId,
} from "@renderer/services/driver-capabilities/agent-driver-reads.js";
import {
  type StoredEntity,
  type ProjectedSessionEvent,
} from "@renderer/store/session/entities/entities.js";

/**
 * Join the session's runs to their agents' declared drivers.
 *
 * Pure and total: a run this cannot resolve is absent from the answer, which is the same
 * fact as a read that has not landed and is rendered the same way.
 */
export function foldRunDriverBindings(
  runs: Readonly<Record<string, StoredEntity>>,
  timeline: readonly ProjectedSessionEvent[],
): ReadonlyMap<string, string> {
  const driverNameByAgentId = readAgentDriverNames(timeline);
  const driverNameByRunId = new Map<string, string>();
  for (const run of Object.values(runs)) {
    const agentId = readRunAgentId(run);
    const driverName = agentId === undefined ? undefined : driverNameByAgentId.get(agentId);
    if (driverName !== undefined) {
      driverNameByRunId.set(run.id, driverName);
    }
  }
  return driverNameByRunId;
}

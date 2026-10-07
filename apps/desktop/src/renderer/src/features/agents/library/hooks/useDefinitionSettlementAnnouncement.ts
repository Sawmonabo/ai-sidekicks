import { useAnnounceWhenChanged } from "#renderer/hooks/announce/useAnnounceWhenChanged.js";
import { describeDefinitionSettlement, type AgentDefinitionReading } from "../definition-rows.js";

/**
 * Announce what a later settlement of this read changed: the first one stands. The repeat guard is
 * keyed on the sentence, so the shorter list a re-read lands on after a delete is still spoken.
 * `undefined` while the read is in flight leaves the last sentence standing.
 */
export function useDefinitionSettlementAnnouncement(reading: AgentDefinitionReading): void {
  useAnnounceWhenChanged(
    reading.kind === "not-loaded" ? undefined : describeDefinitionSettlement(reading),
    "polite",
    { isReadSettlement: true },
  );
}

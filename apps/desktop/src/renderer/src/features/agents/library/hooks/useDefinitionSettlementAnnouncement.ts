import { useSettlementAnnouncement } from "#renderer/hooks/announce/useSettlementAnnouncement.js";
import { describeDefinitionSettlement, type AgentDefinitionReading } from "../definition-rows.js";

/**
 * Announce what this read settled on. The repeat guard lives in the shared announcer, keyed on
 * the sentence, so the shorter list a re-read lands on after a delete is still spoken.
 * `undefined` while the read is in flight is that hook's "still reading" arm.
 */
export function useDefinitionSettlementAnnouncement(reading: AgentDefinitionReading): void {
  useSettlementAnnouncement(
    reading.kind === "not-loaded" ? undefined : describeDefinitionSettlement(reading),
  );
}

import { useSettlementAnnouncement } from "@renderer/hooks/useSettlementAnnouncement.js";
import { describeDefinitionSettlement, type AgentDefinitionReading } from "../definition-rows.js";

/**
 * Say what this read settled on, through the console's one settlement announcer.
 *
 * COMPOSES A SENTENCE AND GUARDS NOTHING. The repetition rule belongs to
 * `primitives/announce/settlement-announcement.ts` and is keyed on the SENTENCE, which is
 * the only key that is correct here: a flag held once for the life of the mount
 * silences everything after the first settlement, so the shorter list a re-read lands
 * on after a delete would never be spoken.
 *
 * `undefined` while the read is in flight, which is that hook's "still reading"
 * arm; `describeDefinitionSettlement` is narrowed to a settled reading and is
 * reached only past that check.
 */
export function useDefinitionSettlementAnnouncement(reading: AgentDefinitionReading): void {
  useSettlementAnnouncement(
    reading.kind === "not-loaded" ? undefined : describeDefinitionSettlement(reading),
  );
}

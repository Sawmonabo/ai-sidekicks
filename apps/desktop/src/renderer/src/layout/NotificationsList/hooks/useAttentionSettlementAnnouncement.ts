import { useSettlementAnnouncement } from "@renderer/hooks/useSettlementAnnouncement.js";
import type { AttentionReading } from "@renderer/store/attention/attention-summary.js";
import { describeAttentionSettlement } from "../attention-sentences.js";

/**
 * Say what this read settled on, through the console's one settlement announcer.
 *
 * COMPOSES A SENTENCE AND GUARDS NOTHING, the shape
 * `agents/definitions/definition-registry-view.ts` states: the repetition rule belongs to
 * `primitives/announce/settlement-announcement.ts` and is keyed on the SENTENCE, which is the
 * only key that is correct here. This read RE-READS — every session store that moves
 * pushes it — so a flag held once for the life of the mount would speak the first
 * settlement and silence every one after it, and the coverage gap that appears on the
 * third re-read would be visible only to people who can see the screen.
 *
 * Keyed on the sentence, a re-read that found the same thing says nothing and a
 * re-read that found something different says it. That places this module under the
 * hook's one obligation — the sentence must carry no figure that moves without the
 * reading moving — which is why it is composed from counts and the port's own words
 * and never from a clock.
 *
 * SEPARATE FROM {@link useAttentionProjection} rather than folded into it, for the
 * same reason that precedent keeps them apart: the read is performed by a destination
 * and the announcement is made by a surface, and a read hook that announced would
 * make every future caller of it — including one that renders nothing — speak.
 */
export function useAttentionSettlementAnnouncement(reading: AttentionReading): void {
  useSettlementAnnouncement(
    reading.phase === "reading" ? undefined : describeAttentionSettlement(reading),
  );
}

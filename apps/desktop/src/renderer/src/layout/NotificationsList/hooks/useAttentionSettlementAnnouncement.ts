import { useAnnounceWhenShown } from "#renderer/hooks/announce/useAnnounceWhenShown.js";
import type { AttentionReading } from "#renderer/store/attention/summary.js";
import { describeAttentionSettlement } from "../attention-sentences.js";

/**
 * Says what a later settlement of this read changed: the first one stands. The repetition rule is
 * keyed on the sentence, since the read re-reads whenever a session store moves: a re-read that
 * found the same thing is silent, a different one speaks. So the sentence carries no figure that
 * moves without the reading, and is composed from counts, never a clock.
 */
export function useAttentionSettlementAnnouncement(reading: AttentionReading): void {
  useAnnounceWhenShown(
    reading.phase === "reading" ? undefined : describeAttentionSettlement(reading),
    "polite",
    { isReadSettlement: true },
  );
}

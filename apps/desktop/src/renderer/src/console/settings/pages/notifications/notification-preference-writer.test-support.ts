// What both of this writer's test files need to drive it at all.
//
// Hoisted on second use rather than copied, per `apps/desktop/AGENTS.md`: the two
// files hold different harnesses on purpose — one settles one record's writes, the
// other settles two records' at once — but the user, the writer's construction,
// and the microtask drain are the same job in both, and a second copy of the drain in
// particular would let the two files disagree about how many passes a settled write
// needs without either one failing.
//
// THE STORE A CASE SUPPLIES IS WIDER THAN THE WRITER'S OWN PORT, and that is the seam
// this module names. The writer holds only the update; the set read that follows a
// served write belongs to `attention-preference-read.ts`, which decides whether the
// reply reaches the screen. A case still writes one stand-in store with both
// operations on it — the daemon it is standing in for has both — and this function
// splits it the way the production wiring does.

import type { ConsoleBridge } from "../../../bridge/index.js";
import { NotificationPreferenceWriter } from "./notification-preference-writer.js";
import type { AttentionPreferencePort } from "./notification-preference-writer.js";
import type { AttentionPreferenceReadOutcome } from "./attention-preference-model.js";

export const USER_ID = "user-ana";
export const UPDATED_AT = "2026-01-01T10:06:00.000Z";

/** What one whole-record write answers, so a harness settles the real shape. */
export type UpdateOutcome = Awaited<
  ReturnType<AttentionPreferencePort["attentionPreferenceUpdate"]>
>;

/** The stand-in daemon a case writes: the write the writer holds, and the set read. */
export type AttentionPreferenceStore = Pick<
  ConsoleBridge["growth"],
  "attentionPreferenceRead" | "attentionPreferenceUpdate"
>;

/**
 * The writer under test, over a store a case supplies.
 *
 * `onRecordsRead` stands in for the reading's publication: here it fires on every
 * re-read, because which of two overlapping replies may install is measured against
 * the reading itself in `attention-preference-read.test.ts` and is not this writer's
 * to decide.
 */
export function writerFor(
  store: AttentionPreferenceStore,
  onRecordsRead: (outcome: AttentionPreferenceReadOutcome) => void = () => undefined,
): NotificationPreferenceWriter {
  return new NotificationPreferenceWriter({
    port: store,
    userId: USER_ID,
    reReadSet: async () => {
      const outcome = await store.attentionPreferenceRead({ userId: USER_ID });
      onRecordsRead(outcome);
      return outcome;
    },
  });
}

/** Let a settled write and the re-read behind it run. */
export async function drain(): Promise<void> {
  for (let pass = 0; pass < 6; pass += 1) {
    await Promise.resolve();
  }
}

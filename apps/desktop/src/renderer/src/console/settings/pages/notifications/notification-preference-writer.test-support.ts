// What both of this writer's test files need to drive it at all.
//
// Hoisted on second use rather than copied, per `apps/desktop/AGENTS.md`: the two
// files hold different harnesses on purpose — one settles writes, the other settles
// writes AND whole-set reads — but the participant, the writer's construction, and
// the microtask drain are the same job in both, and a second copy of the drain in
// particular would let the two files disagree about how many passes a settled write
// needs without either one failing.

import { NotificationPreferenceWriter } from "./notification-preference-writer.js";
import type { AttentionPreferencePort } from "./notification-preference-writer.js";
import type { AttentionPreferenceReadOutcome } from "./attention-preference-model.js";

export const PARTICIPANT_ID = "participant-ana";
export const UPDATED_AT = "2026-01-01T10:06:00.000Z";

/** What one whole-record write answers, so a harness settles the real shape. */
export type UpdateOutcome = Awaited<
  ReturnType<AttentionPreferencePort["attentionPreferenceUpdate"]>
>;

/** The writer under test, over a port a case supplies. */
export function writerFor(
  port: AttentionPreferencePort,
  onRecordsRead: (outcome: AttentionPreferenceReadOutcome) => void = () => undefined,
): NotificationPreferenceWriter {
  return new NotificationPreferenceWriter({ port, participantId: PARTICIPANT_ID, onRecordsRead });
}

/** Let a settled write and the re-read behind it run. */
export async function drain(): Promise<void> {
  for (let pass = 0; pass < 6; pass += 1) {
    await Promise.resolve();
  }
}

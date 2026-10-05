// What the app says aloud about an attention read. A read is composed from clauses (what needs a
// person, sessions that never answered, members the boundary refused) so each fact is worded once
// and appears exactly when it is true.

import { formatCount } from "#renderer/lib/wire/figures.js";
import { partialReadNotices } from "#renderer/lib/partial-read.js";
import {
  answeredReadingStates,
  ATTENTION_SUBJECT,
  type AnsweredAttentionReading,
} from "#renderer/store/attention/attention-summary.js";

/**
 * One settled attention read, in one sentence for the polite lane, or `undefined` when
 * nothing waits and the read covered every session: that read says nothing, the way the
 * list draws nothing under its heading.
 */
export function describeAttentionSettlement(reading: AnsweredAttentionReading): string | undefined {
  const needsYou = needsYouClause(reading);
  if (needsYou === undefined) {
    return undefined;
  }
  const clauses = [needsYou];
  if (reading.refusedSessions.length > 0) {
    clauses.push(uncheckedSessionsSentence(reading.refusedSessions.length));
  }
  clauses.push(...incompletenessSentences(reading));
  return clauses.join(" ");
}

/** What the app says about sessions the fan-out never got an answer for. */
function uncheckedSessionsSentence(refusedCount: number): string {
  return refusedCount === 1
    ? "One session could not be checked."
    : `${formatCount(refusedCount)} sessions could not be checked.`;
}

/**
 * What the app says aloud about a read that was not the whole of it: the sentences from
 * `partialReadNotices`, each figure kept with its sentence.
 */
function incompletenessSentences(reading: AnsweredAttentionReading): readonly string[] {
  const sentences: string[] = [];
  for (const notice of partialReadNotices(answeredReadingStates(reading), ATTENTION_SUBJECT)) {
    // The `reading` shape says nothing aloud (`Nothing` speaks its own title); `none` was whole.
    if (notice.shape === "counted-sentence") {
      sentences.push(`${notice.figure} ${notice.copy}`);
    }
  }
  return sentences;
}

/**
 * The first clause: what the read found. Zero is worded from what else the read carried: with full
 * coverage and nothing dropped there is nothing to say, otherwise it speaks only for what it
 * covered.
 */
function needsYouClause(reading: AnsweredAttentionReading): string | undefined {
  const liveCount = reading.summary.liveItems.length;
  if (liveCount === 1) {
    return "One item needs you.";
  }
  if (liveCount > 0) {
    return `${formatCount(liveCount)} items need you.`;
  }
  const coversTheWholeRead = reading.refusedSessions.length === 0 && reading.droppedCount === 0;
  return coversTheWholeRead ? undefined : "Nothing was found in what this read covered.";
}

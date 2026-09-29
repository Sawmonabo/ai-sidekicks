// What the console says about an attention read — on screen and out loud, from one
// place so the two cannot drift.
//
// The notification center draws a coverage gap and a dropped-member count; the
// settlement announcement speaks the same read to someone who cannot see any of it. Written twice they would eventually disagree about one number, and the
// disagreement would be invisible to whichever half its author was looking at —
// which is the `agents/definitions/definition-rows.ts` precedent (`NO_SAVED_DEFINITIONS`, held as
// one constant "so the page and its announcement agree").
//
// WHY A READ IS COMPOSED FROM CLAUSES RATHER THAN SWITCHED. A read that
// answered carries three independent facts — what needs a person, which sessions
// never answered, and how many members the boundary refused — and any combination
// of them can occur. Switching over the combinations means eight branches that each
// have to be kept honest; joining up to three clauses means each fact is worded once
// and appears exactly when it is true.

import { formatCount } from "@renderer/lib/wire-figures.js";
import { partialReadNotices } from "@renderer/lib/partial-read.js";
import {
  answeredReadingStates,
  ATTENTION_SUBJECT,
  type AnsweredAttentionReading,
} from "@renderer/store/attention/attention-summary.js";

/** What the console says about sessions the fan-out never got an answer for. */
export function uncheckedSessionsSentence(refusedCount: number): string {
  return refusedCount === 1
    ? "One session could not be checked."
    : `${formatCount(refusedCount)} sessions could not be checked.`;
}

/**
 * One settled attention read, in one sentence for the polite lane, or `undefined` when
 * nothing waits and the read covered every session: that read says nothing, the way the
 * panel draws nothing under its heading.
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

/**
 * What the console says aloud about a read that was not the whole of it.
 *
 * The SENTENCES the panel is already showing, read off `partialReadNotices` rather
 * than composed again here: a second wording of one number is a disagreement nobody
 * can see from either half. The figure travels with its sentence because "3"
 * and "deliveries could not be read" spoken apart are two fragments.
 */
function incompletenessSentences(reading: AnsweredAttentionReading): readonly string[] {
  const sentences: string[] = [];
  for (const notice of partialReadNotices(answeredReadingStates(reading), ATTENTION_SUBJECT)) {
    if (notice.shape === "counted-sentence") {
      sentences.push(`${notice.figure} ${notice.copy}`);
      continue;
    }
    if (notice.shape === "sentence") {
      sentences.push(notice.copy);
    }
    // The `reading` shape says nothing aloud — the `not-loaded` absence speaks
    // its own title through `Nothing` — and `none` is a reading that was whole.
  }
  return sentences;
}

/**
 * The first clause: what the read found.
 *
 * Zero is worded from what else the read carried, because "nothing" means different
 * things depending on it. With full coverage and nothing dropped there is nothing to
 * say. With either of those missing the zero case narrows itself to the part of the
 * read it can actually speak for.
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

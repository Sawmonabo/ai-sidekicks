// What the console says about an attention read — on screen and out loud, from one
// place so the two cannot drift.
//
// The notification center draws an absence, a coverage gap, and a dropped-member
// count; the settlement announcement speaks the same read to someone who cannot see
// any of it. Written twice they would eventually disagree about one number, and the
// disagreement would be invisible to whichever half its author was looking at —
// which is the `agents/definition-rows.ts` precedent (`NO_SAVED_SIDEKICKS`, held as
// one constant "so the page and its announcement agree").
//
// WHAT THE SPOKEN FORM LEAVES OUT, and why. A refusal is spoken as the port's own
// sentence with its CODE omitted, exactly as `describeDefinitionSettlement` states
// it: read aloud a code is a token nobody can act on, ahead of the sentence that
// matters. The code stays on screen, where it can be copied.
//
// WHY THE `read` ARM IS COMPOSED FROM CLAUSES RATHER THAN SWITCHED. A read that
// answered carries three independent facts — what needs a person, which sessions
// never answered, and how many members the boundary refused — and any combination
// of them can occur. Switching over the combinations means eight branches that each
// have to be kept honest; joining up to three clauses means each fact is worded once
// and appears exactly when it is true.

import { formatCount, partialReadNotices } from "../../primitives/index.js";
import {
  answeredReadingStates,
  ATTENTION_SUBJECT,
  type AnsweredAttentionReading,
  type AttentionReading,
} from "./attention-plane.js";

/**
 * A reading that has settled.
 *
 * Narrowed rather than guarded inside {@link describeAttentionSettlement}: a caller
 * that tried to speak before the read lands is then a compile error rather than a
 * sentence about a settlement that has not happened.
 */
export type SettledAttentionReading = Exclude<AttentionReading, { readonly phase: "reading" }>;

/** The all-clear, so the panel and its announcement say one thing. */
export const NOTHING_NEEDS_YOU = "Nothing needs you.";

/** What the console says about sessions the fan-out never got an answer for. */
export function uncheckedSessionsSentence(refusedCount: number): string {
  return refusedCount === 1
    ? "One session could not be checked."
    : `${formatCount(refusedCount)} sessions could not be checked.`;
}

/**
 * What the console says aloud about a read that was not the whole of it.
 *
 * The SENTENCES the panel is already showing, read off `primitives/partial-read.ts`
 * rather than composed again here — which is the whole point of that module: this
 * family wrote its own copy, and a second wording of one number is a disagreement
 * nobody can see from either half. The figure travels with its sentence because "3"
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
    // The `reading` shape says nothing aloud — rule 8's `not-loaded` absence speaks
    // its own title through `Nothing` — and `none` is a reading that was whole.
  }
  return sentences;
}

/**
 * One settled attention read, in one sentence for the polite lane.
 *
 * The `not-asked` arm speaks, and that is deliberate: it is a settled state rather
 * than a read in flight — the installed bridge reaches it and stays there — so
 * leaving it silent would put a person who cannot see the panel in front of the one
 * conflation this whole surface is built to prevent, hearing nothing and having no
 * way to tell "you are free" from "nobody asked".
 */
export function describeAttentionSettlement(reading: SettledAttentionReading): string {
  if (reading.phase === "not-asked") {
    return "The attention projection has not been read, so this is not an all-clear.";
  }
  if (reading.phase === "refused") {
    return reading.refusal.detail;
  }
  const clauses = [needsYouClause(reading)];
  if (reading.refusedSessions.length > 0) {
    clauses.push(uncheckedSessionsSentence(reading.refusedSessions.length));
  }
  clauses.push(...incompletenessSentences(reading));
  return clauses.join(" ");
}

/**
 * The first clause: what the read found.
 *
 * Zero is worded from what else the read carried, because "nothing" means different
 * things depending on it. With full coverage and nothing dropped it is the all-clear.
 * With either of those missing it is NOT an all-clear, and a clause that said so
 * would be contradicted by the very next clause — so the zero case narrows itself to
 * the part of the read it can actually speak for.
 */
function needsYouClause(reading: AnsweredAttentionReading): string {
  const liveCount = reading.plane.liveItems.length;
  if (liveCount === 1) {
    return "One item needs you.";
  }
  if (liveCount > 0) {
    return `${formatCount(liveCount)} items need you.`;
  }
  const coversTheWholeRead = reading.refusedSessions.length === 0 && reading.droppedCount === 0;
  return coversTheWholeRead ? NOTHING_NEEDS_YOU : "Nothing was found in what this read covered.";
}

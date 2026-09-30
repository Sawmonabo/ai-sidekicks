// An agent's question, read off a `question.asked` row's open payload with the typed readers of
// `wire-payload.ts`; an absent or wrongly-typed member reads as `undefined`.
//
// The payload is the plain half of the question record: which question, the run holding it,
// and its page count. The questions themselves are sealed apart from it, so the card takes
// their text and options as a prop. A question has no deadline on either provider and no
// terminal event: the answer lands as the person's own turn and the card closes when the
// question's attention entry resolves.

import { readWireString } from "@renderer/lib/wire-strings.js";
import { type Refusal } from "@renderer/lib/refusal.js";
import type { RunId, TimelineRow } from "@ai-sidekicks/contracts";
import { projectedPayload, readWireCount } from "./wire-payload.js";

/** One question record, as much of it as the row's payload carries. */
export interface QuestionReading {
  /** The daemon-minted id the answer names. */
  readonly questionId: string;
  /** The run the question blocks, off the row's own arm; `undefined` on a non-run row. */
  readonly runId: RunId | undefined;
  /** How many questions the record carries, one page each. */
  readonly pageCount: number;
}

/**
 * Where the answer this card last dispatched has got to. A fact about the console, not the
 * question: `accepted` means the daemon took the answer. A refused call (transport down,
 * request rejected, reply outside the registered schema) is held so the person is told the
 * run is still blocked.
 */
export type AnswerDelivery =
  | { readonly status: "unsent" }
  | { readonly status: "delivering" }
  | { readonly status: "accepted" }
  | { readonly status: "refused"; readonly refusal: Refusal };

/** Nothing dispatched: the state every question starts in. */
export const UNSENT_ANSWER_DELIVERY: AnswerDelivery = Object.freeze({ status: "unsent" });

/**
 * Read one row as a question, or `undefined` for a row of another type or one missing its id
 * or page count.
 */
export function readQuestion(row: TimelineRow): QuestionReading | undefined {
  if (row.type !== "question.asked") {
    return undefined;
  }
  const payload = projectedPayload(row);
  const questionId = readWireString(payload["questionId"]);
  const pageCount = readWireCount(payload, "pageCount");
  if (questionId === undefined || pageCount === undefined) {
    return undefined;
  }
  // Only the `run` arm carries an attribution, so narrow on `kind` rather than the payload.
  return { questionId, runId: row.kind === "run" ? row.runId : undefined, pageCount };
}

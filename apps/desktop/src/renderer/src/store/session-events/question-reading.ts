// An agent's question, read off a `question.asked` row's open payload.
//
// WHY THIS IS A READER AND NOT A PARSE. A timeline row carries the question as the open
// `Record<string, unknown>` every projected row carries, and `wire-payload.ts` states
// the discipline for that case: typed readers over an open record, an absent or
// wrongly-typed member reading as `undefined`. This module is that discipline applied
// to the question's own members.
//
// WHAT THE ROW CARRIES. The payload is the plain half of the question record: which
// question it is, the run that holds it, and how many pages it has. The questions
// themselves are the record's personal-data half, sealed apart from the payload, so
// nothing here reads a question's text or its options; the card takes those as a prop.
//
// NO TIMER AND NO LOCAL SETTLEMENT. A question is held open until it is answered, with
// no deadline on either provider, and it has no terminal event of its own: the person's
// answer lands as their own turn, and the card closes when the question's attention
// entry resolves.

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
 * Where the answer this card last dispatched has got to.
 *
 * A fact about the console and never about the question: `accepted` means the daemon
 * took the answer, and nothing here renders the question as settled.
 *
 * WHY THE REPLY IS HELD AT ALL. A refused call — a transport that was down, a daemon
 * that rejected the request, a reply the registered schema does not admit — must not
 * be discarded: the run stays blocked on a question nobody has answered, and the
 * person has to be told.
 */
export type AnswerDelivery =
  | { readonly status: "unsent" }
  | { readonly status: "delivering" }
  | { readonly status: "accepted" }
  | { readonly status: "refused"; readonly refusal: Refusal };

/** Nothing dispatched. The state every question starts in, as one frozen value. */
export const UNSENT_ANSWER_DELIVERY: AnswerDelivery = Object.freeze({ status: "unsent" });

/**
 * Read one row as a question, or answer that it is not one.
 *
 * `undefined` for a row of another type and for a question row missing its id or its
 * page count: neither is a question the card could answer.
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
  // The `run` arm is the only one carrying an attribution, so this narrows on `kind`
  // rather than guessing a run out of a payload member.
  return { questionId, runId: row.kind === "run" ? row.runId : undefined, pageCount };
}

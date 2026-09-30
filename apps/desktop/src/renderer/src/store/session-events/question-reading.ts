// The input ask, read off a row's open payload — and what the card may not decide.
//
// WHY THIS IS A READER AND NOT A PARSE. The `driver_ask.*` types are registered
// in the event taxonomy and NO payload variant is registered for them, so a timeline
// row carries the ask as the open `Record<string, unknown>` every projected row
// carries. `wire-payload.ts` states the discipline for exactly this case: two typed
// readers over an open record, an absent or wrongly-typed member reading as
// `undefined`, and the card rendering the named absence rather than a coerced
// value. This module is that discipline applied to the ask's own members.
//
// THE THREE THINGS THE CARD MUST NEVER DO, and this module is where two of them are
// made structurally impossible:
//
//   • Never settle a terminal locally. The state is read from the row's own event
//     TYPE, wire-verbatim, and there is no code path here that computes one. A
//     countdown that reaches zero changes nothing about the state — the card waits
//     for a row the daemon writes, because a card that decided the ask had timed out
//     would show a close that never happened.
//   • Never synthesize `options`. The member is additive-optional and its absence
//     means the provider offered no choice set the driver could represent. The
//     reader below drops a malformed entry rather than repairing it, and a set that
//     reads as nothing is a set that renders as nothing.
//   • Never render a permission-kind ask here. Permission asks ride the approval
//     flow; the reader's `kind` test is a positive test on the `input` literal
//     rather than "not permission", so an ask whose kind this build does not know is
//     excluded rather than admitted by default.
//
// THE EXPIRY IS A DISPLAY OF A STAMP AND NEVER A SECOND CLOCK. `expiresAt` is read
// verbatim and handed to the caller; nothing here compares it to a time. The card
// renders the remaining interval from the console's own clock and says "waiting for
// the daemon" once it reaches zero, which is a statement about what the card is
// doing rather than about what the ask has become.

import { readWireString } from "@renderer/lib/wire-strings.js";
import { type Refusal } from "@renderer/lib/refusal.js";
import type { RunId, TimelineRow } from "@ai-sidekicks/contracts";
import { projectedPayload } from "./wire-payload.js";

/** The event types this card renders, and the only ones it renders. */
export const QUESTION_EVENT_TYPES = [
  "driver_ask.requested",
  "driver_ask.responded",
  "driver_ask.canceled",
] as const;

/** One ask state. Derived from the event types, never restated as a second union. */
export type QuestionState = "requested" | "responded" | "canceled";

/**
 * The state each event type names. Total over the types by construction, so a type
 * added to the tuple above fails to compile here rather than reaching a card that
 * renders it as a pending ask.
 */
const STATE_BY_EVENT_TYPE: Readonly<Record<(typeof QUESTION_EVENT_TYPES)[number], QuestionState>> =
  {
    "driver_ask.requested": "requested",
    "driver_ask.responded": "responded",
    "driver_ask.canceled": "canceled",
  };

/** One offered answer, as the provider declared it. */
export interface QuestionOption {
  readonly value: string;
  /** The provider's own label, where it supplied one. Never composed from `value`. */
  readonly label: string | undefined;
}

/** One input ask, as much of it as the row's payload actually carries. */
export interface QuestionReading {
  readonly askId: string;
  /**
   * The run this ask blocks, off the row's own arm — `undefined` on a row attributing
   * none.
   *
   * CARRIED BECAUSE `askId` ALONE IS NOT AN IDENTITY. The id is the provider's, minted
   * per provider session, so two runs answering in parallel legitimately raise asks
   * under one id; the registered answer request addresses a run AND a request for the
   * same reason. It is read off the row rather than off the payload because the row is
   * where the projection attributes a run, and the ask row and the answer this card
   * dispatches then name the same one by construction.
   */
  readonly runId: RunId | undefined;
  readonly state: QuestionState;
  /** The provider's question. `undefined` where the ask carried none. */
  readonly prompt: string | undefined;
  /** The declared choice set, or empty where the ask offered none. Never synthesized. */
  readonly options: readonly QuestionOption[];
  /** The daemon's stamped deadline, verbatim. `undefined` on a pre-stamp row. */
  readonly expiresAt: string | undefined;
  /** The delivered answer, rendered verbatim on the `responded` row alone. */
  readonly deliveredAnswer: string | undefined;
}

/**
 * Where the answer this card last dispatched has got to.
 *
 * A DIFFERENT FACT FROM `QuestionState`, AND THE CARD MAY NEVER CONFUSE THE TWO. That
 * state is read from the row's own event type and says what the DAEMON has recorded;
 * this says what the console did with a press and what came back off the wire. So
 * `accepted` means the answer reached the driver and the card is waiting for the
 * `driver_ask.responded` row — the same sentence the countdown says past zero, about
 * the console rather than about the ask — and nothing here ever renders a terminal.
 *
 * WHY THE REPLY IS HELD AT ALL, which is the defect this shape answers. The dispatch
 * used to be fire-and-forget: a refused call — a transport that was down, a daemon
 * that rejected the request, a reply the registered schema does not admit — was
 * discarded, the free-text arm cleared its draft the instant it dispatched, and an
 * option press changed nothing on screen. The run stayed blocked on an ask nobody had
 * answered and the user was told none of it.
 *
 * THE RESPONSE TRAVELS ON EVERY ARM PAST `unsent` because two arms need it: `refused`
 * is what a retry re-sends and what keeps a draft that was never delivered, and
 * `delivering` is what a second press is refused against.
 */
export type AnswerDelivery =
  | { readonly status: "unsent" }
  | { readonly status: "delivering"; readonly response: string }
  | { readonly status: "accepted"; readonly response: string }
  | {
      readonly status: "refused";
      readonly response: string;
      readonly refusal: Refusal;
    };

/** What a terminal settles a question as: the members a terminal is authoritative about. */
export type QuestionSettlement = Pick<QuestionReading, "state" | "deliveredAnswer">;

/** Nothing dispatched. The state every ask starts in, as one frozen value. */
export const UNSENT_ANSWER_DELIVERY: AnswerDelivery = Object.freeze({ status: "unsent" });

/**
 * Read one row as an input ask, or answer that it is not one.
 *
 * `undefined` covers three distinct rejections and deliberately renders as the same
 * "this is not an ask row" for the caller: a row of another type, a permission-kind
 * ask, and an ask row carrying no usable `askId`. None of the three is a row the
 * transcript's ask card may draw, and a caller that wanted to tell them apart would be
 * asking this reader to classify rows it does not own.
 */
export function readQuestion(row: TimelineRow): QuestionReading | undefined {
  const question = readQuestionPayload(row.type, projectedPayload(row));
  // The `run` arm is the only one carrying an attribution, and the `general` arm is the
  // non-run arm by construction — so this narrows on `kind` rather than guessing a run
  // out of a payload member.
  return question === undefined
    ? undefined
    : { ...question, runId: row.kind === "run" ? row.runId : undefined };
}

/**
 * Read one event type and its payload as an input ask, before any run is attributed.
 *
 * The part of {@link readQuestion} a session event can answer as well as a row, so the
 * store's settlement fold and the card read an ask by one rule.
 */
export function readQuestionPayload(
  eventType: string,
  payload: Readonly<Record<string, unknown>>,
): Omit<QuestionReading, "runId"> | undefined {
  const state = STATE_BY_EVENT_TYPE[eventType as (typeof QUESTION_EVENT_TYPES)[number]];
  if (state === undefined) {
    return undefined;
  }
  if (readWireString(payload["kind"]) !== "input") {
    return undefined;
  }
  const askId = readWireString(payload["askId"]);
  if (askId === undefined) {
    return undefined;
  }
  return {
    askId,
    state,
    prompt: readWireString(payload["prompt"]),
    options: readAskOptions(payload["options"]),
    expiresAt: readWireString(payload["expiresAt"]),
    // Only on the `responded` row, which is where the contract puts it. Reading it
    // on any other state would render a delivered answer for an ask that has none.
    deliveredAnswer: state === "responded" ? readWireString(payload["response"]) : undefined,
  };
}

/**
 * One ask as its own row read it, settled by the terminal the store later holds.
 *
 * THE QUESTION STAYS THE REQUEST'S AND THE DISPOSITION COMES FROM THE TERMINAL. Only
 * `state` and `deliveredAnswer` are taken from the terminal, because those are the
 * only two members a terminal is authoritative about: a `driver_ask.canceled` payload
 * carries no prompt and no option set, so taking the whole reading would blank the
 * question a reader is looking at and replace it with the card's named absence.
 *
 * A reading that is already terminal is returned UNCHANGED rather than merged with
 * itself — the terminal row draws its own disposition, which is what it always did.
 */
export function applyQuestionSettlement(
  ask: QuestionReading,
  terminal: QuestionSettlement | undefined,
): QuestionReading {
  if (terminal === undefined || ask.state !== "requested") {
    return ask;
  }
  return { ...ask, state: terminal.state, deliveredAnswer: terminal.deliveredAnswer };
}

/**
 * The declared choice set, with anything unreadable dropped.
 *
 * DROPPED AND NOT REPAIRED. An entry whose `value` is not a present wire string names
 * no answer this card could send, so offering it would put a control on screen that
 * cannot be pressed correctly. An entry with a `value` and no `label` is kept and
 * renders by its value — the label is the provider's and the console composes none.
 */
function readAskOptions(value: unknown): readonly QuestionOption[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const options: QuestionOption[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const record = entry as Readonly<Record<string, unknown>>;
    const optionValue = readWireString(record["value"]);
    if (optionValue !== undefined) {
      options.push({ value: optionValue, label: readWireString(record["label"]) });
    }
  }
  return options;
}

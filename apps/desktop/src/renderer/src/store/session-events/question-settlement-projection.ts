// What each question to a person settled as, folded over every session event the store
// admits.
//
// A question and its answer are separate events: the request stays where it was asked,
// and the answer or the cancellation arrives later as an event of its own.
// The card reads the request, so it needs this fold to learn the question is settled,
// including when the answer came from another window or device.
//
// FIRST TERMINAL WINS. A question settles once; a second terminal for one question is a
// duplicate delivery or a log that contradicts itself, and in both readings the first
// one settled it. A projector cannot read the stored entity, so each terminal is written
// under a body member of its own kind with its sequence, the store's one-level body merge
// keeps them side by side, and the read takes the earliest. A late cancellation therefore
// cannot overwrite an answer a person gave.
//
// THE KEY IS THE RUN'S AS WELL AS THE QUESTION'S. A provider mints its ask ids per
// provider session, so two runs blocked at once raise `ask-1` each; keyed on that id
// alone, one run's answer would settle the other's card. A terminal naming no run
// settles nothing: an ask nothing attributes cannot be answered, so filing it would let
// an unanswerable question settle an answerable one.

import { readWireString } from "@renderer/lib/wire-strings.js";
import { structuralKey } from "@renderer/lib/structural-key.js";
import type {
  StoredEntity,
  ProjectedSessionEvent,
  EntityMutation,
  EntityProjectorTable,
} from "../session/entities/entities.js";
import { driverAskIdentitySegments } from "../session/waiting-on-person/driver-ask-identity.js";
import {
  QUESTION_EVENT_TYPES,
  readQuestionPayload,
  type QuestionReading,
  type QuestionState,
  type QuestionSettlement,
} from "./question-reading.js";

/** A state a question ends in. */
type SettledQuestionState = Exclude<QuestionState, "requested">;

/** One terminal as the entity body holds it, under the member named for its state. */
interface SettledQuestionRecord {
  readonly sequence: number;
  readonly deliveredAnswer?: string;
}

/** The two states a terminal names, in the order the body members are read. */
const SETTLED_QUESTION_STATES: readonly SettledQuestionState[] = ["responded", "canceled"];

/**
 * The fold's projector table: the two terminal kinds, each folded the same way.
 *
 * The request kind is not claimed, so an open question reaches no entity.
 */
export const QUESTION_SETTLEMENT_PROJECTORS: EntityProjectorTable = Object.fromEntries(
  QUESTION_EVENT_TYPES.filter((eventType) => eventType !== "driver_ask.requested").map(
    (eventType) => [eventType, projectQuestionSettlement],
  ),
);

/**
 * The owner the question-settlement kinds are registered under, so a conflicting claim
 * names the folder that projects them. The composition registers
 * {@link QUESTION_SETTLEMENT_PROJECTORS} under it.
 */
export const QUESTION_SETTLEMENT_PROJECTOR_OWNER = "session-events";

/**
 * What the store holds that settled this question, or `undefined` while it is open.
 *
 * Takes the question rather than an id, because the key is the run's as well as the
 * ask's and this module is the one place it is composed.
 */
export function findQuestionSettlement(
  questions: Readonly<Record<string, StoredEntity>>,
  ask: QuestionReading,
): QuestionSettlement | undefined {
  const key = questionKeyOf(ask.runId, ask.askId);
  const body = key === undefined ? undefined : questions[key]?.body;
  if (body === undefined) {
    return undefined;
  }
  let earliest: (QuestionSettlement & { readonly sequence: number }) | undefined;
  for (const state of SETTLED_QUESTION_STATES) {
    const record = body[state] as SettledQuestionRecord | undefined;
    if (record !== undefined && (earliest === undefined || record.sequence < earliest.sequence)) {
      earliest = { state, deliveredAnswer: record.deliveredAnswer, sequence: record.sequence };
    }
  }
  return earliest === undefined
    ? undefined
    : { state: earliest.state, deliveredAnswer: earliest.deliveredAnswer };
}

/** Fold one terminal into the question it settles. Pure: it reads the event alone. */
function projectQuestionSettlement(event: ProjectedSessionEvent): readonly EntityMutation[] {
  const payload = event.payload ?? {};
  const question = readQuestionPayload(event.kind, payload);
  const key =
    question === undefined
      ? undefined
      : questionKeyOf(readWireString(payload["runId"]), question.askId);
  if (question === undefined || key === undefined) {
    return [];
  }
  const record: SettledQuestionRecord = {
    sequence: event.sequence,
    ...(question.deliveredAnswer === undefined
      ? {}
      : { deliveredAnswer: question.deliveredAnswer }),
  };
  return [
    {
      operation: "upsert",
      entity: {
        kind: "question",
        id: key,
        touchedAt: event.occurredAt,
        body: { [question.state]: record },
      },
    },
  ];
}

/**
 * The key one question is filed under: its run and its ask id, through the console's one
 * tuple-to-key encoder, or `undefined` where the question names no run.
 */
function questionKeyOf(runId: string | undefined, askId: string): string | undefined {
  const segments = driverAskIdentitySegments(runId, askId);
  return segments === undefined ? undefined : structuralKey(segments);
}

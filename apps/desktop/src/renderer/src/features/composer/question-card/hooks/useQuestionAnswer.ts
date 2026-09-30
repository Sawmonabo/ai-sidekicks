// The answer a question card delivers, and where that delivery has got to.
//
// ONE CALL ANSWERS THE QUESTION. `question.resolve` takes every answer at once, one per
// question in the record's own order, and the daemon refuses a list that does not
// answer every question. The call is taken as an argument until the daemon serves it,
// so this module constructs no wire of its own.
//
// AND IT IS NOT FIRE-AND-FORGET. The call answers `served` or `refused` for every
// outcome a transport can have, so a caller that ignored the reply would have decided
// that a refusal looks exactly like a success — an answer that never reached the daemon
// left the run blocked with nothing on screen saying so. This hook holds what came back,
// and the question card renders it.

import { useCallback, useState } from "react";

import type { DaemonReply } from "@renderer/services/daemon/daemon-reply.js";
import { heldIdAsWireId } from "@renderer/services/daemon/wire-ids.js";
import type {
  QuestionAnswer,
  QuestionResolveRequest,
  QuestionResolveResponse,
} from "@ai-sidekicks/contracts";
import {
  UNSENT_ANSWER_DELIVERY,
  type AnswerDelivery,
} from "@renderer/store/session-events/question-reading.js";

/** The `question.resolve` call, supplied by the mount until the daemon serves it. */
export type ResolveQuestionCall = (
  request: QuestionResolveRequest,
) => Promise<DaemonReply<QuestionResolveResponse>>;

/** Where one question's answer has got to, and the call that dispatches one. */
export interface QuestionAnswerHandle {
  readonly delivery: AnswerDelivery;
  /** Deliver one answer per question, or do nothing while one is out or already taken. */
  readonly answer: (answers: QuestionAnswer[]) => void;
}

/**
 * Deliver a question record's answers, and hold what the reply said about them.
 *
 * SINGLE-FLIGHT, AND NO SECOND ANSWER AFTER ONE LANDED. A press while a call is in flight
 * is answered with the state already on screen; a press after the daemon took an answer
 * is refused too, because the question is answered and a second delivery would be a
 * second answer to a question that has one. A REFUSED answer is the case both of those
 * exist to leave open — nothing reached the daemon, so pressing again dispatches again.
 */
export function useQuestionAnswer(
  questionId: string,
  resolveQuestion: ResolveQuestionCall,
): QuestionAnswerHandle {
  const [delivery, setDelivery] = useState<AnswerDelivery>(UNSENT_ANSWER_DELIVERY);
  const answer = useCallback(
    (answers: QuestionAnswer[]) => {
      if (delivery.status === "delivering" || delivery.status === "accepted") {
        return;
      }
      setDelivery({ status: "delivering" });
      // NO `catch` ARM: the call answers `served` or `refused` for every outcome a
      // transport can have, so a `catch` here would be a branch nothing can reach.
      void resolveQuestion({
        questionId: heldIdAsWireId(questionId),
        answers,
      }).then((reply) => {
        setDelivery(
          reply.status === "served"
            ? { status: "accepted" }
            : { status: "refused", refusal: reply.refusal },
        );
      });
    },
    [delivery.status, questionId, resolveQuestion],
  );

  return { delivery, answer };
}

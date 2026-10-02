// The answer a question card delivers, and where that delivery has got to.
//
// `question.resolve` takes every answer at once, one per question in the record's order, and
// the daemon refuses a list that leaves one out. The call is passed in, and its reply is held
// because ignoring it would show a refused answer as a success and leave the run blocked.

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

/** The `question.resolve` call, supplied by the mount. */
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
 * Delivers a question record's answers and holds what the reply said. Single-flight: a press
 * while a call is out, or after the daemon took an answer, does nothing; a refusal leaves
 * the press live, since nothing reached the daemon.
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
      // No `catch`: the call answers `served` or `refused` for every transport outcome.
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

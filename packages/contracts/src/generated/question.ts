// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// A question record and the one call that answers it.

import type { SchemaCheck } from "../schema-check.js";
import {
  validateQuestionResolveRequest,
  validateQuestionResolveResponse,
} from "./checks/question.js";
import type { RunId } from "./run/id.js";
import type { SessionId } from "./session/id.js";

/**
 * The daemon-minted id of one question record.
 */
export type QuestionId = string & { readonly __brand: "QuestionId" };
/**
 * The answer a form field starts from, as the form declared it: the label of the option it
 * preselects (several labels on a field of several picks), or a typed field's value in its own
 * type.
 */
export type QuestionDefault = string | number | boolean | string[];
/**
 * Where a run's question record stands when it is written: open, answerable at once; or waiting
 * for its run, asked while the run was not running, which the card shows greyed under the line
 * `Waiting for the run` until `question.opened` makes it answerable, in the order its run's
 * questions came.
 */
export type QuestionAskedState = "open" | "waitingForRun";
/**
 * The `question.asked` payload: exactly one of `runId` and `waitId` names what is waiting.
 */
export type QuestionAskedPayload =
  | {
      /**
       * The question.
       */
      questionId: QuestionId;
      /**
       * The session.
       */
      sessionId: SessionId;
      /**
       * The run that waits.
       */
      runId: RunId;
      /**
       * Whether the question is answerable at once or waits for its run.
       */
      state: QuestionAskedState;
      /**
       * The provider's own id of the request the question came on, by which a request the
       * provider sends again after the daemon's restart finds its record; absent where the id
       * is longer than a provider handle.
       */
      providerRequestId?: string;
      /**
       * Only a workflow step's question names a wait.
       */
      waitId?: never;
      /**
       * False only on a question the agent does not wait for: its run keeps running, no card
       * of its own is raised, and the admission of the queued message naming it as
       * `answersQuestionId` marks it answered.
       */
      isAgentWaiting: boolean;
      /**
       * Every question of the record in page order, so a rebuilt card pages through them
       * with no further read.
       *
       * @minItems 1
       */
      questions: [QuestionPrompt, ...QuestionPrompt[]];
    }
  | {
      /**
       * The question.
       */
      questionId: QuestionId;
      /**
       * The session.
       */
      sessionId: SessionId;
      /**
       * Only an agent's or a tool server's question names a run.
       */
      runId?: never;
      /**
       * The workflow wait.
       */
      waitId: string;
      /**
       * Only a run's question can wait for its run; a workflow wait's is open at once.
       */
      state?: never;
      /**
       * False only on a question the agent does not wait for: its run keeps running, no card
       * of its own is raised, and the admission of the queued message naming it as
       * `answersQuestionId` marks it answered.
       */
      isAgentWaiting: boolean;
      /**
       * Every question of the record in page order, so a rebuilt card pages through them
       * with no further read.
       *
       * @minItems 1
       */
      questions: [QuestionPrompt, ...QuestionPrompt[]];
    };
/**
 * Why an open question ended unanswered: its turn was interrupted, its provider withdrew the
 * request, or its run ended, a restart of the background service among the ways a run ends.
 */
export type QuestionCanceledReason = "interrupted" | "withdrawn" | "runEnded";
/**
 * The answer to one question: the picked labels, typed text, a secret, or a skip; each question
 * takes exactly one.
 */
export type QuestionAnswer =
  | {
      kind: "picked";
      /**
       * Their labels.
       *
       * @minItems 1
       */
      labels: [string, ...string[]];
    }
  | {
      kind: "typed";
      /**
       * The text.
       */
      text: string;
    }
  | {
      kind: "secret";
      /**
       * The secret.
       */
      value: string;
    }
  | {
      kind: "skipped";
    };
/**
 * Why `question.answerInvalid` refused one answer, carried as its `reason`: a secret for a plain
 * question, a label the question does not offer, several labels for a question that takes one,
 * or typed text for a question that takes only its options.
 */
export type QuestionAnswerInvalidReason =
  | "secretOnPlain"
  | "labelNotOffered"
  | "severalOnSingle"
  | "textOnChoice";
/**
 * The state `question.resolve` replies with: the record answered or canceled, or the answer kept
 * for the tool server's next ask.
 */
export type QuestionResolveState = "answered" | "canceled" | "kept";

/**
 * One option row; `preview` is present only where the provider attached one to the option.
 */
export interface QuestionOption {
  /**
   * The option's label.
   */
  label: string;
  /**
   * What it means.
   */
  description?: string;
  /**
   * What picking it would look like.
   */
  preview?: string;
}
/**
 * One question of the record, one page of the card. A secret question takes a masked answer and
 * has no option rows; a numeric field's smallest number is at most its largest; a question with
 * option rows starts from its own options, which the schema states as `defaultAmongOptions`.
 */
export interface QuestionPrompt {
  /**
   * The agent's own short header, a tool server's name, or a workflow's name.
   */
  header?: string;
  /**
   * The question.
   */
  text: string;
  /**
   * The summary line, where the agent sent one.
   */
  heading?: string;
  /**
   * The question's own helper line, drawn faint under its text.
   */
  description?: string;
  /**
   * The option rows; empty on a secret question.
   */
  options: QuestionOption[];
  /**
   * The provider's own reading of whether several picks go back together.
   */
  severalAnswers: boolean;
  /**
   * Whether the answer is masked and never stored.
   */
  secret: boolean;
  /**
   * Whether the form must have this field answered. Only a tool server's form field sets it, and
   * a producer that sets it on an agent's question makes that question refuse typed text.
   */
  required?: boolean;
  /**
   * The answer the field starts from, present only where the form declared one.
   */
  default?: QuestionDefault;
  /**
   * The smallest number a numeric field takes, where the form bounds it.
   */
  minimum?: number;
  /**
   * The largest number a numeric field takes, where the form bounds it.
   */
  maximum?: number;
  /**
   * How far the arrow keys move a number field, where the question sets it.
   */
  step?: number;
  /**
   * A short unit drawn as a suffix inside a number field, where the question sets one.
   */
  unit?: string;
  /**
   * A text field's faint hint while it is empty, where the question sets one.
   */
  placeholder?: string;
}
/**
 * `question.opened`: a question waiting for its run became answerable once the run read running,
 * in the write that moves the run to `waitingForInput` on it, so its card is no longer greyed.
 */
export interface QuestionOpenedPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The question.
   */
  questionId: QuestionId;
}
/**
 * `question.canceled`: an open question, or one waiting for its run, ended unanswered, so its card
 * stays closed after a reload and on every device, and no `user.message.sent` is written.
 */
export interface QuestionCanceledPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The question.
   */
  questionId: QuestionId;
  /**
   * Why it ended.
   */
  reason: QuestionCanceledReason;
}
/**
 * `question.resolve`: every answer at once, one per question in the record's own order. The
 * daemon refuses a list that does not answer every question rather than applying half of it.
 */
export interface QuestionResolveRequest {
  /**
   * The question.
   */
  questionId: QuestionId;
  /**
   * The answers.
   *
   * @minItems 1
   */
  answers: [QuestionAnswer, ...QuestionAnswer[]];
}
/**
 * The `question.resolve` result: the record's settled state, or the kept answer.
 */
export interface QuestionResolveResponse {
  /**
   * The question.
   */
  questionId: QuestionId;
  /**
   * The record's settled state, or `kept` for an answer kept for the tool server's next ask.
   */
  state: QuestionResolveState;
}

export {
  validateQuestionAnswer,
  validateQuestionAskedPayload,
  validateQuestionAskedState,
  validateQuestionCanceledPayload,
  validateQuestionCanceledReason,
  validateQuestionDefault,
  validateQuestionId,
  validateQuestionOpenedPayload,
  validateQuestionOption,
  validateQuestionPrompt,
  validateQuestionResolveRequest,
  validateQuestionResolveResponse,
  validateQuestionResolveState,
} from "./checks/question.js";

/** The methods of {@link QUESTION_METHOD_DESCRIPTORS}, each with its checks. */
export interface QuestionMethodDescriptors {
  readonly "question.resolve": {
    readonly method: "question.resolve";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<QuestionResolveRequest>;
    readonly responseCheck: SchemaCheck<QuestionResolveResponse>;
  };
}
/** The `question.*` methods a client calls. */
export const QUESTION_METHOD_DESCRIPTORS: QuestionMethodDescriptors = /* @__PURE__ */ Object.freeze(
  {
    "question.resolve": /* @__PURE__ */ Object.freeze({
      method: "question.resolve",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateQuestionResolveRequest,
      responseCheck: validateQuestionResolveResponse,
    }),
  },
);

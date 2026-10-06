// A question record and the one call that answers it.
//
// An agent's held question on either provider, a tool server's question, and a
// workflow step waiting for a chat reply all become one question record the
// screen renders (`question.asked`), answered by one call (`question.resolve`).
// The daemon holds the question with no timer and rebuilds its card on a reload
// and on every linked device; the first answer settles it everywhere, and a later
// answer reads back the settled state rather than applying again.
//
// A secret answer is delivered and never stored: it reaches no event payload,
// no projection and no artifact, and the person's turn records only that a secret
// was answered.
//
// This file imports nothing from `event/session-event.ts`: that module imports the payload
// schema below, and an import back would close an eager module cycle.
import { z } from "zod";

import { brandedUuidIdSchema, uuidTextFormSchema } from "./internal/branded.js";
import type { MethodDescriptor } from "./method-descriptor.js";
import { defineMethodDescriptors } from "./method-descriptor.js";
import { RunIdSchema, type RunId } from "./provider/driver/intervention.js";
import { SessionIdSchema, type SessionId } from "./session/id.js";

/** The daemon-minted id of one question record. */
export type QuestionId = string & { readonly __brand: "QuestionId" };
/** Parses a {@link QuestionId}. */
export const QuestionIdSchema: z.ZodType<QuestionId, QuestionId> =
  brandedUuidIdSchema<QuestionId>("QuestionId");

/**
 * One option row. `preview` is present only where the provider attached one to
 * the option.
 */
export interface QuestionOption {
  label: string;
  description?: string | undefined;
  preview?: string | undefined;
}
const QuestionOptionSchema: z.ZodType<QuestionOption> = z
  .object({
    label: z.string().min(1),
    description: z.string().optional(),
    preview: z.string().optional(),
  })
  .strict();

/** One question of the record, one page of the card. */
export interface QuestionPrompt {
  /** The agent's own short header, a tool server's name, or a workflow's name. */
  header?: string | undefined;
  text: string;
  /** The summary line, where the agent sent one. */
  heading?: string | undefined;
  /** Empty on a `secret` question, which takes a masked answer. */
  options: QuestionOption[];
  /** The provider's own reading of whether several picks go back together. */
  severalAnswers: boolean;
  secret: boolean;
}
const QuestionPromptSchema: z.ZodType<QuestionPrompt> = z
  .object({
    header: z.string().min(1).optional(),
    text: z.string().min(1),
    heading: z.string().min(1).optional(),
    options: z.array(QuestionOptionSchema),
    severalAnswers: z.boolean(),
    secret: z.boolean(),
  })
  .strict()
  .superRefine((prompt, context) => {
    if (prompt.secret && prompt.options.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["options"],
        message: "a secret question draws a masked field and no option rows",
      });
    }
  });

/**
 * The `question.asked` payload. Exactly one of `runId` (an agent's or a tool server's question)
 * and `waitId` (a workflow step's) names what is waiting. `questions` holds every question of the
 * record, one per page in order, so a rebuilt card pages through them with no further read;
 * `pageCount` is its length.
 */
export type QuestionAskedPayload = {
  questionId: QuestionId;
  sessionId: SessionId;
  runId?: RunId | undefined;
  waitId?: string | undefined;
  /**
   * False only on a question the agent does not wait for: its run keeps running, no card of its
   * own is raised, and the `user.message` naming it as `answersQuestionId` marks it answered.
   */
  isAgentWaiting: boolean;
  pageCount: number;
  questions: QuestionPrompt[];
};
/** Parses a {@link QuestionAskedPayload}. */
export const QuestionAskedPayloadSchema: z.ZodType<QuestionAskedPayload> = z
  .object({
    questionId: QuestionIdSchema,
    sessionId: SessionIdSchema,
    runId: RunIdSchema.optional(),
    waitId: uuidTextFormSchema.optional(),
    isAgentWaiting: z.boolean(),
    pageCount: z.number().int().positive(),
    questions: z.array(QuestionPromptSchema).min(1),
  })
  .strict()
  .superRefine((payload, context) => {
    if ((payload.runId === undefined) === (payload.waitId === undefined)) {
      context.addIssue({
        code: "custom",
        path: ["waitId"],
        message: "a question names either the run or the workflow wait it holds, not both",
      });
    }
    if (payload.pageCount !== payload.questions.length) {
      context.addIssue({
        code: "custom",
        path: ["pageCount"],
        message: "a question record has one page per question",
      });
    }
  });

/**
 * The answer to one question: the picked labels, typed text, a secret, or a skip.
 * A closed union rather than four optional members, because each question takes
 * exactly one.
 */
export type QuestionAnswer =
  | { kind: "picked"; labels: string[] }
  | { kind: "typed"; text: string }
  | { kind: "secret"; value: string }
  | { kind: "skipped" };
const QuestionAnswerSchema: z.ZodType<QuestionAnswer, QuestionAnswer> = z.discriminatedUnion(
  "kind",
  [
    z.object({ kind: z.literal("picked"), labels: z.array(z.string().min(1)).min(1) }).strict(),
    z.object({ kind: z.literal("typed"), text: z.string().min(1) }).strict(),
    z.object({ kind: z.literal("secret"), value: z.string().min(1) }).strict(),
    z.object({ kind: z.literal("skipped") }).strict(),
  ],
);

/**
 * Every answer at once, one per question in the record's own order. The daemon
 * refuses a list that does not answer every question rather than applying half of
 * it.
 */
export interface QuestionResolveRequest {
  questionId: QuestionId;
  answers: QuestionAnswer[];
}
/** Parses a {@link QuestionResolveRequest}. */
export const QuestionResolveRequestSchema: z.ZodType<
  QuestionResolveRequest,
  QuestionResolveRequest
> = z
  .object({ questionId: QuestionIdSchema, answers: z.array(QuestionAnswerSchema).min(1) })
  .strict();

/** The record's state: answered, or canceled with the turn that held it. */
export interface QuestionResolveResponse {
  questionId: QuestionId;
  state: "answered" | "canceled";
}
/** Parses a {@link QuestionResolveResponse}. */
export const QuestionResolveResponseSchema: z.ZodType<QuestionResolveResponse> = z
  .object({ questionId: QuestionIdSchema, state: z.enum(["answered", "canceled"]) })
  .strict();

/** The `question.*` methods a client calls. */
export interface QuestionMethodDescriptors {
  readonly "question.resolve": MethodDescriptor<
    "question.resolve",
    QuestionResolveRequest,
    QuestionResolveResponse
  >;
}

/** The `question.*` descriptor table. */
export const QUESTION_METHOD_DESCRIPTORS: QuestionMethodDescriptors = defineMethodDescriptors({
  "question.resolve": {
    method: "question.resolve",
    procedureType: "mutation",
    mutating: true,
    requestSchema: QuestionResolveRequestSchema,
    responseSchema: QuestionResolveResponseSchema,
  },
});

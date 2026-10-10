// The question card's cross-field rules: a question held by both a run and a wait or by neither,
// and a secret question with option rows.
import { describe, expect, it } from "vitest";

import { QuestionAskedPayloadSchema, QuestionResolveRequestSchema } from "../question.js";
import {
  PICK_ONE,
  QUESTION_ASKED_ON_RUN_PAYLOAD,
  QUESTION_ID,
  RUN_ID,
} from "./question.test-support.js";

const WAIT_ID = "2f2b4d5e-cccc-4ccc-8ccc-cccccccccccc";

describe("QuestionAskedPayloadSchema", () => {
  const { runId: _runId, ...base } = QUESTION_ASKED_ON_RUN_PAYLOAD;

  it("accepts an agent's question on its run and a workflow step's question on its wait", () => {
    expect(QuestionAskedPayloadSchema.safeParse({ ...base, runId: RUN_ID }).success).toBe(true);
    expect(QuestionAskedPayloadSchema.safeParse({ ...base, waitId: WAIT_ID }).success).toBe(true);
  });

  it("refuses a question naming both a run and a wait, and one naming neither", () => {
    expect(
      QuestionAskedPayloadSchema.safeParse({ ...base, runId: RUN_ID, waitId: WAIT_ID }).success,
    ).toBe(false);
    expect(QuestionAskedPayloadSchema.safeParse(base).success).toBe(false);
  });

  it("refuses option rows on a secret question", () => {
    expect(
      QuestionAskedPayloadSchema.safeParse({
        ...base,
        runId: RUN_ID,
        questions: [{ ...PICK_ONE, secret: true }],
      }).success,
    ).toBe(false);
  });
});

describe("QuestionResolveRequestSchema", () => {
  it("accepts one answer of each kind", () => {
    const request = {
      questionId: QUESTION_ID,
      answers: [
        { kind: "picked", labels: ["OAuth", "Token"] },
        { kind: "typed", text: "use the staging tenant" },
        { kind: "secret", value: "hunter2" },
        { kind: "skipped" },
      ],
    };
    expect(QuestionResolveRequestSchema.safeParse(request).success).toBe(true);
  });

  it("refuses a secret carried on a typed answer's member", () => {
    const leaked = {
      questionId: QUESTION_ID,
      answers: [{ kind: "typed", text: "visible", value: "hunter2" }],
    };
    expect(QuestionResolveRequestSchema.safeParse(leaked).success).toBe(false);
  });
});

// The plan card's and the question card's cross-field rules: a verdict that would mint a
// session nobody asked for, a question held by both a run and a wait or by neither, a page count
// that disagrees with the questions, and a secret question with option rows.
import { describe, expect, it } from "vitest";

import { PlanResolveRequestSchema, PlanResolveResponseSchema } from "../plan.js";
import { QuestionAskedPayloadSchema, QuestionResolveRequestSchema } from "../question.js";

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
const FRESH_SESSION_ID = "650e8400-e29b-41d4-a716-446655440000";
const RUN_ID = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";
const PLAN_ID = "0f2b4d5e-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const QUESTION_ID = "1f2b4d5e-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const WAIT_ID = "2f2b4d5e-cccc-4ccc-8ccc-cccccccccccc";

describe("PlanResolveRequestSchema", () => {
  it("accepts each verdict, with the session to mint on a fresh one", () => {
    expect(PlanResolveRequestSchema.safeParse({ planId: PLAN_ID, verdict: "keep" }).success).toBe(
      true,
    );
    expect(PlanResolveRequestSchema.safeParse({ planId: PLAN_ID, verdict: "build" }).success).toBe(
      true,
    );
    expect(
      PlanResolveRequestSchema.safeParse({
        planId: PLAN_ID,
        verdict: "fresh",
        fresh: { driverName: "codex", level: "ask" },
      }).success,
    ).toBe(true);
  });

  it("refuses a fresh verdict with no session, and a session on another verdict", () => {
    expect(PlanResolveRequestSchema.safeParse({ planId: PLAN_ID, verdict: "fresh" }).success).toBe(
      false,
    );
    expect(
      PlanResolveRequestSchema.safeParse({
        planId: PLAN_ID,
        verdict: "build",
        fresh: { driverName: "codex", level: "ask" },
      }).success,
    ).toBe(false);
  });
});

describe("PlanResolveResponseSchema", () => {
  it("accepts a handed-off plan naming its fresh session, and a kept plan left open", () => {
    expect(
      PlanResolveResponseSchema.safeParse({
        planId: PLAN_ID,
        state: "handed_off",
        freshSessionId: FRESH_SESSION_ID,
      }).success,
    ).toBe(true);
    expect(PlanResolveResponseSchema.safeParse({ planId: PLAN_ID, state: "open" }).success).toBe(
      true,
    );
  });

  it("ties a fresh session to a handed-off plan and to no accepted plan", () => {
    expect(
      PlanResolveResponseSchema.safeParse({ planId: PLAN_ID, state: "handed_off" }).success,
    ).toBe(false);
    expect(
      PlanResolveResponseSchema.safeParse({
        planId: PLAN_ID,
        state: "accepted",
        freshSessionId: FRESH_SESSION_ID,
      }).success,
    ).toBe(false);
  });
});

const PICK_ONE = {
  header: "Auth",
  text: "Which login flow should the service use?",
  options: [
    { label: "OAuth", description: "Sign in with the hosting service" },
    { label: "Token", description: "A pasted access token" },
  ],
  severalAnswers: false,
  secret: false,
};

describe("QuestionAskedPayloadSchema", () => {
  const base = {
    questionId: QUESTION_ID,
    sessionId: SESSION_ID,
    isAgentWaiting: true,
    pageCount: 1,
    questions: [PICK_ONE],
  };

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

  it("has one page per question, and no option rows on a secret question", () => {
    const workflowQuestion = { text: "Which branch?", options: [], severalAnswers: false };
    const twoPages = { ...base, runId: RUN_ID, pageCount: 2 };
    expect(
      QuestionAskedPayloadSchema.safeParse({
        ...twoPages,
        questions: [PICK_ONE, { ...workflowQuestion, secret: false }],
      }).success,
    ).toBe(true);
    expect(QuestionAskedPayloadSchema.safeParse(twoPages).success).toBe(false);
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

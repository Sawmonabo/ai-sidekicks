// The answer a question card delivers, over a call whose reply a case decides. Every case asks
// what a second press does, and what the hook holds when it is pressed.

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { QuestionAnswer, QuestionResolveRequest } from "@ai-sidekicks/contracts";

import { settle } from "@test/helpers/settle.js";
import { useQuestionAnswer, type ResolveQuestionCall } from "./useQuestionAnswer.js";

const SAMPLE_QUESTION_ID = "019b793b-7b60-7a21-9f14-6b0c2a7d0e11";

const SAMPLE_ANSWERS: QuestionAnswer[] = [
  { kind: "picked", labels: ["develop"] },
  { kind: "typed", text: "the flaky test is known" },
];

function resolveFailingUntilCleared(): {
  readonly resolveQuestion: ResolveQuestionCall;
  readonly requests: QuestionResolveRequest[];
  readonly recover: () => void;
} {
  const requests: QuestionResolveRequest[] = [];
  let isServing = false;
  return {
    requests,
    recover: () => {
      isServing = true;
    },
    resolveQuestion: (request) => {
      requests.push(request);
      return Promise.resolve(
        isServing
          ? { status: "served", value: { questionId: request.questionId, state: "answered" } }
          : {
              status: "refused",
              refusal: { code: "call-rejected", detail: "The daemon is down.", origin: "daemon" },
            },
      );
    },
  };
}

describe("useQuestionAnswer — an answer is a settled act", () => {
  it("settles as accepted when the daemon takes the answers, sent as they were given", async () => {
    const call = resolveFailingUntilCleared();
    call.recover();
    const { result } = renderHook(() =>
      useQuestionAnswer(SAMPLE_QUESTION_ID, call.resolveQuestion),
    );

    act(() => {
      result.current.answer(SAMPLE_ANSWERS);
    });
    await settle();

    expect(result.current.delivery).toStrictEqual({ status: "accepted" });
    expect(call.requests).toStrictEqual([
      { questionId: SAMPLE_QUESTION_ID, answers: SAMPLE_ANSWERS },
    ]);
  });

  it("dispatches again when a refused answer is retried", async () => {
    const call = resolveFailingUntilCleared();
    const { result } = renderHook(() =>
      useQuestionAnswer(SAMPLE_QUESTION_ID, call.resolveQuestion),
    );

    act(() => {
      result.current.answer(SAMPLE_ANSWERS);
    });
    await settle();
    call.recover();
    act(() => {
      result.current.answer(SAMPLE_ANSWERS);
    });
    await settle();

    expect(call.requests).toHaveLength(2);
    expect(result.current.delivery.status).toBe("accepted");
  });

  it("negative control: an answered question is not answered twice", async () => {
    // A second delivery would be a second answer to a question that has one.
    const call = resolveFailingUntilCleared();
    call.recover();
    const { result } = renderHook(() =>
      useQuestionAnswer(SAMPLE_QUESTION_ID, call.resolveQuestion),
    );

    act(() => {
      result.current.answer(SAMPLE_ANSWERS);
    });
    await settle();
    act(() => {
      result.current.answer([{ kind: "typed", text: "main" }]);
    });
    await settle();

    expect(call.requests).toHaveLength(1);
  });
});

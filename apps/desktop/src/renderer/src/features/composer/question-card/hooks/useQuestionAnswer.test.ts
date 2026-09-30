// The answer a question card delivers, over a call whose reply a case decides.
//
// THE SUBJECT IS A REPLY THAT MUST NOT BE DISCARDED. A refused answer that stored
// nothing left a blocked run and an emptied draft. What every case below asks is what a
// SECOND press does, and what the hook is holding when it is pressed.

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { QuestionResolveRequest } from "@ai-sidekicks/contracts";

import { settle } from "@test/helpers/settle.js";
import { useQuestionAnswer, type ResolveQuestionCall } from "./useQuestionAnswer.js";

const SAMPLE_QUESTION_ID = "019b793b-7b60-7a21-9f14-6b0c2a7d0e11";

/** A call that refuses until `recover` is called, and records every request it took. */
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
  it("holds the refusal when the answer never reached the daemon", async () => {
    const call = resolveFailingUntilCleared();
    const { result } = renderHook(() =>
      useQuestionAnswer(SAMPLE_QUESTION_ID, call.resolveQuestion),
    );

    act(() => {
      result.current.answer("develop");
    });
    await settle();

    expect(result.current.delivery).toMatchObject({
      status: "refused",
      response: "develop",
      refusal: { code: "call-rejected" },
    });
  });

  it("settles as accepted when the daemon takes the typed answer", async () => {
    const call = resolveFailingUntilCleared();
    call.recover();
    const { result } = renderHook(() =>
      useQuestionAnswer(SAMPLE_QUESTION_ID, call.resolveQuestion),
    );

    act(() => {
      result.current.answer("develop");
    });
    await settle();

    expect(result.current.delivery).toStrictEqual({ status: "accepted", response: "develop" });
    expect(call.requests).toStrictEqual([
      { questionId: SAMPLE_QUESTION_ID, answers: [{ kind: "typed", text: "develop" }] },
    ]);
  });

  it("dispatches again when a refused answer is retried", async () => {
    const call = resolveFailingUntilCleared();
    const { result } = renderHook(() =>
      useQuestionAnswer(SAMPLE_QUESTION_ID, call.resolveQuestion),
    );

    act(() => {
      result.current.answer("develop");
    });
    await settle();
    call.recover();
    act(() => {
      result.current.answer("develop");
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
      result.current.answer("develop");
    });
    await settle();
    act(() => {
      result.current.answer("main");
    });
    await settle();

    expect(call.requests).toHaveLength(1);
  });
});

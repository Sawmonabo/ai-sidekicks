// The answer an ask row delivers, over a real bridge whose reply a case decides.
//
// `bridgeAnswering` rather than a hand-built port, for `child-run-expansion.test.ts`'
// reason: the hook reaches the console's own call door, so a stand-in would prove the
// case answers itself rather than that a refusal off the wire reaches the state a
// surface renders.
//
// THE SUBJECT IS A REPLY THAT WAS CONSULTED FOR ITS SUCCESS ARM AND DISCARDED
// OTHERWISE. The delivery stored nothing at all, so a refused answer left a blocked
// run and an emptied draft. What every case below asks is what a SECOND press does,
// and what the hook is holding when it is pressed.
//
// A `.tsx` FILE FOR A `.ts` MODULE, because the wrapper `renderHook` mounts is a
// component and the hook resolves its bridge from context — there is no way to drive
// it that does not render one.

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { RunId } from "@ai-sidekicks/contracts";

import { bridgeFailingUntilCleared, callsTo, inBridge } from "./shell-hook-bridges.test-support.js";
import { settle } from "../../../core/settle.test-support.js";
import { useDriverAskAnswer } from "./shell-ask-answer.js";

const SAMPLE_RUN_ID = "019b79ee-0280-740e-8110-d1a4c1150091" as RunId;
const SAMPLE_ASK_ID = "ask-01";
const ASK_ANSWER = "driver.respondToRequest";

/** The empty envelope `driver.respondToRequest` acknowledges with. */
const DRIVER_ACK: Record<string, unknown> = {};

describe("useDriverAskAnswer — an answer is a settled act", () => {
  it("holds the refusal when the answer never reached the driver", async () => {
    // THE DEFECT, EXERCISED. The reply was discarded, so a run blocked on an ask the
    // daemon never received looked exactly like one waiting for somebody to type.
    const { held } = bridgeFailingUntilCleared(ASK_ANSWER, DRIVER_ACK);
    const { result } = renderHook(() => useDriverAskAnswer(SAMPLE_RUN_ID, SAMPLE_ASK_ID), {
      wrapper: inBridge(held),
    });

    act(() => {
      result.current.answer("develop");
    });
    await settle();

    expect(result.current.delivery.status).toBe("refused");
    expect(result.current.delivery).toMatchObject({
      response: "develop",
      refusal: { code: "call-rejected" },
    });
  });

  it("settles as accepted when the driver acknowledges it", async () => {
    const { held, recover } = bridgeFailingUntilCleared(ASK_ANSWER, DRIVER_ACK);
    recover();
    const { result } = renderHook(() => useDriverAskAnswer(SAMPLE_RUN_ID, SAMPLE_ASK_ID), {
      wrapper: inBridge(held),
    });

    act(() => {
      result.current.answer("develop");
    });
    await settle();

    expect(result.current.delivery).toStrictEqual({ status: "accepted", response: "develop" });
    expect(held.calls.find((call) => call.method === ASK_ANSWER)?.params).toEqual({
      runId: SAMPLE_RUN_ID,
      requestId: SAMPLE_ASK_ID,
      response: "develop",
    });
  });

  it("dispatches again when a refused answer is retried", async () => {
    const { held, recover } = bridgeFailingUntilCleared(ASK_ANSWER, DRIVER_ACK);
    const { result } = renderHook(() => useDriverAskAnswer(SAMPLE_RUN_ID, SAMPLE_ASK_ID), {
      wrapper: inBridge(held),
    });

    act(() => {
      result.current.answer("develop");
    });
    await settle();
    recover();
    act(() => {
      result.current.answer("develop");
    });
    await settle();

    expect(callsTo(held, ASK_ANSWER)).toBe(2);
    expect(result.current.delivery.status).toBe("accepted");
  });

  it("negative control: an acknowledged ask is not answered twice", async () => {
    // A second delivery would be a second answer to a question that has one, and the
    // ask's terminal is the `driver_ask.responded` row's to state rather than a press's.
    const { held, recover } = bridgeFailingUntilCleared(ASK_ANSWER, DRIVER_ACK);
    recover();
    const { result } = renderHook(() => useDriverAskAnswer(SAMPLE_RUN_ID, SAMPLE_ASK_ID), {
      wrapper: inBridge(held),
    });

    act(() => {
      result.current.answer("develop");
    });
    await settle();
    act(() => {
      result.current.answer("main");
    });
    await settle();

    expect(callsTo(held, ASK_ANSWER)).toBe(1);
  });

  it("negative control: a row carrying no ask id sends nothing", async () => {
    const { held, recover } = bridgeFailingUntilCleared(ASK_ANSWER, DRIVER_ACK);
    recover();
    const { result } = renderHook(() => useDriverAskAnswer(SAMPLE_RUN_ID, ""), {
      wrapper: inBridge(held),
    });

    act(() => {
      result.current.answer("develop");
    });
    await settle();

    expect(callsTo(held, ASK_ANSWER)).toBe(0);
    expect(result.current.delivery.status).toBe("unsent");
  });
});

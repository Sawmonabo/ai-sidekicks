// The two calls the shell's rows make, over a real bridge whose answer a case decides.
//
// `bridgeAnswering` rather than a hand-built port, for `child-run-expansion.test.ts`'
// reason: both hooks reach the console's own call door, so a stand-in would prove the
// case answers itself rather than that a refusal off the wire reaches the state a
// surface renders.
//
// BOTH SUBJECTS ARE THE SAME DEFECT WEARING TWO SHAPES: a reply that was consulted for
// its success arm and discarded otherwise. The reasoning read stored its refusal and
// then admitted no second press, so a transport that was down for one moment took the
// read away for the row's whole life; the ask answer stored nothing at all, so a
// refused delivery left a blocked run and an emptied draft. What every case below asks
// is what a SECOND press does, and what the hook is holding when it is pressed.
//
// A `.tsx` FILE FOR A `.ts` MODULE, because the wrapper `renderHook` mounts is a
// component and both hooks resolve their bridge from context — there is no way to
// drive them that does not render one.

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { RunId } from "@ai-sidekicks/contracts";

import { SidekicksBridgeProvider } from "../../../bridge/index.js";
import {
  bridgeAnswering,
  type BridgeUnderTest,
} from "../../../bridge/fixture/fixture-bridge.test-support.js";
import { settle } from "../../../core/settle.test-support.js";
import { useDriverAskAnswer, useReasoningSurfaceRead } from "./shell-row-reads.js";

const SAMPLE_RUN_ID = "019b79ee-0280-740e-8110-d1a4c1150091" as RunId;
const SAMPLE_ASK_ID = "ask-01";
const REASONING_READ = "timeline.reasoningSurfaceRead";
const ASK_ANSWER = "driver.respondToRequest";

/** One `ReasoningSurfaceReadResponse` on the arm that carries no entries. */
const UNAVAILABLE_REASONING: Record<string, unknown> = { availability: "unavailable" };

/** The empty envelope `driver.respondToRequest` acknowledges with. */
const DRIVER_ACK: Record<string, unknown> = {};

/** A bridge whose one scripted method fails until the case clears the flag. */
interface RecoverableBridge {
  readonly held: BridgeUnderTest;
  /** Stop refusing, so the NEXT call is the one that succeeds. */
  readonly recover: () => void;
}

/**
 * A bridge that answers one method as the case says, and rejects it while a flag is set.
 *
 * The flag is read at CALL time rather than closed over at build time, because every
 * case here is about a second press: the first call has to be able to fail and the
 * second to succeed without the case rebuilding the bridge between them.
 */
function bridgeFailingUntilCleared(
  method: string,
  reply: Record<string, unknown>,
): RecoverableBridge {
  let isFailing = true;
  const held = bridgeAnswering(async (call, passThrough) => {
    if (call.method !== method) {
      return passThrough();
    }
    if (isFailing) {
      throw new Error("the daemon is not reachable");
    }
    return reply;
  });
  return {
    held,
    recover: () => {
      isFailing = false;
    },
  };
}

/** How many times the case's method reached the wire. */
function callsTo(held: BridgeUnderTest, method: string): number {
  return held.calls.filter((call) => call.method === method).length;
}

/** A wrapper mounting a hook under one bridge, which is what both hooks resolve. */
function inBridge(held: BridgeUnderTest) {
  return function BridgeWrapper(props: { readonly children: React.ReactNode }): React.JSX.Element {
    return <SidekicksBridgeProvider bridge={held.bridge}>{props.children}</SidekicksBridgeProvider>;
  };
}

describe("useReasoningSurfaceRead — a refusal is retryable and an answer is not", () => {
  it("holds the door's own refusal rather than discarding it", async () => {
    const { held } = bridgeFailingUntilCleared(REASONING_READ, UNAVAILABLE_REASONING);
    const { result } = renderHook(() => useReasoningSurfaceRead(SAMPLE_RUN_ID), {
      wrapper: inBridge(held),
    });

    act(() => {
      result.current.expand();
    });
    await settle();

    expect(result.current.reading.status).toBe("refused");
  });

  it("issues a second read when a refused one is asked again", async () => {
    // THE DEFECT, EXERCISED. The guard admitted `not-asked` alone, so a read refused by
    // a transport that was down for one moment could never be taken again — and the
    // control was hidden in that state, so there was nothing on screen to press either.
    const { held, recover } = bridgeFailingUntilCleared(REASONING_READ, UNAVAILABLE_REASONING);
    const { result } = renderHook(() => useReasoningSurfaceRead(SAMPLE_RUN_ID), {
      wrapper: inBridge(held),
    });

    act(() => {
      result.current.expand();
    });
    await settle();
    expect(result.current.reading.status).toBe("refused");

    recover();
    act(() => {
      result.current.expand();
    });
    await settle();

    expect(callsTo(held, REASONING_READ)).toBe(2);
    expect(result.current.reading.status).toBe("read");
  });

  it("negative control: a read that answered is not asked again", async () => {
    // Without this, admitting a refusal would have been written as admitting anything
    // settled — and a second press would re-ask a question whose answer is on screen,
    // for a page this surface holds no continuation cursor to extend.
    const { held, recover } = bridgeFailingUntilCleared(REASONING_READ, UNAVAILABLE_REASONING);
    recover();
    const { result } = renderHook(() => useReasoningSurfaceRead(SAMPLE_RUN_ID), {
      wrapper: inBridge(held),
    });

    act(() => {
      result.current.expand();
    });
    await settle();
    act(() => {
      result.current.expand();
    });
    await settle();

    expect(callsTo(held, REASONING_READ)).toBe(1);
  });

  it("negative control: a row with no run attribution asks nothing", async () => {
    const { held, recover } = bridgeFailingUntilCleared(REASONING_READ, UNAVAILABLE_REASONING);
    recover();
    const { result } = renderHook(() => useReasoningSurfaceRead(undefined), {
      wrapper: inBridge(held),
    });

    act(() => {
      result.current.expand();
    });
    await settle();

    expect(callsTo(held, REASONING_READ)).toBe(0);
    expect(result.current.reading.status).toBe("not-asked");
  });
});

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

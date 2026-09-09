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
import {
  connectedShell,
  quietShell,
  serveShell,
  stopShell,
  stoppedShell,
} from "../../../store/shell-condition.test-support.js";
import { settle } from "../../../core/settle.test-support.js";
import { useDriverAskAnswer } from "./shell-ask-answer.js";

const SAMPLE_RUN_ID = "019b79ee-0280-740e-8110-d1a4c1150091" as RunId;
const SAMPLE_ASK_ID = "ask-01";
const ASK_ANSWER = "driver.respondToRequest";

/** The empty envelope `driver.respondToRequest` acknowledges with. */
const DRIVER_ACK: Record<string, unknown> = {};

// A shell that has reported nothing closes no control — silence is not an outage — so
// it is the condition every case that is not about the shell is written under. Bound to
// a case's own local rather than minted inside a render callback, where a fresh store
// on every render would be a fresh subscription on every render.
describe("useDriverAskAnswer — an answer is a settled act", () => {
  it("holds the refusal when the answer never reached the driver", async () => {
    // THE DEFECT, EXERCISED. The reply was discarded, so a run blocked on an ask the
    // daemon never received looked exactly like one waiting for somebody to type.
    const { held } = bridgeFailingUntilCleared(ASK_ANSWER, DRIVER_ACK);
    const frameStore = quietShell();
    const { result } = renderHook(
      () => useDriverAskAnswer(frameStore, SAMPLE_RUN_ID, SAMPLE_ASK_ID),
      {
        wrapper: inBridge(held),
      },
    );

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
    const frameStore = quietShell();
    const { result } = renderHook(
      () => useDriverAskAnswer(frameStore, SAMPLE_RUN_ID, SAMPLE_ASK_ID),
      {
        wrapper: inBridge(held),
      },
    );

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
    const frameStore = quietShell();
    const { result } = renderHook(
      () => useDriverAskAnswer(frameStore, SAMPLE_RUN_ID, SAMPLE_ASK_ID),
      {
        wrapper: inBridge(held),
      },
    );

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
    const frameStore = quietShell();
    const { result } = renderHook(
      () => useDriverAskAnswer(frameStore, SAMPLE_RUN_ID, SAMPLE_ASK_ID),
      {
        wrapper: inBridge(held),
      },
    );

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

  it("negative control: a stopped shell puts no answer on the wire", async () => {
    // THE BLOCK IS READ AT THE DISPATCH SITE, which is the only reading that can be
    // right: the report lands after the render that drew the control, so a guard over
    // the render's snapshot admits this press and the write goes out through a
    // supervisor that has already stopped. `driver.respondToRequest` is a member of
    // `MUTATING_DAEMON_METHODS`, so the console's own rule already says this call is
    // one an outage closes — it was the only such dispatcher not asking.
    const { held, recover } = bridgeFailingUntilCleared(ASK_ANSWER, DRIVER_ACK);
    recover();
    const frameStore = stoppedShell();
    const { result } = renderHook(
      () => useDriverAskAnswer(frameStore, SAMPLE_RUN_ID, SAMPLE_ASK_ID),
      { wrapper: inBridge(held) },
    );

    act(() => {
      result.current.answer("develop");
    });
    await settle();

    expect(callsTo(held, ASK_ANSWER)).toBe(0);
  });

  it("settles the shell's own refusal rather than an avoidable one off the wire", async () => {
    const { held, recover } = bridgeFailingUntilCleared(ASK_ANSWER, DRIVER_ACK);
    recover();
    const frameStore = stoppedShell();
    const { result } = renderHook(
      () => useDriverAskAnswer(frameStore, SAMPLE_RUN_ID, SAMPLE_ASK_ID),
      { wrapper: inBridge(held) },
    );

    act(() => {
      result.current.answer("develop");
    });
    await settle();

    expect(result.current.delivery).toMatchObject({
      status: "refused",
      response: "develop",
      refusal: { code: "shell-stopped", origin: "shell" },
    });
  });

  it("closes the control while the block stands and opens it when the runtime serves", async () => {
    const { held, recover } = bridgeFailingUntilCleared(ASK_ANSWER, DRIVER_ACK);
    recover();
    const frameStore = stoppedShell();
    const { result } = renderHook(
      () => useDriverAskAnswer(frameStore, SAMPLE_RUN_ID, SAMPLE_ASK_ID),
      { wrapper: inBridge(held) },
    );

    expect(result.current.block?.code).toBe("shell-stopped");
    act(() => {
      serveShell(frameStore);
    });

    expect(result.current.block).toBeUndefined();
  });

  it("stops an answer whose press outran the report that closed the control", async () => {
    // THE WINDOW THE DISPATCH-TIME READ EXISTS TO CLOSE. The controls were drawn under
    // a serving runtime, so the handler's own closure holds no block; the report lands
    // and the press reaches that closure before React has re-rendered it. A guard over
    // the render's snapshot admits this press.
    const { held, recover } = bridgeFailingUntilCleared(ASK_ANSWER, DRIVER_ACK);
    recover();
    const frameStore = connectedShell();
    const { result } = renderHook(
      () => useDriverAskAnswer(frameStore, SAMPLE_RUN_ID, SAMPLE_ASK_ID),
      {
        wrapper: inBridge(held),
      },
    );

    act(() => {
      stopShell(frameStore);
      result.current.answer("develop");
    });
    await settle();

    expect(callsTo(held, ASK_ANSWER)).toBe(0);
    expect(result.current.delivery).toMatchObject({
      status: "refused",
      refusal: { code: "shell-stopped" },
    });
  });

  it("negative control: a serving runtime puts the same answer on the wire", async () => {
    // Without this the two cases above would pass over a hook that had stopped
    // dispatching altogether, which is the failure they exist to avoid from the far
    // side: a control nothing can ever answer through.
    const { held, recover } = bridgeFailingUntilCleared(ASK_ANSWER, DRIVER_ACK);
    recover();
    const frameStore = connectedShell();
    const { result } = renderHook(
      () => useDriverAskAnswer(frameStore, SAMPLE_RUN_ID, SAMPLE_ASK_ID),
      {
        wrapper: inBridge(held),
      },
    );

    expect(result.current.block).toBeUndefined();
    act(() => {
      result.current.answer("develop");
    });
    await settle();

    expect(callsTo(held, ASK_ANSWER)).toBe(1);
    expect(result.current.delivery.status).toBe("accepted");
  });

  it("negative control: a row carrying no ask id sends nothing", async () => {
    const { held, recover } = bridgeFailingUntilCleared(ASK_ANSWER, DRIVER_ACK);
    recover();
    const frameStore = quietShell();
    const { result } = renderHook(() => useDriverAskAnswer(frameStore, SAMPLE_RUN_ID, ""), {
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

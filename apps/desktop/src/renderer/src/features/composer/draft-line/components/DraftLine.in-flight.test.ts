// One send at a time: what Send does while a send is still open, between dispatch and
// settlement.

import { act, fireEvent } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MAXIMUM_LIVE_DRAFT_COUNT } from "@renderer/store/persistence-caps.js";
import { DraftStore } from "@renderer/store/draft-store.js";
import { sendCallsAnswering } from "../send-router.test-support.js";
import {
  mountDraftLine,
  openSessionStore,
  pressSend,
  sendButton,
} from "./draft-line.test-support.js";

describe("DraftLine — one send in flight", () => {
  it("dispatches once for two Send presses inside one frame", async () => {
    // Both presses run before React re-renders, so both read `status === "idle"`; only the
    // controller's synchronous latch separates them. Without it the stub is called twice.
    const settleCalls: string[] = [];
    let releaseFirstCall: () => void = () => undefined;
    const pending = new Promise<void>((resolve) => {
      releaseFirstCall = resolve;
    });
    const draftStore = new DraftStore({
      maximumDraftCount: MAXIMUM_LIVE_DRAFT_COUNT,
    });
    const { line, result } = mountDraftLine({
      calls: sendCallsAnswering(async ({ method }) => {
        settleCalls.push(method);
        await pending;
        return undefined;
      }),
      draftStore,
      sessionStore: openSessionStore(),
    });

    fireEvent.change(line, { target: { value: "once, please" } });
    await act(async () => {
      pressSend(result.container);
      pressSend(result.container);
    });
    expect(settleCalls).toStrictEqual(["run.queueCreate"]);

    await act(async () => {
      releaseFirstCall();
      await pending;
    });
    expect(settleCalls).toStrictEqual(["run.queueCreate"]);
  });

  it("ignores a press while the call is pending, silently and with no second call", async () => {
    const settleCalls: string[] = [];
    let releaseFirstCall: () => void = () => undefined;
    const pending = new Promise<void>((resolve) => {
      releaseFirstCall = resolve;
    });
    const draftStore = new DraftStore({
      maximumDraftCount: MAXIMUM_LIVE_DRAFT_COUNT,
    });
    const { line, result } = mountDraftLine({
      calls: sendCallsAnswering(async ({ method }) => {
        settleCalls.push(method);
        await pending;
        return undefined;
      }),
      draftStore,
      sessionStore: openSessionStore(),
    });

    fireEvent.change(line, { target: { value: "still going" } });
    await act(async () => {
      pressSend(result.container);
    });
    expect(sendButton(result.container).disabled).toBe(true);

    // A separate frame, so the line has re-rendered into `sending`: the press is refused
    // silently by the rendered state, since the person was only early.
    await act(async () => {
      pressSend(result.container);
    });
    expect(settleCalls).toHaveLength(1);
    expect(result.container.querySelector(".meridian-refusal--inline")).toBeNull();

    await act(async () => {
      releaseFirstCall();
      await pending;
    });
    expect(settleCalls).toHaveLength(1);
    expect(sendButton(result.container).disabled).toBe(false);
  });

  it("accepts the next send once the first has settled", async () => {
    // The latch releases in `finally`; a wedged one would send exactly once per window.
    const settleCalls: string[] = [];
    const draftStore = new DraftStore({
      maximumDraftCount: MAXIMUM_LIVE_DRAFT_COUNT,
    });
    const { line, result } = mountDraftLine({
      calls: sendCallsAnswering(async ({ method }) => {
        settleCalls.push(method);
        return undefined;
      }),
      draftStore,
      sessionStore: openSessionStore(),
    });

    for (const body of ["first", "second"]) {
      fireEvent.change(line, { target: { value: body } });
      await act(async () => {
        pressSend(result.container);
      });
    }
    expect(settleCalls).toHaveLength(2);
  });
});

// One send at a time: what Send does while a send is still open.
//
// Its own file because in-flight is a state rather than an outcome. The cases are
// about the window between dispatch and settlement, which is the one a fast pair of
// presses actually meets.

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
    // Both presses run before React re-renders, so both read `status === "idle"`.
    // The controller's synchronous latch is the only thing that can separate them,
    // and this case is the negative control for it: without the latch the stub is
    // called twice and two turns are queued from one intent.
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

    // A separate frame, so the line has re-rendered into `sending` — the press
    // is refused by the rendered state rather than by the latch, and refused
    // SILENTLY: nothing was rejected, the person was only early.
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
    // The negative control for the latch itself: it releases in `finally`, so a
    // wedged latch would make the composer send exactly once per window.
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

// One send at a time: what the bar does while a send is still open.
//
// Its own file because in-flight is a state rather than an outcome. The cases are
// about the window between dispatch and settlement, which is the one a fast pair of
// presses actually meets.

import { act, fireEvent } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MAXIMUM_LIVE_DRAFT_COUNT } from "../../../console/core/index.js";
import { DraftStore } from "../../../console/persistence/index.js";
import { bridgeAnswering } from "../../../console/bridge/fixture/call-plane/bridge.test-support.js";
import { QUEUE_CREATED } from "./send-router.test-support.js";
import { mountBar, openSessionStore } from "./composer-send-bar.test-support.js";

describe("ComposerSendBar — one send in flight", () => {
  it("dispatches once for two Enter presses inside one frame", async () => {
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
    const { line } = mountBar({
      bridge: bridgeAnswering(async ({ method }) => {
        settleCalls.push(method);
        await pending;
        return undefined;
      }).bridge,
      draftStore,
      sessionStore: openSessionStore(),
    });

    fireEvent.change(line, { target: { value: "once, please" } });
    await act(async () => {
      fireEvent.keyDown(line, { key: "Enter" });
      fireEvent.keyDown(line, { key: "Enter" });
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
    const { line, result } = mountBar({
      bridge: bridgeAnswering(async ({ method }) => {
        settleCalls.push(method);
        await pending;
        return undefined;
      }).bridge,
      draftStore,
      sessionStore: openSessionStore(),
    });

    fireEvent.change(line, { target: { value: "still going" } });
    await act(async () => {
      fireEvent.keyDown(line, { key: "Enter" });
    });
    expect(line.readOnly).toBe(true);

    // A separate frame, so the surface has re-rendered into `sending` — the press
    // is refused by the rendered state rather than by the latch, and refused
    // SILENTLY: nothing was rejected, the person was only early.
    await act(async () => {
      fireEvent.keyDown(line, { key: "Enter" });
    });
    expect(settleCalls).toHaveLength(1);
    expect(result.container.querySelector(".meridian-refusal--inline")).toBeNull();

    await act(async () => {
      releaseFirstCall();
      await pending;
    });
    expect(settleCalls).toHaveLength(1);
    expect(line.readOnly).toBe(false);
  });

  it("leaves the arrows to the caret while sending, so no recall swaps the line", async () => {
    // The line is READ-ONLY while a send is open. An unguarded arrow still reached
    // the recall walk, which writes the draft store — so the text swapped under a
    // person who could not type, and the walk's cursor moved besides, leaving them
    // somewhere they never stepped to once the send settled.
    const settleCalls: string[] = [];
    let releaseSecondCall: () => void = () => undefined;
    const secondPending = new Promise<void>((resolve) => {
      releaseSecondCall = resolve;
    });
    const draftStore = new DraftStore({
      maximumDraftCount: MAXIMUM_LIVE_DRAFT_COUNT,
    });
    const { line } = mountBar({
      // The registered reply, not `undefined`: the router parses what comes back, so
      // an unparseable answer settles as a refusal, records nothing sent, and would
      // leave this case asserting against an EMPTY walk — green whether the guard is
      // there or not.
      bridge: bridgeAnswering(async () => {
        settleCalls.push("run.queueCreate");
        if (settleCalls.length > 1) {
          await secondPending;
        }
        return QUEUE_CREATED;
      }).bridge,
      draftStore,
      sessionStore: openSessionStore(),
    });

    // A settled send first, because the walk has nothing to recall until one lands.
    fireEvent.change(line, { target: { value: "first" } });
    await act(async () => {
      fireEvent.keyDown(line, { key: "Enter" });
    });
    expect(line.value).toBe("");

    fireEvent.change(line, { target: { value: "second" } });
    await act(async () => {
      fireEvent.keyDown(line, { key: "Enter" });
    });
    expect(line.readOnly).toBe(true);

    line.setSelectionRange(0, 0);
    await act(async () => {
      fireEvent.keyDown(line, { key: "ArrowUp" });
    });
    // The negative control: unguarded, this reads "first" — the recalled message.
    expect(line.value).toBe("second");

    await act(async () => {
      releaseSecondCall();
      await secondPending;
    });

    // And the walk is live rather than merely empty: the same key at the same offset
    // recalls the moment the line is writable again.
    line.setSelectionRange(0, 0);
    await act(async () => {
      fireEvent.keyDown(line, { key: "ArrowUp" });
    });
    expect(line.value).toBe("second");
    expect(settleCalls).toHaveLength(2);
  });

  it("accepts the next send once the first has settled", async () => {
    // The negative control for the latch itself: it releases in `finally`, so a
    // wedged latch would make the composer send exactly once per window.
    const settleCalls: string[] = [];
    const draftStore = new DraftStore({
      maximumDraftCount: MAXIMUM_LIVE_DRAFT_COUNT,
    });
    const { line } = mountBar({
      bridge: bridgeAnswering(async ({ method }) => {
        settleCalls.push(method);
        return undefined;
      }).bridge,
      draftStore,
      sessionStore: openSessionStore(),
    });

    for (const body of ["first", "second"]) {
      fireEvent.change(line, { target: { value: body } });
      await act(async () => {
        fireEvent.keyDown(line, { key: "Enter" });
      });
    }
    expect(settleCalls).toHaveLength(2);
  });
});

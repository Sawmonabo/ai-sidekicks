// The message line, Send, and the draft beneath them: an unsent body lives in the supplied
// draft store, so a send that did not land must leave what the person wrote (a line with its
// own copy would lose it). Two presses inside one frame send once.

import { act, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MAXIMUM_LIVE_DRAFT_COUNT } from "@renderer/store/persistence-caps.js";
import { DraftStore } from "@renderer/store/draft-store.js";
import { QUEUE_CREATED, sendCallsAnswering } from "../send-router.test-support.js";
import {
  FIRST_AGENT_ID,
  SECOND_AGENT_ID,
  answerSteer,
  mountAddressable,
  mountDraftLine,
  openSessionStore,
  pressSend,
} from "./DraftLine.test-support.js";

describe("DraftLine — the unsent body lives in the supplied draft store", () => {
  it("restores the text a remount would otherwise have thrown away", () => {
    const draftStore = new DraftStore({
      maximumDraftCount: MAXIMUM_LIVE_DRAFT_COUNT,
    });
    const sessionStore = openSessionStore();
    const calls = sendCallsAnswering(async () => undefined);

    const first = mountDraftLine({ calls, draftStore, sessionStore });
    fireEvent.change(first.line, { target: { value: "half a thought" } });
    first.result.unmount();

    const second = mountDraftLine({ calls, draftStore, sessionStore });
    expect(second.line.value).toBe("half a thought");
  });

  it("swaps drafts on an address change rather than carrying text to the new target", () => {
    const bar = mountAddressable(sendCallsAnswering(async () => undefined));
    fireEvent.change(bar.line(), { target: { value: "for the first agent" } });

    // A different composer address in the same window: its own key, its own draft.
    bar.address(SECOND_AGENT_ID);
    expect(bar.line().value).toBe("");

    // …and the first address still holds what was written for it.
    bar.address(FIRST_AGENT_ID);
    expect(bar.line().value).toBe("for the first agent");
  });

  it("clears the draft once the send has settled, and not before", async () => {
    const draftStore = new DraftStore({
      maximumDraftCount: MAXIMUM_LIVE_DRAFT_COUNT,
    });
    const sessionStore = openSessionStore();
    const settle = vi.fn(async () => QUEUE_CREATED);

    const { line, result } = mountDraftLine({
      calls: sendCallsAnswering(settle),
      draftStore,
      sessionStore,
    });
    fireEvent.change(line, { target: { value: "ship it" } });
    await act(async () => {
      pressSend(result.container);
    });

    expect(settle).toHaveBeenCalledTimes(1);
    expect(line.value).toBe("");
    result.unmount();
    // A settled send leaves nothing for the next mount to restore.
    expect(
      mountDraftLine({ calls: sendCallsAnswering(settle), draftStore, sessionStore }).line.value,
    ).toBe("");
  });
});

describe("DraftLine — a rejected steer keeps the message in the line", () => {
  it("leaves the text and renders the daemon's cause", async () => {
    // Nothing in the reply says the message traveled, so the line must not clear for an
    // intervention the run declined.
    const bar = mountAddressable(
      sendCallsAnswering(async ({ method }) =>
        method === "run.intervene"
          ? {
              interventionId: "6f708192-0314-4526-8738-bc9d0e1f2a34",
              interventionType: "steer",
              state: "rejected",
              runVersion: 4,
              rejectionReason: "run.invalid_transition",
            }
          : undefined,
      ),
    );

    fireEvent.change(bar.line(), { target: { value: "keep going on the parser" } });
    await act(async () => {
      pressSend(bar.result.container);
    });

    expect(bar.line().value).toBe("keep going on the parser");
    const refusal = bar.result.container.querySelector(".meridian-refusal--inline");
    expect(refusal?.textContent).toContain("The run did not take this steer, so nothing was sent.");
    expect(refusal?.textContent).toContain("still in the line");
  });

  it("negative control: the same send against an applied answer clears the line", async () => {
    // Without this, the case above would pass a bar that never clears the draft at all.
    const bar = mountAddressable(sendCallsAnswering(answerSteer));

    fireEvent.change(bar.line(), { target: { value: "keep going on the parser" } });
    await act(async () => {
      pressSend(bar.result.container);
    });

    expect(bar.line().value).toBe("");
    expect(bar.result.container.querySelector(".meridian-refusal--inline")).toBeNull();
  });
});

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

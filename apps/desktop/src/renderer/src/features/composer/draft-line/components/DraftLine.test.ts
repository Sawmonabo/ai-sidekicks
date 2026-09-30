// The message line, Send, and the draft beneath them: an unsent body lives in the supplied
// draft store, so a send that did not land must leave what the person wrote (a line with its
// own copy would lose it). Enter belongs to neither; the line takes it and sends nothing.

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
  mountLine,
  openSessionStore,
  pressSend,
} from "./draft-line.test-support.js";

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

describe("DraftLine — the line without Send", () => {
  it("takes typing into the draft store, and Enter keeps it as typed and draws nothing", () => {
    const draftStore = new DraftStore({ maximumDraftCount: MAXIMUM_LIVE_DRAFT_COUNT });
    const { line, result } = mountLine({ draftStore, sessionStore: openSessionStore() });

    fireEvent.change(line, { target: { value: "/workflow start nightly" } });
    const wasLeftToTheBrowser = fireEvent.keyDown(line, { key: "Enter" });

    // A canceled key event is the line taking Enter: no newline goes into the field.
    expect(wasLeftToTheBrowser).toBe(false);
    expect(line.value).toBe("/workflow start nightly");
    expect(result.container.querySelector(".meridian-refusal")).toBeNull();
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
    expect(refusal?.textContent).toContain("run.invalid_transition");
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

describe("DraftLine — a refusal about the whole session leaves the bar", () => {
  /** Calls whose steer is rejected with one daemon reason. */
  function callsRejectingWith(rejectionReason: string): ReturnType<typeof sendCallsAnswering> {
    return sendCallsAnswering(async () => ({
      interventionId: "6f708192-0314-4526-8738-bc9d0e1f2a34",
      interventionType: "steer",
      state: "rejected",
      runVersion: 4,
      rejectionReason,
    }));
  }

  /** Type one line and send it, against a bar over `calls` addressed at a steerable run. */
  function sendAgainst(
    calls: ReturnType<typeof sendCallsAnswering>,
  ): ReturnType<typeof mountAddressable> {
    const bar = mountAddressable(calls);
    fireEvent.change(bar.line(), { target: { value: "worth keeping" } });
    return bar;
  }

  it("raises the frame's banner while the composer keeps the daemon's words", async () => {
    // A session that has left the node is the whole window's fact, so the bar hands it to the
    // frame; the line and the card stay, since the person's words are unsent.
    const bar = sendAgainst(callsRejectingWith("session.not_found"));

    await act(async () => {
      pressSend(bar.result.container);
    });

    expect(bar.frameStore.getState().banners.map((banner) => banner.code)).toStrictEqual([
      "session.not_found",
    ]);
    expect(bar.line().value).toBe("worth keeping");
    expect(bar.result.container.textContent).toContain("session.not_found");
  });

  it("negative control: a refusal about this send alone raises no banner", async () => {
    // Without this, the case above would pass a bar that escalated every refused send.
    const bar = sendAgainst(callsRejectingWith("ratelimit.exceeded"));

    await act(async () => {
      pressSend(bar.result.container);
    });

    expect(bar.frameStore.getState().banners).toStrictEqual([]);
    expect(bar.result.container.textContent).toContain("ratelimit.exceeded");
  });
});

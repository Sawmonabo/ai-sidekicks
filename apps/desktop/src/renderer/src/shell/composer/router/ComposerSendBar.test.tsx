// The send bar and the draft beneath it: where an unsent body lives, and what a
// refused send leaves in the line.
//
// The two claims are one claim read twice. The bar owns no text — the supplied draft
// store does — so a send that did not land must leave the store holding what the
// person wrote, and a bar with its own copy would pass the first case and lose the
// words in the second.

import { act, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DraftStore } from "../../../console/persistence/index.js";
import { bridgeAnswering } from "../../../console/bridge/fixture-bridge.test-support.js";
import { CHANNEL_ID, QUEUE_CREATED } from "./send-router.test-support.js";
import {
  answerSteer,
  mountAddressable,
  mountBar,
  openSessionStore,
} from "./composer-send-bar.test-support.js";

describe("ComposerSendBar — the unsent body lives in the supplied draft store", () => {
  it("restores the text a remount would otherwise have thrown away", () => {
    const draftStore = new DraftStore({ restartNoticePending: false });
    const sessionStore = openSessionStore();
    const bridge = bridgeAnswering(async () => undefined).bridge;

    const first = mountBar({ bridge, draftStore, sessionStore });
    fireEvent.change(first.line, { target: { value: "half a thought" } });
    first.result.unmount();

    const second = mountBar({ bridge, draftStore, sessionStore });
    expect(second.line.value).toBe("half a thought");
  });

  it("swaps drafts on an address change rather than carrying text to the new target", () => {
    const draftStore = new DraftStore({ restartNoticePending: false });
    const sessionStore = openSessionStore();
    const bridge = bridgeAnswering(async () => undefined).bridge;

    const onChannel = mountBar({ bridge, draftStore, sessionStore });
    fireEvent.change(onChannel.line, { target: { value: "for the session" } });
    onChannel.result.unmount();

    // A different composer address in the same window: its own key, its own draft.
    const onNamedChannel = mountBar({
      bridge,
      draftStore,
      sessionStore,
      focusedPane: { kind: "timeline", entity: { kind: "channel", id: CHANNEL_ID } },
    });
    expect(onNamedChannel.line.value).toBe("");
    onNamedChannel.result.unmount();

    // …and the first address still holds what was written for it.
    expect(mountBar({ bridge, draftStore, sessionStore }).line.value).toBe("for the session");
  });

  it("clears the draft once the send has settled, and not before", async () => {
    const draftStore = new DraftStore({ restartNoticePending: false });
    const sessionStore = openSessionStore();
    const settle = vi.fn(async () => QUEUE_CREATED);

    const { line, result } = mountBar({
      bridge: bridgeAnswering(settle).bridge,
      draftStore,
      sessionStore,
    });
    fireEvent.change(line, { target: { value: "ship it" } });
    await act(async () => {
      fireEvent.keyDown(line, { key: "Enter" });
    });

    expect(settle).toHaveBeenCalledTimes(1);
    expect(line.value).toBe("");
    result.unmount();
    // The negative control for the persistence claim above: a settled send leaves
    // nothing for the next mount to restore.
    expect(
      mountBar({ bridge: bridgeAnswering(settle).bridge, draftStore, sessionStore }).line.value,
    ).toBe("");
  });

  it("keeps the body under its key when the daemon refuses the send", async () => {
    const draftStore = new DraftStore({ restartNoticePending: false });
    const sessionStore = openSessionStore();
    const { line, result } = mountBar({
      // The flat wire envelope the daemon's rejection actually carries — a dotted
      // code beside its own sentence — rather than a shape invented for this case.
      // The call door reads it (`core/wire-rejection.ts`), so what the surface
      // renders is the daemon's code and the daemon's words, neither paraphrased.
      bridge: bridgeAnswering(async () => {
        throw Object.assign(new Error("queue is full"), { code: "ratelimit.exceeded" });
      }).bridge,
      draftStore,
      sessionStore,
    });

    fireEvent.change(line, { target: { value: "worth keeping" } });
    await act(async () => {
      fireEvent.keyDown(line, { key: "Enter" });
    });

    expect(line.value).toBe("worth keeping");
    expect(result.container.textContent).toContain("queue is full");
  });
});

describe("ComposerSendBar — a rejected steer keeps the message in the line", () => {
  it("leaves the text and renders the daemon's cause", async () => {
    // The finding at the surface: fulfilment was treated as success, so the line
    // emptied and the participant's words were gone for an intervention the run had
    // declined. Nothing about the reply says the message travelled, so nothing about
    // the composer may say so either.
    const bar = mountAddressable(
      bridgeAnswering(async ({ method }) =>
        method === "run.intervene"
          ? {
              interventionId: "6f708192-0314-4526-8738-bc9d0e1f2a34",
              interventionType: "steer",
              state: "rejected",
              runVersion: 4,
              rejectionReason: "run.invalid_transition",
            }
          : undefined,
      ).bridge,
    );

    fireEvent.change(bar.line(), { target: { value: "keep going on the parser" } });
    await act(async () => {
      fireEvent.keyDown(bar.line(), { key: "Enter" });
    });

    expect(bar.line().value).toBe("keep going on the parser");
    const refusal = bar.result.container.querySelector(".meridian-refusal--inline");
    expect(refusal?.textContent).toContain("run.invalid_transition");
    expect(refusal?.textContent).toContain("still in the line");
  });

  it("negative control: the same send against an applied answer clears the line", async () => {
    // Without this the case above would hold over a bar that had stopped clearing
    // the draft at all, which loses the send state rather than preserving the text.
    const bar = mountAddressable(bridgeAnswering(answerSteer).bridge);

    fireEvent.change(bar.line(), { target: { value: "keep going on the parser" } });
    await act(async () => {
      fireEvent.keyDown(bar.line(), { key: "Enter" });
    });

    expect(bar.line().value).toBe("");
    expect(bar.result.container.querySelector(".meridian-refusal--inline")).toBeNull();
  });
});

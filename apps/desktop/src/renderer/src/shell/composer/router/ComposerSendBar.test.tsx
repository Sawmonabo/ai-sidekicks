// What the send bar keeps, what it sends, and what it will not send twice.
//
// Every case drives the real bar over the real `SessionStore`, the real
// `DraftStore`, and a bridge whose `daemon.call` is the one thing under the test's
// control — a stand-in controller would let the bar read state the shipped
// composition cannot produce, which is exactly the class of defect these cover.

import { act, fireEvent, render, type RenderResult } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ConsoleBridge } from "../../../console/bridge/index.js";
import { DEFAULT_ROUTE } from "../../../console/routing/index.js";
import { DraftStore } from "../../../console/persistence/index.js";
import { SessionStore } from "../../../console/store/index.js";
import type { ConsolePaneAddress } from "../../../console/workspace/index.js";
import { ComposerSendBar } from "./ComposerSendBar.js";

const SESSION_ID = "0a1b2c3d-4e5f-4061-8273-9a4b5c6d7e8f";
const CHANNEL_ID = "1b2c3d4e-5f60-4172-8384-ab5c6d7e8f90";

/** A bridge whose daemon call the case owns. Nothing else here reaches the wire. */
function stubBridge(call: (method: string, params: unknown) => Promise<unknown>): ConsoleBridge {
  return {
    sidekicks: { daemon: { call, subscribe: () => () => undefined } },
    growth: {},
    growthServedOperations: new Set(),
    source: "fixture",
    scenarioEngine: undefined,
  } as unknown as ConsoleBridge;
}

function openSessionStore(): SessionStore {
  const sessionStore = new SessionStore({ sessionId: SESSION_ID });
  sessionStore.initialise({ cursor: 0, entities: [], participantJoinLog: ["participant-you"] });
  return sessionStore;
}

interface MountedBar {
  readonly result: RenderResult;
  readonly line: HTMLTextAreaElement;
}

function mountBar(options: {
  readonly bridge: ConsoleBridge;
  readonly draftStore: DraftStore;
  readonly sessionStore: SessionStore;
  readonly focusedPane?: ConsolePaneAddress | undefined;
}): MountedBar {
  const result = render(
    <ComposerSendBar
      sessionStore={options.sessionStore}
      bridge={options.bridge}
      draftStore={options.draftStore}
      route={DEFAULT_ROUTE}
      focusedPane={options.focusedPane}
    />,
  );
  const line = result.container.querySelector("textarea");
  if (!(line instanceof HTMLTextAreaElement)) {
    throw new Error("the send bar rendered no directive line");
  }
  return { result, line };
}

describe("ComposerSendBar — the unsent body lives in the supplied draft store", () => {
  it("restores the text a remount would otherwise have thrown away", () => {
    const draftStore = new DraftStore({ restartNoticePending: false });
    const sessionStore = openSessionStore();
    const bridge = stubBridge(async () => undefined);

    const first = mountBar({ bridge, draftStore, sessionStore });
    fireEvent.change(first.line, { target: { value: "half a thought" } });
    first.result.unmount();

    const second = mountBar({ bridge, draftStore, sessionStore });
    expect(second.line.value).toBe("half a thought");
  });

  it("swaps drafts on an address change rather than carrying text to the new target", () => {
    const draftStore = new DraftStore({ restartNoticePending: false });
    const sessionStore = openSessionStore();
    const bridge = stubBridge(async () => undefined);

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
    const settle = vi.fn(async () => undefined);

    const { line, result } = mountBar({
      bridge: stubBridge(settle),
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
    expect(mountBar({ bridge: stubBridge(settle), draftStore, sessionStore }).line.value).toBe("");
  });

  it("keeps the body under its key when the daemon refuses the send", async () => {
    const draftStore = new DraftStore({ restartNoticePending: false });
    const sessionStore = openSessionStore();
    const { line, result } = mountBar({
      bridge: stubBridge(async () => {
        throw Object.assign(new Error("queue is full"), {
          refusal: { code: "ratelimit.exceeded", message: "queue is full" },
        });
      }),
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

describe("ComposerSendBar — the store's restart disclosure, once", () => {
  it("shows the store's own sentence and clears it on the first focus", () => {
    const draftStore = new DraftStore();
    const sessionStore = openSessionStore();
    const bridge = stubBridge(async () => undefined);

    const first = mountBar({ bridge, draftStore, sessionStore });
    expect(first.result.container.textContent).toContain(draftStore.restartNoticeText);

    fireEvent.focus(first.line);
    expect(first.result.container.textContent).not.toContain(draftStore.restartNoticeText);
    expect(draftStore.restartNoticePending).toBe(false);

    // Once per window, not once per mount: a second composer never repeats it.
    first.result.unmount();
    const second = mountBar({ bridge, draftStore, sessionStore });
    expect(second.result.container.textContent).not.toContain(draftStore.restartNoticeText);
  });

  it("negative control: a store that owes no disclosure renders none at all", () => {
    const draftStore = new DraftStore({ restartNoticePending: false });
    const { result } = mountBar({
      bridge: stubBridge(async () => undefined),
      draftStore,
      sessionStore: openSessionStore(),
    });
    expect(result.container.querySelector(".meridian-composer__notice")).toBeNull();
  });
});

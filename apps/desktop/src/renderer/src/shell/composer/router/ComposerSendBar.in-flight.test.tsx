// One act at a time: what the bar does while a send or an interrupt is still open.
//
// Its own file because in-flight is a state rather than an outcome, and the two acts
// hold it differently — an interrupt is a stop the person may want to repeat and a
// send is not. Both cases are about the window between dispatch and settlement,
// which is the one a fast pair of presses actually meets.

import { act, fireEvent } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DraftStore } from "../../../console/persistence/index.js";
import {
  mountAddressable,
  mountBar,
  openSessionStore,
  stubBridge,
} from "./composer-send-bar.test-support.js";

describe("ComposerSendBar — one interrupt in flight", () => {
  function stopButton(container: HTMLElement): HTMLButtonElement {
    const stop = container.querySelector(".meridian-composer__stop");
    if (!(stop instanceof HTMLButtonElement)) {
      throw new Error("the send bar drew no stop control");
    }
    return stop;
  }

  it("issues one interrupt for two presses inside one frame", async () => {
    // `driver.interruptRun` is not idempotent, and both presses run before React
    // re-renders, so both read the same rendered state. Without the controller's
    // synchronous latch the stub is called twice: the first retires the turn and the
    // duplicate refuses with no live run, beside an interrupt that worked.
    const calls: string[] = [];
    let releaseFirstCall: () => void = () => undefined;
    const pending = new Promise<void>((resolve) => {
      releaseFirstCall = resolve;
    });
    const bar = mountAddressable(
      stubBridge(async (method) => {
        calls.push(method);
        await pending;
        return undefined;
      }),
    );

    await act(async () => {
      stopButton(bar.result.container).click();
      stopButton(bar.result.container).click();
    });
    expect(calls).toStrictEqual(["driver.interruptRun"]);
    expect(stopButton(bar.result.container).disabled).toBe(true);
    expect(stopButton(bar.result.container).getAttribute("aria-busy")).toBe("true");

    await act(async () => {
      releaseFirstCall();
      await pending;
    });
    expect(calls).toStrictEqual(["driver.interruptRun"]);
    // The negative control for the latch itself: it releases in `finally`, so a
    // wedged one would make the composer stoppable exactly once per window.
    expect(stopButton(bar.result.container).disabled).toBe(false);
  });

  it("renders the daemon's refusal when the interrupt is refused", async () => {
    const bar = mountAddressable(
      stubBridge(async () => {
        throw { code: "run.not_running", message: "there is no live run" };
      }),
    );

    await act(async () => {
      stopButton(bar.result.container).click();
    });

    expect(bar.result.container.textContent).toContain("there is no live run");
    expect(stopButton(bar.result.container).disabled).toBe(false);
  });

  it("stays reachable while a send is in flight, which is what it is for", async () => {
    // Deliberately not the send latch: a person interrupting a turn is escaping the
    // state a pending send is part of, and sharing the latch would put the control
    // behind it.
    const calls: string[] = [];
    let releaseSend: () => void = () => undefined;
    const sendPending = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const bar = mountAddressable(
      stubBridge(async (method) => {
        calls.push(method);
        if (method === "run.intervene") {
          await sendPending;
        }
        return undefined;
      }),
    );

    fireEvent.change(bar.line(), { target: { value: "keep going" } });
    await act(async () => {
      fireEvent.keyDown(bar.line(), { key: "Enter" });
    });
    expect(calls).toStrictEqual(["run.intervene"]);

    await act(async () => {
      stopButton(bar.result.container).click();
    });
    expect(calls).toStrictEqual(["run.intervene", "driver.interruptRun"]);

    await act(async () => {
      releaseSend();
      await sendPending;
    });
  });
});

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
    const draftStore = new DraftStore({ restartNoticePending: false });
    const { line } = mountBar({
      bridge: stubBridge(async (method) => {
        settleCalls.push(method);
        await pending;
        return undefined;
      }),
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
    const draftStore = new DraftStore({ restartNoticePending: false });
    const { line, result } = mountBar({
      bridge: stubBridge(async (method) => {
        settleCalls.push(method);
        await pending;
        return undefined;
      }),
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

  it("accepts the next send once the first has settled", async () => {
    // The negative control for the latch itself: it releases in `finally`, so a
    // wedged latch would make the composer send exactly once per window.
    const settleCalls: string[] = [];
    const draftStore = new DraftStore({ restartNoticePending: false });
    const { line } = mountBar({
      bridge: stubBridge(async (method) => {
        settleCalls.push(method);
        return undefined;
      }),
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

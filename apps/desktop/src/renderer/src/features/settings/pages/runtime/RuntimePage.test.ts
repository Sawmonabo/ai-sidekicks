// The local-runtime page: the two controls that confirm, and the daemon's reported line.
//
// The page names what a control will interrupt before acting, dispatches once per answered
// confirmation, and asks the daemon's reported line again once it can have changed. That last
// is two claims: a read that never happens again leaves a stopped runtime beside `Reported
// state: connected`, while a read on every render or every supervisor retry is an interval
// poll. The cases drive a settled control and a
// supervisor transition, and an advancing retry attempt that must change nothing.

import { act, fireEvent, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createFixtureBridge } from "@renderer/services/platform/platform-bridge.fixture.js";
import { unscriptedScenario } from "@test/helpers/fixture-bridge.js";
import { settle } from "@test/helpers/settle.js";
import { UNREPORTED_MAIN_PROCESS_STATE } from "@renderer/store/window/main-process-state.js";
import type { DaemonOperations } from "./hooks/useDaemonStatus.js";
import { useDaemonControl } from "./hooks/useDaemonControl.js";
import { getButton, renderRuntimePage } from "./runtime-page.test-support.js";

describe("DaemonPage — the reported status", () => {
  it("asks the runtime again once a control settles", async () => {
    // Guards a stale reply: a stop that was accepted changes what the runtime would answer,
    // and a page holding the pre-control reply would show a stopped supervisor beside
    // `Reported state: connected` for the rest of the visit.
    const { container, ledger } = renderRuntimePage({});
    await waitFor(() => {
      expect(container.textContent).toContain("2026-04-30-read-1");
    });

    fireEvent.click(getButton(container, "Stop"));
    fireEvent.click(getButton(container, "Stop"));

    await waitFor(() => {
      expect(container.textContent).toContain("2026-04-30-read-2");
    });
    expect(ledger.calls).toStrictEqual(["stop"]);
  });

  it("asks the runtime again when the supervisor moves under the window", async () => {
    const { container, ledger, showMainProcessState } = renderRuntimePage({
      mainProcessState: { ...UNREPORTED_MAIN_PROCESS_STATE, connection: { kind: "connected" } },
    });
    await waitFor(() => {
      expect(ledger.statusReads).toStrictEqual(["2026-04-30-read-1"]);
    });

    showMainProcessState({ ...UNREPORTED_MAIN_PROCESS_STATE, connection: { kind: "stopped" } });

    await waitFor(() => {
      expect(container.textContent).toContain("2026-04-30-read-2");
    });
  });

  it("negative control: a re-render and an advancing retry attempt ask nothing", async () => {
    // Both halves of the anti-poll claim: a page re-reading on every render would pass the
    // two cases above, and keying the read on the whole connection would put one call per
    // supervisor retry, which is polling in another form.
    const { ledger, showMainProcessState } = renderRuntimePage({
      mainProcessState: {
        ...UNREPORTED_MAIN_PROCESS_STATE,
        connection: { kind: "reconnecting", attempt: 1, attemptLimit: 5 },
      },
    });
    await waitFor(() => {
      expect(ledger.statusReads).toStrictEqual(["2026-04-30-read-1"]);
    });

    showMainProcessState({
      ...UNREPORTED_MAIN_PROCESS_STATE,
      connection: { kind: "reconnecting", attempt: 2, attemptLimit: 5 },
      lastHeartbeatAt: "2026-01-01T10:00:00.000Z",
    });
    await settle();

    expect(ledger.statusReads).toStrictEqual(["2026-04-30-read-1"]);
  });
});

describe("DaemonPage — the two controls", () => {
  it("asks before stopping, naming what stops, and calls nothing yet", () => {
    const { container, ledger } = renderRuntimePage({});
    fireEvent.click(getButton(container, "Stop"));
    expect(ledger.calls).toStrictEqual([]);
    expect(container.textContent).toContain(
      "Stop the background service? Work in flight stops, and nothing new starts until it is running again.",
    );
  });

  it("releases the dispatch once a call settles, so the same control works again", async () => {
    // The single-flight latch must clear when the call ends, or the controls stay dead.
    const { container, ledger } = renderRuntimePage({});
    fireEvent.click(getButton(container, "Stop"));
    fireEvent.click(getButton(container, "Stop"));
    await waitFor(() => {
      expect(ledger.calls).toStrictEqual(["stop"]);
    });
    await settle();

    fireEvent.click(getButton(container, "Stop"));
    fireEvent.click(getButton(container, "Stop"));
    await waitFor(() => {
      expect(ledger.calls).toStrictEqual(["stop", "stop"]);
    });
  });

  it("hands a rejected call to the caller and still releases the dispatch", async () => {
    // A dispatch key that outlived a failed call would leave the destructive controls dead:
    // the second press must reach the call, and each failure must reach whoever pressed.
    const calls: string[] = [];
    const failure = new Error("the transport went away");
    const operations: DaemonOperations = {
      readStatus: () => Promise.resolve({ state: "connected", version: "unread" }),
      stop: () => {
        calls.push("stop");
        return Promise.reject(failure);
      },
      restart: () => Promise.resolve(),
    };
    const { bridge } = createFixtureBridge({ scenario: unscriptedScenario("daemon-page") });
    const { result } = renderHook(() => useDaemonControl(bridge, operations, vi.fn()));

    await act(async () => {
      await expect(result.current.put("stop")).rejects.toBe(failure);
    });
    await act(async () => {
      await expect(result.current.put("stop")).rejects.toBe(failure);
    });

    expect(calls).toStrictEqual(["stop", "stop"]);
  });

  it("dispatches once when the confirmation is answered twice in one frame", async () => {
    const { container, ledger } = renderRuntimePage({ holdsControls: true });
    fireEvent.click(getButton(container, "Stop"));
    const confirmAction = getButton(container, "Stop");

    // Both presses in one frame, which a rendered flag cannot catch: the second handler is
    // the one the first render produced and reads the page as idle. A double-click on a
    // destructive verb has this shape.
    act(() => {
      confirmAction.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      confirmAction.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await settle();

    // One confirmation is one intended act; a second stop lands against a runtime the first
    // is already taking down.
    expect(ledger.calls).toStrictEqual(["stop"]);
  });

  it("refuses both confirmation actions until the dispatch settles, and says why", () => {
    const { container } = renderRuntimePage({ holdsControls: true });
    fireEvent.click(getButton(container, "Restart"));
    fireEvent.click(getButton(container, "Restart"));

    expect(getButton(container, "Restart").disabled).toBe(true);
    // Cancel goes with it: nothing behind the bridge is cancelable, so a live Cancel
    // here would read as retracting a call that has already gone out.
    expect(getButton(container, "Cancel").disabled).toBe(true);
    expect(container.textContent).toContain("It cannot be taken back");
  });

  it("backs out on cancel without calling — the control", () => {
    const { container, ledger } = renderRuntimePage({});
    fireEvent.click(getButton(container, "Restart"));
    fireEvent.click(getButton(container, "Cancel"));
    expect(ledger.calls).toStrictEqual([]);
    expect(container.textContent).not.toContain("Restart the background service?");
  });
});

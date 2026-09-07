// The local-runtime page: the supervisor's numbers, and the two controls that confirm.
//
// The page's honesty rests on five things, and each has a case with its control:
// the numbers it shows are the ones it was told and never invented, a control names
// what it will interrupt before it does anything, a confirmation answered once
// dispatches once, a refused control says so instead of looking like it worked, and
// the daemon's own reported line is asked again once it can have changed.
//
// THE FIFTH IS TWO CLAIMS AT ONCE and needs both halves driven. A read that never
// happens again leaves a stopped runtime beside `Reported state: connected` for the
// rest of the visit; a read that happens on every render, or on every retry the
// supervisor's ladder makes, is the interval poll wearing a different coat. So the
// cases below drive a settled control and a supervisor transition — and the control
// drives an advancing retry ATTEMPT, which changes the state object and must change
// nothing else.
//
// WHAT THE PORT DOES WHEN IT BREAKS ITS OWN CONTRACT is `DaemonPage.rejections.test.tsx`
// beside this, over the same mount from `daemon-page.test-support.tsx`. Every case here
// drives a port that keeps it: it answers, and the answer is served or refused.

import { act, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { settle } from "../../../core/settle.test-support.js";
import { UNREPORTED_SHELL_STATE } from "../../../store/index.js";
import { getButton, renderPage } from "./daemon-page.test-support.js";

describe("DaemonPage — the supervisor's numbers", () => {
  it("says nothing was reported rather than inventing a state", () => {
    const { container } = renderPage({});
    expect(container.querySelector(".meridian-nothing--not-checked")).not.toBeNull();
    expect(container.textContent).not.toContain("Local runtime connected");
  });

  it("shows the attempt count while the ladder is running", () => {
    const { container } = renderPage({
      shellState: {
        ...UNREPORTED_SHELL_STATE,
        connection: { kind: "reconnecting", attempt: 3, attemptLimit: 5 },
      },
    });
    expect(container.textContent).toContain("Attempt");
    expect(container.textContent).toContain("3 of 5");
  });

  it("shows no attempt row on a connected window — the control", () => {
    // A row reading "attempt — of 5" on a healthy window would be a field with
    // nothing in it pretending to be a measurement.
    const { container } = renderPage({
      shellState: { ...UNREPORTED_SHELL_STATE, connection: { kind: "connected" } },
    });
    expect(container.textContent).not.toContain("Attempt");
  });

  it("shows the last heartbeat where one was reported, and its absence where none was", () => {
    const withBeat = renderPage({
      shellState: {
        ...UNREPORTED_SHELL_STATE,
        connection: { kind: "connected" },
        lastHeartbeatAt: "2026-01-01T10:00:00.000Z",
      },
    });
    expect(withBeat.container.textContent).toContain("2026-01-01T10:00:00.000Z");

    const withoutBeat = renderPage({
      shellState: { ...UNREPORTED_SHELL_STATE, connection: { kind: "connected" } },
    });
    expect(withoutBeat.container.textContent).toContain("No heartbeat reported");
  });
});

describe("DaemonPage — the reported status", () => {
  it("renders what the read answered", async () => {
    const { container } = renderPage({ servesStatus: true });
    await waitFor(() => {
      expect(container.textContent).toContain("2026-04-30-read-1");
    });
  });

  it("renders the refusal where the build carries no wire — the control", async () => {
    const { container } = renderPage({ servesStatus: false });
    await waitFor(() => {
      expect(container.textContent).toContain("wire-unregistered");
    });
  });

  it("asks the runtime again once a control settles", async () => {
    // The defect this pins: a stop that was accepted changes what the runtime would
    // answer, and a page holding the pre-control reply shows a stopped supervisor
    // beside its own `Reported state: connected` for the rest of the visit.
    const { container, ledger } = renderPage({});
    await waitFor(() => {
      expect(container.textContent).toContain("2026-04-30-read-1");
    });

    fireEvent.click(getButton(container, "Stop the local runtime"));
    fireEvent.click(getButton(container, "Stop the local runtime"));

    await waitFor(() => {
      expect(container.textContent).toContain("2026-04-30-read-2");
    });
    expect(ledger.calls).toStrictEqual(["stop"]);
  });

  it("asks the runtime again when the supervisor moves under the window", async () => {
    const { container, ledger, showShellState } = renderPage({
      shellState: { ...UNREPORTED_SHELL_STATE, connection: { kind: "connected" } },
    });
    await waitFor(() => {
      expect(ledger.statusReads).toStrictEqual(["2026-04-30-read-1"]);
    });

    showShellState({ ...UNREPORTED_SHELL_STATE, connection: { kind: "stopped" } });

    await waitFor(() => {
      expect(container.textContent).toContain("2026-04-30-read-2");
    });
  });

  it("negative control: a re-render and an advancing retry attempt ask nothing", async () => {
    // Both halves of the anti-poll claim. A page that re-read on every render would
    // satisfy the two cases above and put a call on the wire per pass — and keying the
    // read on the whole connection would put one per attempt of the supervisor's
    // ladder, which is interval polling arriving by the back door.
    const { ledger, showShellState } = renderPage({
      shellState: {
        ...UNREPORTED_SHELL_STATE,
        connection: { kind: "reconnecting", attempt: 1, attemptLimit: 5 },
      },
    });
    await waitFor(() => {
      expect(ledger.statusReads).toStrictEqual(["2026-04-30-read-1"]);
    });

    showShellState({
      ...UNREPORTED_SHELL_STATE,
      connection: { kind: "reconnecting", attempt: 2, attemptLimit: 5 },
      lastHeartbeatAt: "2026-01-01T10:00:00.000Z",
    });
    await settle();

    expect(ledger.statusReads).toStrictEqual(["2026-04-30-read-1"]);
  });
});

describe("DaemonPage — the two controls", () => {
  it("does not call anything until the consequence has been read", () => {
    const { container, ledger } = renderPage({});
    fireEvent.click(getButton(container, "Stop the local runtime"));
    expect(ledger.calls).toStrictEqual([]);
    expect(container.textContent).toContain("Every run on this machine ends");
  });

  it("calls only after the confirm", async () => {
    const { container, ledger } = renderPage({});
    fireEvent.click(getButton(container, "Stop the local runtime"));
    fireEvent.click(getButton(container, "Stop the local runtime"));
    await waitFor(() => {
      expect(ledger.calls).toStrictEqual(["stop"]);
    });
  });

  it("dispatches once when the confirmation is answered twice in one frame", async () => {
    const { container, ledger } = renderPage({ holdsControls: true });
    fireEvent.click(getButton(container, "Stop the local runtime"));
    const confirmAction = getButton(container, "Stop the local runtime");

    // Both presses in ONE frame, which is the case a rendered flag cannot catch: the
    // second handler is the one the first render produced, so it reads the surface as
    // idle however fast the re-render is. A double-click on a destructive verb is
    // exactly this shape.
    act(() => {
      confirmAction.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      confirmAction.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await settle();

    // One confirmation is one intended act, and two stops is not a slower version of
    // one — the second lands against a runtime the first is already taking down.
    expect(ledger.calls).toStrictEqual(["stop"]);
  });

  it("refuses both confirmation actions until the dispatch settles, and says why", () => {
    const { container } = renderPage({ holdsControls: true });
    fireEvent.click(getButton(container, "Restart the local runtime"));
    fireEvent.click(getButton(container, "Restart the local runtime"));

    expect(getButton(container, "Restart the local runtime").disabled).toBe(true);
    // Cancel goes with it: nothing behind the bridge is cancellable, so a live Cancel
    // here would read as retracting a call that has already gone out.
    expect(getButton(container, "Cancel").disabled).toBe(true);
    expect(container.textContent).toContain("It cannot be taken back");
  });

  it("offers both confirmation actions before it has been answered — the control", () => {
    const { container } = renderPage({ holdsControls: true });
    fireEvent.click(getButton(container, "Restart the local runtime"));

    expect(getButton(container, "Restart the local runtime").disabled).toBe(false);
    expect(getButton(container, "Cancel").disabled).toBe(false);
  });

  it("backs out on cancel without calling — the control", () => {
    const { container, ledger } = renderPage({});
    fireEvent.click(getButton(container, "Restart the local runtime"));
    fireEvent.click(getButton(container, "Cancel"));
    expect(ledger.calls).toStrictEqual([]);
    expect(container.textContent).not.toContain("Every run on this machine is interrupted");
  });

  it("says a control was sent rather than that it succeeded", async () => {
    const { container } = renderPage({});
    fireEvent.click(getButton(container, "Stop the local runtime"));
    fireEvent.click(getButton(container, "Stop the local runtime"));
    await waitFor(() => {
      expect(container.textContent).toContain("sent");
    });
    expect(container.textContent).not.toContain("stopped.");
  });

  it("renders a refused control's refusal", async () => {
    const { container } = renderPage({});
    fireEvent.click(getButton(container, "Restart the local runtime"));
    fireEvent.click(getButton(container, "Restart the local runtime"));
    await waitFor(() => {
      expect(container.textContent).toContain("wire-unregistered");
    });
  });

  it("offers no start control — starting is a shell act and not a call", () => {
    const { container } = renderPage({
      shellState: { ...UNREPORTED_SHELL_STATE, connection: { kind: "stopped" } },
    });
    const labels = [...container.querySelectorAll("button")].map((button) => button.textContent);
    expect(labels).not.toContain("Start the local runtime");
  });
});

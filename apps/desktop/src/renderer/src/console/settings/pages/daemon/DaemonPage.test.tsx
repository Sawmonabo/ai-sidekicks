// The local-runtime page: the supervisor's numbers, and the two controls that confirm.
//
// The page's honesty rests on four things, and each has a case with its control:
// the numbers it shows are the ones it was told and never invented, a control names
// what it will interrupt before it does anything, a confirmation answered once
// dispatches once, and a refused control says so instead of looking like it worked.

import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ConsoleBridge } from "../../../bridge/index.js";
import { createRefusingGrowthPort } from "../../../bridge/growth-port/growth-port.js";
import { settle } from "../../../core/settle.test-support.js";
import { UNREPORTED_SHELL_STATE, type ShellState } from "../../../store/index.js";
import { settingsPageContextWith } from "../../settings-page-mount.test-support.js";
import { DaemonPage } from "./DaemonPage.js";

/** The calls a case wants to see, in the order they were made. */
interface ControlLedger {
  readonly calls: string[];
}

/** How a case wants the port underneath the page to behave. */
interface PortScript {
  readonly servesStatus: boolean;
  /**
   * Whether a dispatched control is recorded and then never answered.
   *
   * The two double-press cases are about the window BETWEEN the dispatch and its
   * settlement, and a port that answers on the next microtask closes that window
   * before an assertion can read it — so those cases hold it open instead of racing.
   */
  readonly holdsControls: boolean;
}

function bridgeWith(ledger: ControlLedger, script: PortScript): ConsoleBridge {
  const holdOpen = async (): Promise<void> => {
    if (script.holdsControls) {
      await new Promise<void>(() => undefined);
    }
  };
  const growth = {
    ...createRefusingGrowthPort(),
    daemonStatusRead: async () =>
      script.servesStatus
        ? ({ status: "served", value: { state: "connected", version: "2026-04-30" } } as const)
        : await createRefusingGrowthPort().daemonStatusRead({}),
    daemonStop: async () => {
      ledger.calls.push("stop");
      await holdOpen();
      return { status: "served", value: undefined } as const;
    },
    daemonRestart: async () => {
      ledger.calls.push("restart");
      await holdOpen();
      return await createRefusingGrowthPort().daemonRestart({});
    },
  };
  return { growth } as unknown as ConsoleBridge;
}

function renderPage(options: {
  readonly shellState?: ShellState;
  readonly servesStatus?: boolean;
  readonly holdsControls?: boolean;
  readonly ledger?: ControlLedger;
}): { readonly container: HTMLElement; readonly ledger: ControlLedger } {
  const ledger = options.ledger ?? { calls: [] };
  const context = settingsPageContextWith(
    bridgeWith(ledger, {
      servesStatus: options.servesStatus ?? true,
      holdsControls: options.holdsControls ?? false,
    }),
    undefined,
    undefined,
    options.shellState ?? UNREPORTED_SHELL_STATE,
  );
  const { container } = render(<DaemonPage context={context} />);
  return { container, ledger };
}

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
      expect(container.textContent).toContain("2026-04-30");
    });
  });

  it("renders the refusal where the build carries no wire — the control", async () => {
    const { container } = renderPage({ servesStatus: false });
    await waitFor(() => {
      expect(container.textContent).toContain("wire-unregistered");
    });
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

/** The button a case presses, found by its own label. */
function getButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === label,
  );
  if (button === undefined) {
    throw new Error(`no button labelled ${label}`);
  }
  return button;
}

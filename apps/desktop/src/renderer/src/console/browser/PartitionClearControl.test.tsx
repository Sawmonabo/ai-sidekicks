// The control that has to be there for the partition that needs it most.
//
// The case these cover is the one a status chip alone gets wrong: a partition whose
// pane is open is exactly the partition an operator came to this page to clear, and a
// page that swaps the control for a chip there tells them the state and gives them no
// way out of it. So the first case asserts the control is PRESENT under an open pane,
// and the rest assert that the act it runs closes first, stops at whichever step
// refused, and says which step it is waiting on while it waits.

import { render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { refuse, type ConsoleRefusal } from "../core/index.js";
import { PartitionClearControl, type PartitionClearControlProps } from "./PartitionClearControl.js";
import type { SiteDataAct, SiteDataActOutcome } from "./site-data-clear.js";

const SESSION_ID = "session-07";

const PANE_HELD_OPEN: ConsoleRefusal = refuse(
  "browser",
  "browser.pane_busy",
  "The pane is mid-navigation and would not close.",
);

const PROJECTED_FAILURE: ConsoleRefusal = refuse(
  "browser",
  "browser.partition_stale",
  "An earlier clear left the directory half removed.",
);

const mountedControls: HTMLElement[] = [];

function servingAct(callLog: string[], name: string): SiteDataAct {
  return (sessionId) => {
    callLog.push(`${name}:${sessionId}`);
    return Promise.resolve({ status: "done" });
  };
}

function renderControl(overrides: Partial<PartitionClearControlProps>): HTMLElement {
  const { container } = render(
    <PartitionClearControl
      sessionId={SESSION_ID}
      hasOpenPane={false}
      lastClearRefusal={undefined}
      onClosePane={undefined}
      onClearSiteData={undefined}
      {...overrides}
    />,
  );
  const control = container.querySelector(".meridian-browser-partitions__control");
  if (!(control instanceof HTMLElement)) {
    throw new Error("PartitionClearControl rendered no control");
  }
  mountedControls.push(control);
  return control;
}

/** An act held open, so the control can be read mid-step. */
function pendingAct(): { readonly promise: Promise<SiteDataActOutcome>; succeed(): void } {
  let resolveOutcome: () => void = () => undefined;
  const promise = new Promise<SiteDataActOutcome>((resolve) => {
    resolveOutcome = () => {
      resolve({ status: "done" });
    };
  });
  return {
    promise,
    succeed: () => {
      resolveOutcome();
    },
  };
}

function confirmButton(control: HTMLElement): HTMLButtonElement {
  const button = [...control.querySelectorAll("button")].find((candidate) =>
    (candidate.textContent ?? "").includes("Clear this session"),
  );
  if (button === undefined) {
    throw new Error("no confirm button is offered");
  }
  return button;
}

afterEach(() => {
  mountedControls.length = 0;
});

describe("PartitionClearControl — an open partition still gets its control", () => {
  it("keeps the armed control beside the chip that says a pane is open", () => {
    const control = renderControl({
      hasOpenPane: true,
      onClosePane: servingAct([], "close"),
      onClearSiteData: servingAct([], "clear"),
    });

    expect(control.textContent).toContain("A pane still has this partition open");
    expect(control.querySelector("details.meridian-browser-arm")).not.toBeNull();
    expect(confirmButton(control)).toBeInstanceOf(HTMLButtonElement);
  });

  it("says the confirm will close the pane before it clears", () => {
    const control = renderControl({
      hasOpenPane: true,
      onClosePane: servingAct([], "close"),
      onClearSiteData: servingAct([], "clear"),
    });

    expect(control.textContent).toContain("closes that pane first");
  });

  it("negative control: a closed partition is offered no pane sentence and no chip", () => {
    // Without this, the two cases above would pass over a control that showed the
    // open-pane wording to every partition on the page.
    const control = renderControl({ onClearSiteData: servingAct([], "clear") });

    expect(control.textContent).not.toContain("A pane still has this partition open");
    expect(control.textContent).not.toContain("closes that pane first");
  });
});

describe("PartitionClearControl — running the act", () => {
  it("closes the pane and then clears, in that order", async () => {
    const callLog: string[] = [];
    const control = renderControl({
      hasOpenPane: true,
      onClosePane: servingAct(callLog, "close"),
      onClearSiteData: servingAct(callLog, "clear"),
    });

    confirmButton(control).click();

    await waitFor(() => {
      expect(callLog).toStrictEqual([`close:${SESSION_ID}`, `clear:${SESSION_ID}`]);
    });
  });

  it("negative control: a closed partition's confirm never dispatches a close", async () => {
    // A control that always closed first would tear down a pane that does not exist,
    // and every ordering assertion above would still be green.
    const callLog: string[] = [];
    const control = renderControl({
      onClosePane: servingAct(callLog, "close"),
      onClearSiteData: servingAct(callLog, "clear"),
    });

    confirmButton(control).click();

    await waitFor(() => {
      expect(callLog).toStrictEqual([`clear:${SESSION_ID}`]);
    });
  });

  it("renders the close's own refusal and clears nothing", async () => {
    const callLog: string[] = [];
    const control = renderControl({
      hasOpenPane: true,
      onClosePane: () => Promise.resolve({ status: "refused", refusal: PANE_HELD_OPEN }),
      onClearSiteData: servingAct(callLog, "clear"),
    });

    confirmButton(control).click();

    await waitFor(() => {
      expect(control.textContent).toContain("browser.pane_busy");
    });
    expect(callLog).toStrictEqual([]);
  });

  it("refuses by name when a pane is open and no close verb is registered", async () => {
    const callLog: string[] = [];
    const control = renderControl({
      hasOpenPane: true,
      onClearSiteData: servingAct(callLog, "clear"),
    });

    confirmButton(control).click();

    await waitFor(() => {
      expect(control.textContent).toContain("pane-close-unregistered");
    });
    expect(callLog).toStrictEqual([]);
  });

  it("renders a refusal rather than failing silently when a step rejects", async () => {
    const control = renderControl({
      onClearSiteData: () => Promise.reject(new Error("the preload went away")),
    });

    confirmButton(control).click();

    await waitFor(() => {
      expect(control.textContent).toContain("site-data-act-failed");
    });
  });

  it("says which step it is waiting on, and refuses a second confirm while it waits", async () => {
    const close = pendingAct();
    const closeCalls = vi.fn();
    const control = renderControl({
      hasOpenPane: true,
      onClosePane: () => {
        closeCalls();
        return close.promise;
      },
      onClearSiteData: () => Promise.resolve({ status: "done" }),
    });

    confirmButton(control).click();

    await waitFor(() => {
      expect(control.textContent).toContain("Closing the pane");
    });
    const waiting = [...control.querySelectorAll("button")][0];
    expect(waiting?.disabled).toBe(true);
    expect(control.getAttribute("aria-busy")).toBe("true");

    waiting?.click();
    expect(closeCalls).toHaveBeenCalledTimes(1);

    close.succeed();
    await waitFor(() => {
      expect(control.textContent).not.toContain("Closing the pane");
    });
  });
});

describe("PartitionClearControl — which verdict is shown", () => {
  it("shows the projected refusal until this control has run its own act", () => {
    const control = renderControl({
      lastClearRefusal: PROJECTED_FAILURE,
      onClearSiteData: servingAct([], "clear"),
    });

    expect(control.textContent).toContain("browser.partition_stale");
    expect(control.textContent).not.toContain("Cleared");
  });

  it("prefers the refusal the operator just took over the projected one", async () => {
    const control = renderControl({
      hasOpenPane: true,
      lastClearRefusal: PROJECTED_FAILURE,
      onClosePane: () => Promise.resolve({ status: "refused", refusal: PANE_HELD_OPEN }),
      onClearSiteData: servingAct([], "clear"),
    });

    confirmButton(control).click();

    await waitFor(() => {
      expect(control.textContent).toContain("browser.pane_busy");
    });
    expect(control.textContent).not.toContain("browser.partition_stale");
  });

  it("retires the projected refusal when the operator's own clear succeeds", async () => {
    // The case the ranking exists for: a served settlement carries no refusal, so a
    // control that preferred "whichever refusal exists" reported the older failure
    // again the moment the retry worked.
    const control = renderControl({
      lastClearRefusal: PROJECTED_FAILURE,
      onClearSiteData: servingAct([], "clear"),
    });

    confirmButton(control).click();

    await waitFor(() => {
      expect(control.textContent).toContain("Cleared");
    });
    expect(control.textContent).not.toContain("browser.partition_stale");
    expect(control.querySelector(".meridian-refusal--inline")).toBeNull();
  });

  it("says nothing about an earlier failure while its own act is in flight", async () => {
    const clear = pendingAct();
    const control = renderControl({
      lastClearRefusal: PROJECTED_FAILURE,
      onClearSiteData: () => clear.promise,
    });

    confirmButton(control).click();

    await waitFor(() => {
      expect(control.textContent).toContain("Clearing");
    });
    expect(control.textContent).not.toContain("browser.partition_stale");

    clear.succeed();
    await waitFor(() => {
      expect(control.textContent).toContain("Cleared");
    });
  });

  it("negative control: a served clear is reported and not merely left blank", async () => {
    // Without this, a control that simply stopped rendering anything once it had been
    // clicked would satisfy the case above while telling the operator nothing about
    // what its own act did.
    const control = renderControl({ onClearSiteData: servingAct([], "clear") });

    expect(control.textContent).not.toContain("Cleared");

    confirmButton(control).click();

    await waitFor(() => {
      expect(control.querySelector(".meridian-browser-partitions__reading")).not.toBeNull();
    });
    expect(control.textContent).toContain("Cleared");
  });

  it("negative control: with no verdict anywhere the control renders none", () => {
    const control = renderControl({ onClearSiteData: servingAct([], "clear") });

    expect(control.querySelector(".meridian-refusal--inline")).toBeNull();
    expect(control.querySelector(".meridian-browser-partitions__reading")).toBeNull();
  });
});

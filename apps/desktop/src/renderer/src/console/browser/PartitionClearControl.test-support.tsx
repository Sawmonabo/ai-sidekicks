// What both clear-control suites need before they can ask the control anything.
//
// One home rather than a copy per suite: the two files below split at the seam the
// module itself has — what the control renders and runs, and what survives the remount
// the table's fold performs on its row — and a fixture copied twice is two fixtures
// that drift, with the one that drifted being the suite that then passes for the wrong
// reason.

import { refuse, type ConsoleRefusal } from "../core/index.js";
import type { SiteDataAct, SiteDataActOutcome } from "./site-data-clear.js";

/** The partition every case is about unless it is about telling two of them apart. */
export const SESSION_ID = "session-07";

/** What a node says when the pane holding a partition would not close. */
export const PANE_HELD_OPEN: ConsoleRefusal = refuse(
  "browser",
  "browser.pane_busy",
  "The pane is mid-navigation and would not close.",
);

/** A clear that failed out of band, as whoever owns the listing projects it. */
export const PROJECTED_FAILURE: ConsoleRefusal = refuse(
  "browser",
  "browser.partition_stale",
  "An earlier clear left the directory half removed.",
);

/** An act that answers at once, writing which act ran and on which partition. */
export function servingAct(callLog: string[], name: string): SiteDataAct {
  return (sessionId) => {
    callLog.push(`${name}:${sessionId}`);
    return Promise.resolve({ status: "done" });
  };
}

/** An act held open, so the control can be read mid-step. */
export function pendingAct(): { readonly promise: Promise<SiteDataActOutcome>; succeed(): void } {
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

/** The one control a container holds. */
export function controlIn(container: HTMLElement): HTMLElement {
  const control = container.querySelector(".meridian-browser-partitions__control");
  if (!(control instanceof HTMLElement)) {
    throw new Error("PartitionClearControl rendered no control");
  }
  return control;
}

/**
 * The confirm, found by what it IS rather than by what it says.
 *
 * The label changes while the act runs — that is the point of it — so a query on the
 * idle wording cannot reach the button in the state half these cases are about.
 */
export function armButton(control: HTMLElement): HTMLButtonElement {
  const button = control.querySelector("button.meridian-browser-action");
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error("no confirm button is offered");
  }
  return button;
}

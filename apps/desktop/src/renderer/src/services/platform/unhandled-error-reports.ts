// Every error nothing in a window handled, an uncaught exception or a rejected promise with no
// handler, handed to main through the bridge for the background service's diagnostic log; nothing
// is shown. Each window is listened to once, from the app's composition. A browser notice that
// carries no error, such as the ResizeObserver loop notice, is reported as its message says, like
// any other. Until the bridge is handed over the first sixteen reports wait, and the rest are
// counted and reported as a count. A report main does not take goes to the window's diagnostic
// capture, never back through these listeners, so a failed report cannot loop.

import { isConsoleWindowId } from "#shared/window/frame-name.js";
import {
  readThrownValue,
  type UnhandledErrorReport,
  type WindowErrorRole,
} from "#shared/unhandled-error.js";
import { recordRejectedRequest } from "#renderer/lib/diagnostic-capture/rejected-request-record.js";

/** How many reports wait for the bridge before the rest are only counted. */
export const UNHANDLED_ERRORS_HELD_BEFORE_BRIDGE = 16;

/** The bridge member a report is handed to main through. */
export type UnhandledErrorSender = (report: UnhandledErrorReport) => Promise<void>;

/** Listens to each window for unhandled errors and hands them to main. */
export class UnhandledErrorReports {
  readonly #listened = new WeakSet<Window>();
  readonly #held: UnhandledErrorReport[] = [];
  /** Reports past what waits for the bridge, by the window they came from. */
  readonly #heldBackCounts = new Map<WindowErrorRole, number>();
  #send: UnhandledErrorSender | undefined;

  /** Reports every unhandled error of `target` from now on; a window listened to stays so. */
  public listenTo(target: Window, role: WindowErrorRole): void {
    if (this.#listened.has(target)) {
      return;
    }
    this.#listened.add(target);
    target.addEventListener("error", (event) => {
      this.#report(reportOfError(event, role));
    });
    target.addEventListener("unhandledrejection", (event) => {
      this.#report({
        kind: "unhandled-rejection",
        role,
        ...readThrownValue(event.reason, "unhandled-rejection"),
        source: null,
      });
    });
  }

  /**
   * Hands every report to `send` from now on, the waiting ones first and then a count for each
   * window that had more, until the returned call.
   */
  public sendThrough(send: UnhandledErrorSender): () => void {
    this.#send = send;
    for (const report of this.#held.splice(0)) {
      void this.#deliver(send, report);
    }
    for (const [role, count] of this.#heldBackCounts) {
      void this.#deliver(send, { kind: "held-back", role, count });
    }
    this.#heldBackCounts.clear();
    return () => {
      if (this.#send === send) {
        this.#send = undefined;
      }
    };
  }

  #report(report: UnhandledErrorReport): void {
    if (this.#send !== undefined) {
      void this.#deliver(this.#send, report);
    } else if (this.#held.length < UNHANDLED_ERRORS_HELD_BEFORE_BRIDGE) {
      this.#held.push(report);
    } else {
      this.#heldBackCounts.set(report.role, (this.#heldBackCounts.get(report.role) ?? 0) + 1);
    }
  }

  async #deliver(send: UnhandledErrorSender, report: UnhandledErrorReport): Promise<void> {
    try {
      await send(report);
    } catch (failure) {
      recordRejectedRequest("services/platform/unhandled-error-reports", "report-failed", failure);
    }
  }
}

/** Which window an opened window is, from the frame name it was opened under. */
export function windowErrorRoleOf(frameName: string): WindowErrorRole {
  return isConsoleWindowId(frameName) ? "console-window" : "pane-window";
}

// An error event carries the thrown value as `error`, or none for a notice the browser raised
// itself, whose message is the browser's own words; the script's address, line and column say
// where it was thrown.
function reportOfError(event: ErrorEvent, role: WindowErrorRole): UnhandledErrorReport {
  const parts =
    event.error === null || event.error === undefined
      ? { name: null, message: event.message, stack: null }
      : readThrownValue(event.error, "uncaught-error");
  return {
    kind: "uncaught-error",
    role,
    ...parts,
    source:
      event.filename === ""
        ? null
        : { address: event.filename, line: event.lineno, column: event.colno },
  };
}

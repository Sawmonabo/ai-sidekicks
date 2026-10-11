// What a window records about itself, on its way to the background service's diagnostic log: the
// lines the app captures (a read it could not make, a value it refused) and every error nothing in
// a window handled, an uncaught exception or a rejected promise with no handler. Nothing is shown.
// Without it a finding dies with the window, and an app that cannot see looks like a healthy one.
//
// It is on in every build, unlike the performance meters in `performance-meters/`, which measure
// an app someone is watching. It owns no wire: the window's composition hands it the bridge member
// that carries a batch to main, because `lib/` imports nothing above it.
//
// Each window is listened to once, from the app's composition. A browser notice that carries no
// error, such as the ResizeObserver loop notice, is recorded as its message says, like any other.
// A report is redacted and bounded before it is held (`#shared/app-diagnostic/redaction.ts`), so
// what waits is bounded too. Reports wait under one bound until the bridge member is handed over,
// and the rest are counted and sent as a count. Once it is, what arrived in one turn goes together
// at the end of the turn, in batches, so a cascade crosses to main as a few batches a turn rather
// than a crossing per report; nothing is scheduled past the turn, so an idle window is never woken.
//
// A batch main does not take is written to main's own log by main's bridge, and here only to the
// developer console, never back into this capture, so a refused batch cannot loop.

import { redactErrorParts, redactMessage } from "#shared/app-diagnostic/redaction.js";
import {
  readThrownValue,
  WINDOW_DIAGNOSTIC_BATCH_BOUND,
  type DiagnosticRecord,
  type WindowDiagnosticReport,
  type WindowDiagnosticRole,
} from "#shared/app-diagnostic/report.js";
import { isConsoleWindowId } from "#shared/window/frame-name.js";

import type { Clock } from "../clock.js";

/**
 * How many reports wait to be sent before the rest are only counted. At the bounds a report's
 * texts are cut to, 128 errors with full stacks are about 3 MB, and 128 captured lines about a
 * quarter of a megabyte; the first are kept, since a cascade's first report is usually its cause.
 */
export const WINDOW_DIAGNOSTICS_HELD = 128;

/** The bridge member a batch of reports is handed to main through. */
export type WindowDiagnosticSender = (reports: readonly WindowDiagnosticReport[]) => Promise<void>;

/**
 * A window as the capture listens to it, its uncaught errors and its rejections nothing handled;
 * named by shape so the module stays readable where no DOM types are.
 */
export interface ErrorRaisingWindow {
  addEventListener(type: "error", listener: (event: ScriptErrorEvent) => void): void;
  addEventListener(
    type: "unhandledrejection",
    listener: (event: { readonly reason: unknown }) => void,
  ): void;
}

/** What an error event says: the thrown value, or none for a notice, and where it was thrown. */
export interface ScriptErrorEvent {
  readonly error: unknown;
  readonly message: string;
  readonly filename: string;
  readonly lineno: number;
  readonly colno: number;
}

/** A window's diagnostic capture; a class so a test gets its own. */
export class DiagnosticCapture {
  readonly #listened = new WeakSet<ErrorRaisingWindow>();
  readonly #pending: WindowDiagnosticReport[] = [];
  /** Reports past what waits, since the last count sent. */
  #heldBackCount = 0;
  #send: WindowDiagnosticSender | undefined;
  #isSendQueued = false;

  /** Capture one line. */
  public record(record: DiagnosticRecord): void {
    this.#hold({ kind: "captured", record: { ...record, detail: redactMessage(record.detail) } });
  }

  /** Records every unhandled error of `target` from now on; a window listened to stays so. */
  public listenTo(target: ErrorRaisingWindow, role: WindowDiagnosticRole): void {
    if (this.#listened.has(target)) {
      return;
    }
    this.#listened.add(target);
    target.addEventListener("error", (event) => {
      this.#hold(reportOfError(event, role));
    });
    target.addEventListener("unhandledrejection", (event) => {
      this.#hold({
        kind: "unhandled-rejection",
        role,
        ...redactErrorParts({
          ...readThrownValue(event.reason, "unhandled-rejection"),
          source: null,
        }),
      });
    });
  }

  /**
   * Hands every report to `send` from now on, those that waited first and then their count, until
   * the returned call. Reports go at the end of the turn they arrive in.
   */
  public sendThrough(send: WindowDiagnosticSender): () => void {
    this.#send = send;
    this.#queueSend();
    return () => {
      if (this.#send === send) {
        this.#send = undefined;
      }
    };
  }

  #hold(report: WindowDiagnosticReport): void {
    if (this.#pending.length < WINDOW_DIAGNOSTICS_HELD) {
      this.#pending.push(report);
    } else {
      this.#heldBackCount += 1;
    }
    this.#queueSend();
  }

  #queueSend(): void {
    if (this.#send === undefined || this.#isSendQueued) {
      return;
    }
    this.#isSendQueued = true;
    queueMicrotask(() => {
      this.#isSendQueued = false;
      this.#sendWaiting();
    });
  }

  #sendWaiting(): void {
    const send = this.#send;
    if (send === undefined) {
      return;
    }
    const waiting = this.#pending.splice(0);
    if (this.#heldBackCount > 0) {
      waiting.push({ kind: "held-back", count: this.#heldBackCount });
      this.#heldBackCount = 0;
    }
    for (let start = 0; start < waiting.length; start += WINDOW_DIAGNOSTIC_BATCH_BOUND) {
      void this.#deliver(send, waiting.slice(start, start + WINDOW_DIAGNOSTIC_BATCH_BOUND));
    }
  }

  // Async, so a send that throws at once is caught here like one that rejects.
  async #deliver(send: WindowDiagnosticSender, batch: WindowDiagnosticReport[]): Promise<void> {
    try {
      await send(batch);
    } catch (failure) {
      console.error(
        "[ai-sidekicks/desktop] main did not take this window's diagnostics; its log says why:",
        failure,
      );
    }
  }
}

/** Which window an opened window is, from the frame name it was opened under. */
export function windowDiagnosticRoleOf(frameName: string): WindowDiagnosticRole {
  return isConsoleWindowId(frameName) ? "console-window" : "pane-window";
}

/** An ISO-8601 stamp from the app's clock, so a frozen clock stamps consistently. */
export function diagnosticStampAt(clock: Clock): string {
  return new Date(clock.now()).toISOString();
}

// An error event carries the thrown value as `error`, or none for a notice the browser raised
// itself, whose message is the browser's own words; the script's address, line and column say
// where it was thrown.
function reportOfError(
  event: ScriptErrorEvent,
  role: WindowDiagnosticRole,
): WindowDiagnosticReport {
  const parts =
    event.error === null || event.error === undefined
      ? { name: null, message: event.message, stack: null }
      : readThrownValue(event.error, "uncaught-error");
  return {
    kind: "uncaught-error",
    role,
    ...redactErrorParts({
      ...parts,
      source:
        event.filename === ""
          ? null
          : { address: event.filename, line: event.lineno, column: event.colno },
    }),
  };
}

/**
 * The app's capture, one per renderer process: the console document draws every window, so every
 * window's lines and errors come here.
 */
export const windowDiagnosticCapture: DiagnosticCapture = new DiagnosticCapture();

// What a window records about itself, on its way to the background service's diagnostic log: the
// lines the app captures (a read it could not make, a value it refused) and every error nothing in
// a window handled, an uncaught exception or a rejected promise with no handler. Nothing is shown.
// Without it a finding dies with the window, and an app that cannot see looks like a healthy one.
//
// It is on in every build, unlike the performance meters in `performance-meters/`, which measure
// an app someone is watching. It owns no wire: the window's composition hands it the bridge member
// that carries a batch to main, because `lib/` imports nothing above it.
//
// Each window is listened to once, from the app's composition. A callback reports its error to the
// window whose code it is, so an error in the app's code reads as the console document's in every
// window; an opened window reports what its own objects raise, such as a rejected promise one of
// its own calls returned. A browser notice that carries no error, such as the ResizeObserver loop
// notice, is recorded as its message says, like any other. A report is redacted and bounded before
// it is held (`#shared/app-diagnostic/redaction.ts`), so what waits is bounded too. Reports wait
// under one bound until the bridge member is handed over, and the rest are counted and sent as a
// count. Once it is, what arrived in one turn goes together at the end of the turn, as one batch,
// at the rate (`#shared/app-diagnostic/rate-limit.ts`), so a cascade crosses to main once a turn
// rather than once a report, and a window that throws on every frame sends a few reports a minute
// and a count of the rest. Nothing is scheduled past the turn but the end of a minute that sent a
// report, so an idle window is never woken.
//
// A batch main does not take is written to main's own log by main's bridge, and here only to the
// developer console, never back into this capture, so a refused batch cannot loop.

import { DiagnosticRateLimit, fingerprintOf } from "#shared/app-diagnostic/rate-limit.js";
import { redactErrorParts, redactMessage } from "#shared/app-diagnostic/redaction.js";
import {
  readThrownValue,
  recordCountOf,
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
  #sender: RateLimitedSender | undefined;
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
   * Hands every report to `send` from now on, at the rate, those that waited first and then their
   * count, until the returned call. Reports go at the end of the turn they arrive in; what the rate
   * holds back goes as one count once its minute ends.
   */
  public sendThrough(send: WindowDiagnosticSender): () => void {
    const sender: RateLimitedSender = {
      send,
      limit: new DiagnosticRateLimit(
        (count) => {
          this.#hold({ kind: "held-back", cause: "past-rate", count });
        },
        (end, ms) => {
          setTimeout(end, ms);
        },
      ),
    };
    this.#sender = sender;
    this.#queueSend();
    return () => {
      if (this.#sender === sender) {
        this.#sender = undefined;
      }
    };
  }

  #hold(report: WindowDiagnosticReport): void {
    if (this.#pending.length < WINDOW_DIAGNOSTICS_HELD) {
      this.#pending.push(report);
    } else {
      // A count that does not fit still stands for every report it counted.
      this.#heldBackCount += recordCountOf(report);
    }
    this.#queueSend();
  }

  #queueSend(): void {
    if (this.#sender === undefined || this.#isSendQueued) {
      return;
    }
    this.#isSendQueued = true;
    queueMicrotask(() => {
      this.#isSendQueued = false;
      this.#sendWaiting();
    });
  }

  #sendWaiting(): void {
    const sender = this.#sender;
    if (sender === undefined) {
      return;
    }
    const isGoing = (report: WindowDiagnosticReport): boolean =>
      sender.limit.admit(fingerprintOfReport(report), recordCountOf(report));
    // The count of what did not fit is weighed first, so a cascade past the rate still says what
    // the window dropped, and it goes last, after the reports it follows.
    const bufferFull: WindowDiagnosticReport = {
      kind: "held-back",
      cause: "window-buffer-full",
      count: this.#heldBackCount,
    };
    this.#heldBackCount = 0;
    const isBufferFullGoing = bufferFull.count > 0 && isGoing(bufferFull);
    const going = this.#pending.splice(0).filter(isGoing);
    if (isBufferFullGoing) {
      going.push(bufferFull);
    }
    // The rate lets no more go in a minute than one batch carries.
    if (going.length > 0) {
      void this.#deliver(sender.send, going);
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

// The bridge member reports go through, and the rate they go at, counted afresh for each member.
interface RateLimitedSender {
  readonly send: WindowDiagnosticSender;
  readonly limit: DiagnosticRateLimit;
}

// A report's fingerprint, its captured line read as main's record of it names its fields.
function fingerprintOfReport(report: WindowDiagnosticReport): string {
  return report.kind === "captured"
    ? fingerprintOf({
        kind: "captured",
        source: report.record.source,
        capturedKind: report.record.kind,
        detail: report.record.detail,
      })
    : fingerprintOf(report);
}

/**
 * The app's capture, one per renderer process: the console document draws every window, so every
 * window's lines and errors come here.
 */
export const windowDiagnosticCapture: DiagnosticCapture = new DiagnosticCapture();

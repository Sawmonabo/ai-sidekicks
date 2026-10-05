// A daemon stream with no cursor to resume from, kept open for its owner. A stream that ends after
// it delivered is opened again at once, and again after growing waits while each re-opened stream
// ends at once, so a stream that delivers and ends every time is not opened in a loop; one that
// stays open a while starts the waits over. A stream that ends before delivering anything waits
// for the transport's returning edge, so a daemon declining the stream is not asked again in a
// loop. A re-open that throws is reported to the owner as a refusal it can draw, and tried again
// at the next wait or at the returning edge, whichever comes first; the next re-open that works
// clears it. Each re-open tells the owner, which reads afresh what the gap may have hidden. A first
// open that throws is re-raised unchanged, as `openObservedSubscription` does, since most owners
// already have an arm for a stream that could not open; an owner without one has it wait for the
// returning edge, or has it reported and tried again as a re-open that throws is.

import { describeSubscriptionEnd, type DaemonSubscriptionEnd } from "@shared/daemon-forwarding.js";
import type { Unsubscribe } from "@shared/preload-api.js";
import { RealClock, type Clock, type ScheduledHandle } from "@renderer/lib/clock.js";
import {
  diagnosticStampAt,
  windowDiagnosticCapture,
} from "@renderer/lib/diagnostic-capture/diagnostic-capture.js";
import type { Refusal } from "@renderer/lib/refusal.js";
import { lossyStringify } from "@renderer/lib/wire-errors.js";
import { normalizeWireRejection } from "@renderer/lib/wire-rejection.js";
import { openObservedSubscription } from "./observed-subscription.js";
import type { TransportReconnectSignal } from "./transport-reconnect.js";

/** One open of the stream: its frames go to `deliver`, and its end, if it ends, to `onEnded`. */
export type ReopenableStreamOpen<Payload = unknown> = (
  deliver: (payload: Payload) => void,
  onEnded: (end: DaemonSubscriptionEnd) => void,
) => Unsubscribe;

/**
 * What a first open that throws does: re-raise, wait for the transport's returning edge, or reach
 * the owner as a refusal and be tried again as a re-open that throws is.
 */
export type FirstOpenFailure = "rethrow" | "reopenOnReconnect" | "refuseAndRetry";

/**
 * The waits before each re-open in a row of streams that ended at once or re-opens that threw, in
 * milliseconds: the first is at once and the last repeats, as the main process's restarts of the
 * service grow.
 */
export const REOPEN_WAITS_MS: readonly number[] = [0, 100, 300, 1_000, 3_000, 10_000];

/** How long a stream stays open before its end starts the re-open waits over, in milliseconds. */
export const REOPEN_SETTLED_MS = 10_000;

/** The subsystem a failed re-open's refusal names. */
const REOPEN_REFUSAL_ORIGIN = "subscription-reopen";

/**
 * Open `stream` and keep it open until the returned handle releases it. `subject` names the stream
 * in the diagnostic records of its ends; `onReopened` runs after each re-open, never the first, for
 * an owner whose stream does not restate everything when it opens. `onReopenRefusal` receives the
 * refusal of each re-open that throws, and `undefined` when a re-open works after one did.
 * `firstOpenFailure` defaults to `rethrow`; `clock` times the waits.
 */
export function openReopeningSubscription<Payload = unknown>(options: {
  readonly signal: TransportReconnectSignal;
  readonly subject: string;
  readonly open: ReopenableStreamOpen<Payload>;
  readonly onFrame: (payload: Payload) => void;
  readonly onReopened?: () => void;
  readonly onReopenRefusal?: (refusal: Refusal | undefined) => void;
  readonly firstOpenFailure?: FirstOpenFailure;
  readonly clock?: Clock;
}): Unsubscribe {
  const {
    signal,
    subject,
    open,
    onFrame,
    onReopened,
    onReopenRefusal,
    firstOpenFailure = "rethrow",
    clock = new RealClock(),
  } = options;
  let release: Unsubscribe | undefined;
  let stopWaiting: Unsubscribe | undefined;
  let waitHandle: ScheduledHandle | undefined;
  let isReleased = false;
  let isRefused = false;
  /** Whether an open has worked yet, which decides whether a refused one stopped live updates. */
  let hasOpened = false;
  /** Re-opens in a row since a stream last stayed open {@link REOPEN_SETTLED_MS}. */
  let reopensInARow = 0;

  // Holds the open's handle only while it lasts: an end heard before `open` returns leaves none.
  const openOnce = (): void => {
    const openedAt = clock.now();
    let hasDelivered = false;
    let hasEnded = false;
    const handle = openObservedSubscription(signal, () =>
      open(
        (payload) => {
          hasDelivered = true;
          onFrame(payload);
        },
        (end) => {
          hasEnded = true;
          release = undefined;
          recordStreamFact("subscription-ended", `${subject}: ${describeSubscriptionEnd(end)}`);
          if (!hasDelivered) {
            reopenOnReconnect();
            return;
          }
          if (clock.now() - openedAt >= REOPEN_SETTLED_MS) {
            reopensInARow = 0;
          }
          reopenAfterWait();
        },
      ),
    );
    hasOpened = true;
    if (!hasEnded) {
      release = handle;
    }
  };
  const reopen = (): void => {
    stopWaitingForReopen();
    if (isReleased) {
      return;
    }
    try {
      openOnce();
    } catch (openFailure: unknown) {
      refuseAndRetry(openFailure);
      return;
    }
    if (isRefused) {
      isRefused = false;
      onReopenRefusal?.(undefined);
    }
    onReopened?.();
  };
  const refuseAndRetry = (openFailure: unknown): void => {
    recordStreamFact("subscription-open-failed", `${subject}: ${lossyStringify(openFailure)}`);
    isRefused = true;
    onReopenRefusal?.(
      normalizeWireRejection(REOPEN_REFUSAL_ORIGIN, openFailure, {
        code: "subscription-reopen-failed",
        detail: hasOpened
          ? "Live updates stopped and could not start again; still trying."
          : "Live updates could not start; still trying.",
      }),
    );
    // Never at once: an open that just threw is tried again after a wait.
    reopensInARow = Math.max(reopensInARow, 1);
    reopenAfterWait();
    reopenOnReconnect();
  };
  const reopenAfterWait = (): void => {
    if (isReleased || waitHandle !== undefined) {
      return;
    }
    const waitMs = REOPEN_WAITS_MS[Math.min(reopensInARow, REOPEN_WAITS_MS.length - 1)]!;
    reopensInARow += 1;
    if (waitMs === 0) {
      reopen();
      return;
    }
    waitHandle = clock.scheduleTimeout(reopen, waitMs);
  };
  const reopenOnReconnect = (): void => {
    if (isReleased || stopWaiting !== undefined) {
      return;
    }
    stopWaiting = signal.subscribe(reopen);
  };
  const stopWaitingForReopen = (): void => {
    stopWaiting?.();
    stopWaiting = undefined;
    if (waitHandle !== undefined) {
      clock.cancel(waitHandle);
      waitHandle = undefined;
    }
  };

  if (firstOpenFailure === "rethrow") {
    openOnce();
  } else {
    try {
      openOnce();
    } catch (openFailure: unknown) {
      if (firstOpenFailure === "refuseAndRetry") {
        refuseAndRetry(openFailure);
      } else {
        recordStreamFact("subscription-open-failed", `${subject}: ${lossyStringify(openFailure)}`);
        reopenOnReconnect();
      }
    }
  }
  return () => {
    isReleased = true;
    stopWaitingForReopen();
    release?.();
    release = undefined;
  };
}

function recordStreamFact(kind: string, detail: string): void {
  windowDiagnosticCapture.record({
    at: diagnosticStampAt(new RealClock()),
    severity: "warning",
    source: "services/transport",
    kind,
    detail,
  });
}

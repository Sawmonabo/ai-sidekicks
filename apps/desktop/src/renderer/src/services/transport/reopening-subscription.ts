// A daemon stream with no cursor to resume from, kept open for its owner. A stream that ends after
// it delivered is opened again through the re-open waits (`reopen-backoff.ts`). A stream that ends
// before delivering anything waits for the transport's returning edge, so a daemon declining the
// stream is not asked again in a loop; one the daemon refused reaches the owner as that refusal. A
// re-open that throws is reported to the owner as a refusal it can draw, and tried again at the
// next wait or at the returning edge, whichever comes first; the next re-open that works clears
// either refusal. Each re-open tells the owner, which reads afresh what the gap may have hidden. A
// first open that throws is re-raised unchanged, as `openObservedSubscription` does, since most
// owners already have an arm for a stream that could not open; an owner without one has it wait
// for the returning edge, or has it reported and tried again as a re-open that throws is.

import { describeSubscriptionEnd, type DaemonSubscriptionEnd } from "#shared/daemon/forwarding.js";
import type { Unsubscribe } from "#shared/preload-api.js";
import { RealClock, type Clock } from "#renderer/lib/clock.js";
import {
  diagnosticStampAt,
  windowDiagnosticCapture,
} from "#renderer/lib/diagnostic-capture/diagnostic-capture.js";
import type { Refusal } from "#renderer/lib/refusal/refusal.js";
import { lossyStringify } from "#renderer/lib/wire/errors.js";
import { normalizeWireRejection } from "#renderer/lib/wire/rejection.js";
import { openObservedSubscription } from "./observed-subscription.js";
import type { TransportReconnectSignal } from "./reconnect.js";
import { ReopenBackoff } from "./reopen-backoff.js";

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
 * What keeps one stream open. `subject` names the stream in the diagnostic records of its ends;
 * `onReopened` runs after each re-open, never the first, for an owner whose stream does not
 * restate everything when it opens. `onReopenRefusal` receives each refusal, of a re-open that
 * throws or of a stream the daemon refused before delivering, and `undefined` when a re-open works
 * after one. `firstOpenFailure` defaults to `rethrow`; `clock` times the waits.
 */
export interface ReopeningSubscriptionOptions<Payload = unknown> {
  readonly signal: TransportReconnectSignal;
  readonly subject: string;
  readonly open: ReopenableStreamOpen<Payload>;
  readonly onFrame: (payload: Payload) => void;
  readonly onReopened?: () => void;
  readonly onReopenRefusal?: (refusal: Refusal | undefined) => void;
  readonly firstOpenFailure?: FirstOpenFailure;
  readonly clock?: Clock;
}

/** Open the stream `options` names and keep it open until the returned handle releases it. */
export function openReopeningSubscription<Payload = unknown>(
  options: ReopeningSubscriptionOptions<Payload>,
): Unsubscribe {
  const subscription = new ReopeningSubscription(options);
  subscription.openFirst();
  return () => {
    subscription.release();
  };
}

/** The subsystem a failed re-open's refusal names. */
const REOPEN_REFUSAL_ORIGIN = "subscription-reopen";

/** One stream kept open, from its first open to its release. */
class ReopeningSubscription<Payload> {
  readonly #options: ReopeningSubscriptionOptions<Payload>;
  readonly #clock: Clock;
  readonly #backoff: ReopenBackoff;
  /** The open stream's handle, only while it lasts: an end heard before `open` returns leaves none. */
  #release: Unsubscribe | undefined;
  #stopWaitingForEdge: Unsubscribe | undefined;
  #isReleased = false;
  #isRefused = false;
  /** Whether an open has worked yet, which decides whether a refused one stopped live updates. */
  #hasOpened = false;

  public constructor(options: ReopeningSubscriptionOptions<Payload>) {
    this.#options = options;
    this.#clock = options.clock ?? new RealClock();
    this.#backoff = new ReopenBackoff(this.#clock);
  }

  /** Take the first open, failing as `firstOpenFailure` says. */
  public openFirst(): void {
    const { firstOpenFailure = "rethrow", subject } = this.#options;
    if (firstOpenFailure === "rethrow") {
      this.#openOnce();
      return;
    }
    try {
      this.#openOnce();
    } catch (openFailure: unknown) {
      if (firstOpenFailure === "refuseAndRetry") {
        this.#refuseAndRetry(openFailure);
      } else {
        recordStreamFact("subscription-open-failed", `${subject}: ${lossyStringify(openFailure)}`);
        this.#reopenOnReconnect();
      }
    }
  }

  /** Stop keeping the stream open and close it. Final. */
  public release(): void {
    this.#isReleased = true;
    this.#stopWaitingForReopen();
    this.#release?.();
    this.#release = undefined;
  }

  #openOnce(): void {
    const { signal, open, onFrame, subject } = this.#options;
    const openedAt = this.#clock.now();
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
          this.#release = undefined;
          recordStreamFact("subscription-ended", `${subject}: ${describeSubscriptionEnd(end)}`);
          if (hasDelivered) {
            this.#backoff.noteEnded(openedAt);
            this.#reopenAfterWait();
            return;
          }
          if (end.reason === "refused") {
            this.#refuse(normalizeWireRejection(REOPEN_REFUSAL_ORIGIN, end.refusal));
          }
          this.#reopenOnReconnect();
        },
      ),
    );
    this.#hasOpened = true;
    if (!hasEnded) {
      this.#release = handle;
    }
  }

  #reopen(): void {
    this.#stopWaitingForReopen();
    if (this.#isReleased) {
      return;
    }
    try {
      this.#openOnce();
    } catch (openFailure: unknown) {
      this.#refuseAndRetry(openFailure);
      return;
    }
    if (this.#isRefused) {
      this.#isRefused = false;
      this.#options.onReopenRefusal?.(undefined);
    }
    this.#options.onReopened?.();
  }

  #refuseAndRetry(openFailure: unknown): void {
    recordStreamFact(
      "subscription-open-failed",
      `${this.#options.subject}: ${lossyStringify(openFailure)}`,
    );
    this.#refuse(
      normalizeWireRejection(REOPEN_REFUSAL_ORIGIN, openFailure, {
        code: "subscription-reopen-failed",
        detail: this.#hasOpened
          ? "Live updates stopped and could not start again; still trying."
          : "Live updates could not start; still trying.",
      }),
    );
    // Never at once: an open that just threw is tried again after a wait.
    this.#backoff.skipImmediateReopen();
    this.#reopenAfterWait();
    this.#reopenOnReconnect();
  }

  #refuse(refusal: Refusal): void {
    this.#isRefused = true;
    this.#options.onReopenRefusal?.(refusal);
  }

  #reopenAfterWait(): void {
    if (!this.#isReleased) {
      this.#backoff.schedule(() => {
        this.#reopen();
      });
    }
  }

  #reopenOnReconnect(): void {
    if (this.#isReleased || this.#stopWaitingForEdge !== undefined) {
      return;
    }
    this.#stopWaitingForEdge = this.#options.signal.subscribe(() => {
      this.#reopen();
    });
  }

  #stopWaitingForReopen(): void {
    this.#stopWaitingForEdge?.();
    this.#stopWaitingForEdge = undefined;
    this.#backoff.cancel();
  }
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

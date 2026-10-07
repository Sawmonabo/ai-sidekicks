// The sessions whose stream would not open, and what one returning edge is worth. Split from
// `subscriber.ts`, which owns which sessions are bound; this owns which opens
// failed and what the window does about them when the wire comes back.
//
// A failed `daemon.subscribe` leaves a session with no stream, and the registry's `opened` change
// has already been delivered, so nothing would name that session again until it is closed and
// reopened. Retaining the id gives the transport's returning edge something to re-attempt. A
// stream that ended without delivering since it opened is retained the same way, and so is a
// session whose stream waits on a read that may not have reached the daemon.
// The edge is not produced by this retry's caller: the signal is moved by main's `daemon.status`
// topic and by `services/transport/observed-subscription.ts`, so a window holding one session
// whose open threw still sees the edge that retries it.
//
// The set is bounded by the open set, not a cap: an id joins on a failed open or a wait on a read,
// and leaves on the session's close or an open that took a subscription. There is no backoff and no timer: a retry
// that fails again reports `unreachable` through `openObservedSubscription`, and the next
// returning edge is another attempt.

/**
 * What a pass needs of the subscriber around it, as callbacks so this class cannot reach a
 * subscription map, a store or a bridge.
 */
export interface FailedSubscriptionRetryOptions {
  /**
   * Whether the owner is gone. Asked before every attempt, because a returning edge reaches a
   * snapshot of the signal's sinks and a teardown mid-delivery leaves the rest of a pass walking
   * an owner that holds nothing.
   */
  readonly isRetired: () => boolean;
  /** Whether this session is still one the window holds open. */
  readonly isStillOpen: (sessionId: string) => boolean;
  /** Re-attempt one session's stream. Answers nothing: the outcome arrives as a write. */
  readonly rebind: (sessionId: string) => void;
}

/** Remembers open sessions whose stream failed to open and re-attempts them on a returning edge. */
export class FailedSubscriptionRetry {
  readonly #isRetired: () => boolean;
  readonly #isStillOpen: (sessionId: string) => boolean;
  readonly #rebind: (sessionId: string) => void;
  readonly #retainedSessionIds = new Set<string>();
  #retriedBindCount = 0;
  #passRunning = false;

  public constructor(options: FailedSubscriptionRetryOptions) {
    this.#isRetired = options.isRetired;
    this.#isStillOpen = options.isStillOpen;
    this.#rebind = options.rebind;
  }

  /**
   * Open sessions whose stream is not open, in the order they were retained. A session named here
   * has a store the window holds and no wire feeding it.
   */
  public get retainedSessionIds(): readonly string[] {
    return [...this.#retainedSessionIds];
  }

  /**
   * Binds re-attempted on a returning edge, whether or not they took. A count makes visible a
   * window that keeps re-attempting the same session on every reconnect, a wire fault upstream.
   */
  public get retriedBindCount(): number {
    return this.#retriedBindCount;
  }

  /** Remembers a session with no stream open, for the next returning edge. */
  public retain(sessionId: string): void {
    this.#retainedSessionIds.add(sessionId);
  }

  /**
   * Stops expecting to re-attempt this session. Called after a retry that took a subscription and
   * on a session close, taken or not, which bounds the set by the open set.
   */
  public forget(sessionId: string): void {
    this.#retainedSessionIds.delete(sessionId);
  }

  /** Drops every promise to re-attempt; a retired owner makes none. */
  public clear(): void {
    this.#retainedSessionIds.clear();
  }

  /**
   * Re-attempts every retained session once, on the transport's returning edge. A snapshot of the
   * set is walked because a re-attempt writes into it (forgets on success, re-retains on failure).
   *
   * The pass does not re-enter itself: a failed open then a successful one drives the signal
   * `unreachable` then `reachable` inside the walk, a returning edge that delivers back here
   * mid-pass. The flag makes that nested delivery a no-op instead of a second walk that
   * double-counts attempts; still-failing sessions keep their ids for the next real edge.
   */
  public runOnePass(): void {
    if (this.#isRetired() || this.#passRunning) {
      return;
    }
    this.#passRunning = true;
    try {
      this.#attemptEachRetainedSession();
    } finally {
      this.#passRunning = false;
    }
  }

  /**
   * One walk, discarding whatever the walk itself retired. A session that closed since it failed
   * is dropped without an attempt, and a retirement part-way stops the walk, so the count is of
   * attempts the owner actually made.
   */
  #attemptEachRetainedSession(): void {
    for (const sessionId of this.retainedSessionIds) {
      if (this.#isRetired()) {
        return;
      }
      if (!this.#isStillOpen(sessionId)) {
        this.#retainedSessionIds.delete(sessionId);
        continue;
      }
      this.#retriedBindCount += 1;
      this.#rebind(sessionId);
    }
  }
}

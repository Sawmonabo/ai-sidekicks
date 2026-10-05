// When a view that performs its own reads re-reads, wired to the things that say so: window
// focus, reconnect, and the terminal events the owning view names (`subscribe` belongs to the
// reader). No interval polling.
//
// It wires a `ReadTriggerTarget`, not a scheduler: `read-triggers.ts` does the same through
// React hooks, while this class does it imperatively for a reading minted in a resource seam.
// Both read `triggeringEventKinds` and `requestRead` off the reading, so there is one answer
// to when it goes stale.
//
// The repair edge is the reconnect signal. Nothing publishes a bridge-level "reconnected"
// event, but the store sets `degradedCause` when the stream fails (`session-degradation.ts`)
// and clears it only by a completed re-pull, so the clearing edge is the moment the projection
// is whole again. A base state is not a frame: `initialize()` backfill is already reflected by
// the reader's first read, so the scan runs only over an initialized store's transitions.

import {
  eventTriggersRead,
  isRepairEdge,
  requestReadOnWindowFocus,
  type ReadTriggerTarget,
} from "./read-triggers.js";
import type { SessionStore } from "../session/session-store.js";

/** Options for a `SessionRefreshTriggers`. */
export interface SessionRefreshTriggerOptions {
  /**
   * The reading these observations refresh. Asked, never armed: this class owns no timer, and
   * the reading's own `requestRead` decides whether a reason reaches a scheduler. The frames
   * it re-reads on come off the same object as `triggeringEventKinds`, since a kind list handed
   * in at the call site is how two views come to disagree about when an answer goes stale.
   */
  readonly target: ReadTriggerTarget;
  /** The session whose frames and whose repair edge are two of the three reasons. */
  readonly sessionStore: SessionStore;
  /** The window the reading is drawn in, whose regaining focus is the third. */
  readonly ownerWindow: Window;
}

/**
 * Listens for the reasons to re-read and routes each to the reading. Idempotent on `start`
 * and terminal on `dispose`, since strict mode mounts an effect twice and a listener attached
 * twice would double every re-read.
 */
export class SessionRefreshTriggers {
  readonly #target: ReadTriggerTarget;
  readonly #sessionStore: SessionStore;
  readonly #ownerWindow: Window;
  /** One detach per attached listener, run in `dispose` and then dropped. */
  readonly #detachers: (() => void)[] = [];
  #started = false;

  public constructor(options: SessionRefreshTriggerOptions) {
    this.#target = options.target;
    this.#sessionStore = options.sessionStore;
    this.#ownerWindow = options.ownerWindow;
  }

  public start(): void {
    if (this.#started) {
      return;
    }
    this.#started = true;
    this.#detachers.push(
      this.#sessionStore.readable.subscribe((state, previous) => {
        this.#observeSessionTransition(state, previous);
      }),
      requestReadOnWindowFocus(this.#target, this.#ownerWindow),
    );
  }

  /** Terminal. No later frame and no later focus can re-arm a read behind an unmount. */
  public dispose(): void {
    for (const detach of this.#detachers.splice(0)) {
      detach();
    }
  }

  /**
   * Reads one store transition for the two reasons it can carry, off the transition itself
   * rather than a mirrored copy of the previous state that a missed notification could put out
   * of step.
   */
  #observeSessionTransition(
    state: ReturnType<SessionStore["snapshot"]>,
    previous: ReturnType<SessionStore["snapshot"]>,
  ): void {
    if (isRepairEdge(previous.degradedCause, state.degradedCause)) {
      this.#target.requestRead("reconnect");
    }
    if (!previous.initialized || state.cursor <= previous.cursor) {
      return;
    }
    const admitted = state.transcript.filter((event) => event.sequence > previous.cursor);
    // The declaration is read off the target on every transition, not copied at construction,
    // so a getter over something that moves is compared against what it declares now. A
    // projected frame's `kind` is a plain string, so the declared set is `ReadonlySet<string>`.
    // The shared predicate is the one home for the two-part admission (declared kind, then the
    // reading's answer about this frame).
    if (admitted.some((event) => eventTriggersRead(this.#target, event))) {
      this.#target.requestRead("terminal-event");
    }
  }
}

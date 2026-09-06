// When a surface that performs its own reads re-reads, wired to the things that say so.
//
// `Spec-023 §Rules every console surface obeys` fixes the policy under "No interval
// polling": "Reads happen on subscribe, on window focus, on reconnect, and on the
// terminal events the owning spec names". `subscribe` belongs to the reader — it is
// the read the reader starts itself — and the other three are observations of things
// outside it, which is what this class owns.
//
// IT LIVES BESIDE THE SCHEDULER RATHER THAN IN A VIEW FAMILY, because the three
// observations are the same three whichever surface is reading: a window focus is a
// window focus, the store's repair edge is the console's one reconnect signal, and
// "the terminal events the owning spec names" differs only in WHICH kinds — which is
// the one parameter. The repos section had the only implementation and hard-coded a
// `workspace.stale` frame into it; the artifact pane needs the same mechanism over
// three artifact kinds, and a second copy would be the same listener wiring and the
// same transition scan written twice, drifting apart at the first fix applied to one.
//
// IT WIRES A `ReadTriggerTarget` AND NOT A SCHEDULER, which is the one thing it takes
// from `read-triggers.ts` beside it. That module wires the same policy through React
// hooks for a reading a surface mounts; this one wires it imperatively for a reading
// minted outside React, in a resource seam, and started and disposed by hand. Two
// WIRINGS are honest — a class held per subject cannot call a hook — but two
// VOCABULARIES are not, and a reading that declared its kinds to one and its request
// path to the other would be two answers to "when does this go stale". So both read
// the same two members off the reading itself: `triggeringEventKinds`, which is a
// property of the QUESTION rather than of whoever mounts it, and `requestRead`, which
// is the reading's own way into its own scheduler.
//
// EVERY REASON IS ONE `RefreshReason` ALREADY NAMES, and nothing here mints a member:
// a window focus is `window-focus`, a named frame is `terminal-event`, and the repair
// edge below is `reconnect`. Requesting is all this class does; the scheduler decides
// whether a burst becomes one read or several.
//
// WHY THE REPAIR EDGE IS THE RECONNECT SIGNAL. Nothing in the console publishes a
// bridge-level "reconnected" event, and inventing one would be a fact the renderer
// never established. What the store DOES publish is `degradedCause`, set when the
// session's stream fails in any of the four ways `store/degradation.ts` names and
// cleared only by a completed re-pull. Its clearing edge is therefore the moment the
// session's projection is whole again after having not been — which is what the
// refresh policy means by reconnect, observed rather than assumed.
//
// A BASE STATE IS NOT A FRAME. `initialise()` establishes a session's history in one
// transition, and a named kind sitting inside that backfill describes something the
// reader's own first read already reflects. Re-reading on it would put a second burst
// behind every session open for no new information, so the scan runs only over
// transitions of an already-initialised store.

import type { ReadTriggerTarget } from "./read-triggers.js";
import type { SessionStore } from "./session-store.js";

export interface SessionRefreshTriggerOptions {
  /**
   * The reading these observations refresh.
   *
   * Asked, never armed: this class owns no timer and no scheduler, and the reading's
   * own `requestRead` is what decides whether a reason reaches a scheduler at all.
   * The frames it re-reads on come off the same object as `triggeringEventKinds`,
   * rather than being passed beside it, because which events change an answer is a
   * property of the QUESTION — two surfaces asking the same one must not disagree
   * about when it goes stale, and a kind list handed in at the call site is exactly
   * how they come to.
   *
   * The `SessionEventType` census check that list used to carry at each call site is
   * not lost by the move: it lives at the home of the kind set the reading declares
   * from — `repos/repo-lifecycle-events.ts` for this family — which is one place
   * instead of one per reader.
   */
  readonly target: ReadTriggerTarget;
  /** The session whose frames and whose repair edge are two of the three reasons. */
  readonly sessionStore: SessionStore;
}

/**
 * Listen for the reasons to re-read, and route each to the scheduler.
 *
 * Idempotent on `start` and terminal on `dispose`: React mounts an effect twice in
 * development strict mode, and a listener attached twice would double every re-read in
 * exactly the environment where the budget is watched.
 */
export class SessionRefreshTriggers {
  readonly #target: ReadTriggerTarget;
  readonly #sessionStore: SessionStore;
  /** One detach per attached listener, run in `dispose` and then dropped. */
  readonly #detachers: (() => void)[] = [];
  #started = false;

  public constructor(options: SessionRefreshTriggerOptions) {
    this.#target = options.target;
    this.#sessionStore = options.sessionStore;
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
    );
    if (typeof window === "undefined") {
      return;
    }
    const onWindowFocus = (): void => {
      this.#target.requestRead("window-focus");
    };
    window.addEventListener("focus", onWindowFocus);
    this.#detachers.push(() => {
      window.removeEventListener("focus", onWindowFocus);
    });
  }

  /** Terminal. No later frame and no later focus can re-arm a read behind an unmount. */
  public dispose(): void {
    for (const detach of this.#detachers.splice(0)) {
      detach();
    }
  }

  /**
   * One store transition, read for the two reasons it can carry.
   *
   * Both are read off the transition itself rather than off a mirrored copy of the
   * previous state: the store already holds what changed, and a second copy here would
   * be a source of truth that a missed notification could put out of step.
   */
  #observeSessionTransition(
    state: ReturnType<SessionStore["snapshot"]>,
    previous: ReturnType<SessionStore["snapshot"]>,
  ): void {
    if (previous.degradedCause !== undefined && state.degradedCause === undefined) {
      this.#target.requestRead("reconnect");
    }
    if (!previous.initialised || state.cursor <= previous.cursor) {
      return;
    }
    const admitted = state.timeline.filter((event) => event.sequence > previous.cursor);
    // The kinds are read off the target on every transition rather than copied at
    // construction, so a reading whose declaration is a getter over something that
    // moves is compared against what it declares NOW. A projected frame's `kind` is a
    // plain string — the store admits what the wire sent — which is why the declared
    // set is `ReadonlySet<string>` and the comparison is honest about what it compares.
    const { triggeringEventKinds } = this.#target;
    if (admitted.some((event) => triggeringEventKinds.has(event.kind))) {
      this.#target.requestRead("terminal-event");
    }
  }
}

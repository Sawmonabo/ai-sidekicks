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

import type { SessionEventType } from "@ai-sidekicks/contracts";

import type { RefreshScheduler } from "./scheduling.js";
import type { SessionStore } from "./session-store.js";

export interface SessionRefreshTriggerOptions {
  /** The scheduler to request against. Requested, never armed: this class owns no timer. */
  readonly scheduler: RefreshScheduler;
  /** The session whose frames and whose repair edge are two of the three reasons. */
  readonly sessionStore: SessionStore;
  /**
   * The frames this reader re-reads on — "the terminal events the owning spec names".
   *
   * Required and typed `SessionEventType`, so a kind renamed on the wire fails to
   * compile at the call site instead of silently matching nothing for the life of the
   * release, and so a reader that watches for nothing has to say so by passing an
   * empty list rather than by leaving a default in place it never considered.
   */
  readonly terminalEventKinds: readonly SessionEventType[];
}

/**
 * Listen for the reasons to re-read, and route each to the scheduler.
 *
 * Idempotent on `start` and terminal on `dispose`: React mounts an effect twice in
 * development strict mode, and a listener attached twice would double every re-read in
 * exactly the environment where the budget is watched.
 */
export class SessionRefreshTriggers {
  readonly #scheduler: RefreshScheduler;
  readonly #sessionStore: SessionStore;
  /**
   * Widened to `string` for the membership test, and only there.
   *
   * A projected frame's `kind` is a plain string — the store admits what the wire
   * sent — so a set typed to the census could not be asked about one. The census
   * check happens at the CONSTRUCTOR boundary, where a caller naming a kind the
   * contract does not carry fails to compile; widening here loses nothing that was
   * ever checked and keeps the comparison honest about what it is comparing.
   */
  readonly #terminalEventKinds: ReadonlySet<string>;
  /** One detach per attached listener, run in `dispose` and then dropped. */
  readonly #detachers: (() => void)[] = [];
  #started = false;

  public constructor(options: SessionRefreshTriggerOptions) {
    this.#scheduler = options.scheduler;
    this.#sessionStore = options.sessionStore;
    this.#terminalEventKinds = new Set(options.terminalEventKinds);
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
      this.#scheduler.request("window-focus");
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
      this.#scheduler.request("reconnect");
    }
    if (!previous.initialised || state.cursor <= previous.cursor) {
      return;
    }
    const admitted = state.timeline.filter((event) => event.sequence > previous.cursor);
    if (admitted.some((event) => this.#terminalEventKinds.has(event.kind))) {
      this.#scheduler.request("terminal-event");
    }
  }
}

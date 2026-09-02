// The three reasons the repos section re-reads, wired to the three things that say so.
//
// `Spec-023 §Rules every console surface obeys` fixes the policy: "Reads happen on
// subscribe, on window focus, on reconnect, and on the terminal events the owning spec
// names", under "No interval polling". The terminal event for this section is a
// `workspace.stale` frame, and until this module existed only window focus was wired
// beside the reader's own subscribe: a path that
// went stale or a daemon that reconnected while the window stayed focused left the
// mount health, the workspace states, the roots, and the mode controls standing on
// the old read until something else happened to ask.
//
// ITS OWN MODULE, and not a third of `repo-mounts-reader.ts`. What that class owns is
// the read — which calls, in what order, and what it publishes when one does not
// answer. What this class owns is WHEN, which is a different subject with a different
// collaborator (the session store rather than the bridge) and its own teardown. They
// meet at one object, the family's `RefreshScheduler`, which is the whole seam.
//
// EVERY REASON IS ONE THE SCHEDULER ALREADY NAMES. `RefreshReason` is a closed set in
// `console/store/scheduling.ts`, and nothing here mints a member: a window focus is
// `window-focus`, a `workspace.stale` frame is the `terminal-event` arm — the "terminal
// events the owning spec names", which for a workspace is exactly this one — and the
// repair edge below is `reconnect`. Requesting is all this class does; the scheduler
// decides whether a burst becomes one read or several.
//
// WHY THE REPAIR EDGE IS THE RECONNECT SIGNAL. Nothing in the console publishes a
// bridge-level "reconnected" event, and inventing one here would be a fact this
// renderer never established. What the store DOES publish is `degradedCause`, set when
// the session's stream fails in any of the four ways `store/degradation.ts` names and
// cleared only by a completed re-pull. Its clearing edge is therefore the moment the
// session's projection is whole again after having not been — which is what the
// refresh policy means by reconnect, observed rather than assumed.
//
// A BASE STATE IS NOT A FRAME. `initialise()` establishes the session's history in one
// transition, and a `workspace.stale` sitting inside that backfill describes something
// the section's own live `repo.workspaceList` already reflects. Re-reading on it would
// put a second burst behind every session open for no new information, so the scan
// below runs only over transitions of an already-initialised store.

import type { SessionEventType } from "@ai-sidekicks/contracts";

import type { RefreshScheduler, SessionStore } from "../store/index.js";

/**
 * The one frame this section re-reads on.
 *
 * `satisfies SessionEventType` rather than a bare string: the type is the contract's
 * own census (`packages/contracts/src/event.ts`), so a kind renamed on the wire fails
 * to compile here instead of silently matching nothing for the life of the release.
 */
const WORKSPACE_STALE_EVENT_KIND = "workspace.stale" satisfies SessionEventType;

export interface RepoRefreshTriggerOptions {
  /** The family's one scheduler. Requested, never armed: this class owns no timer. */
  readonly scheduler: RefreshScheduler;
  /** The session whose frames and whose repair edge are two of the three reasons. */
  readonly sessionStore: SessionStore;
}

/**
 * Listen for the reasons to re-read, and route each to the scheduler.
 *
 * Idempotent on `start` and terminal on `dispose`, on the reader's own posture: React
 * mounts an effect twice in development strict mode, and a listener attached twice
 * would double every re-read in exactly the environment where the budget is watched.
 */
export class RepoRefreshTriggers {
  readonly #scheduler: RefreshScheduler;
  readonly #sessionStore: SessionStore;
  /** One detach per attached listener, run in `dispose` and then dropped. */
  readonly #detachers: (() => void)[] = [];
  #started = false;

  public constructor(options: RepoRefreshTriggerOptions) {
    this.#scheduler = options.scheduler;
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
    if (admitted.some((event) => event.kind === WORKSPACE_STALE_EVENT_KIND)) {
      this.#scheduler.request("terminal-event");
    }
  }
}

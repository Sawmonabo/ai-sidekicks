// When the run this pane is showing has moved under the answer it is holding.
//
// THE GAP THIS CLOSES. `Spec-017`'s run lifecycle is evented — twenty-four
// `workflow.*` types across five categories — and the run pane read its snapshot
// ONCE, re-reading only when an operator at this keyboard performed a control and the
// daemon served it. Every other way a run moves reached nothing: the engine advancing
// a phase, a park arming a resume, a second window's cancel, another participant's
// gate resolution. The pane showed a stale run indefinitely and nothing on screen said
// so.
//
// AND IT IS NOT A POLL. `Spec-023 §Rules every console surface obeys` puts reads on
// subscribe, on window focus, on reconnect, and on the terminal events the owning spec
// names, through one coalescing scheduler — and forbids an interval outright. This
// module is that policy applied to one run: `store/refresh-triggers.ts` observes the
// three outside reasons, `store/scheduling.ts` coalesces them, and what comes out is a
// ROUND NUMBER the snapshot read is keyed on. No timer is armed here beyond the
// scheduler's own coalescing window, and a session where nothing happens costs
// nothing.
//
// NO SECOND SUBSCRIPTION. The session's events are already held: `SessionStoreRegistry`
// opens one `session.subscribe` per open session and projects its frames into a
// `SessionStore`. What this watches is that store's own transitions, which is why the
// mechanism is `SessionRefreshTriggers` rather than a stream of its own — a second
// subscription for one pane would be a second copy of the session's history, a second
// cursor to keep, and a second answer to what the timeline holds.
//
// WHY A ROUND RATHER THAN A READ. The scheduler's performer normally puts a call on
// the wire. Here it advances a number that joins the snapshot read's SUBJECT KEY, and
// the read itself is `useSettledGrowthRead`'s — which already owns the supersession
// this performer's own `ReadRound` would otherwise carry: a new key settles the read
// during the render that brings it, so no frame shows the previous round's snapshot as
// the answer to the new question. Two supersession mechanisms over one read would be
// two places to decide whether an answer still counts.
//
// THE KINDS ARE UNREGISTERED AND ARMING AGAINST THEM IS SAFE. `packages/contracts`
// registers none of the twenty-four types — that is the `workflow-event-registration`
// slate row — so `bridge/wire-shapes/workflow-events.ts` declares the set and
// `ReadTriggerTarget` takes it as the `ReadonlySet<string>` it is. A kind no daemon
// emits never matches, so until the registration lands this reading refreshes on the
// other two reasons and on the operator's own acts; the day it lands, the third
// reason starts firing with no edit here.

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import {
  WORKFLOW_EVENT_TYPES,
  consoleClockFor,
  type ConsoleBridge,
} from "../../../bridge/index.js";
import { Emitter, type ConsoleClock, type Unsubscribe } from "../../../core/index.js";
import {
  CONTROLLER_DISPOSAL,
  RefreshScheduler,
  SessionRefreshTriggers,
  useSubjectScopedResource,
  type RefreshReason,
  type ReadTriggerTarget,
  type SessionStore,
} from "../../../store/index.js";

export interface WorkflowRunLiveRoundsOptions {
  readonly clock: ConsoleClock;
  /**
   * The session whose frames say this run moved.
   *
   * ABSENT on a pane with no session behind it — the deck can open a run pane from a
   * keybinding before a session is chosen. Such a reading observes nothing and its
   * round never advances, which is honest: with no store there is no timeline to
   * watch, and inventing one would be watching a session nobody named.
   */
  readonly sessionStore: SessionStore | undefined;
}

/**
 * How many times the run under this pane has been reported as having moved.
 *
 * A monotonic counter and deliberately not a snapshot: what a reader needs is "the
 * answer in hand is stale, ask again", and a number that only goes up says exactly
 * that with nothing else to keep in step. It is also why the value is safe to fold
 * into a subject key — every advance is a new key, and no advance is ever un-done.
 */
export class WorkflowRunLiveRounds implements ReadTriggerTarget {
  /**
   * The frames whose arrival owes this pane a fresh read.
   *
   * Declared on the READING rather than handed to it by the surface that mounts it,
   * which is `ReadTriggerTarget`'s own rule: which events change an answer is a
   * property of the question, and two panes asking the same one must not disagree
   * about when it goes stale.
   *
   * Every `workflow.*` type rather than a chosen few. A run read projects the run's
   * status, every phase's state, every live park and the pin it is frozen on, so
   * there is no type in the taxonomy that cannot move something this pane draws —
   * and a shorter list would be this module deciding which of the engine's own
   * announcements do not matter.
   */
  public readonly triggeringEventKinds: ReadonlySet<string> = new Set<string>(WORKFLOW_EVENT_TYPES);

  readonly #scheduler: RefreshScheduler;
  /** Absent with no session: there is nothing to observe and nothing to detach. */
  readonly #triggers: SessionRefreshTriggers | undefined;
  readonly #sessionStore: SessionStore | undefined;
  readonly #changes = new Emitter<number>("workflow run live round");

  #round = 0;
  #started = false;
  #disposed = false;

  public constructor(options: WorkflowRunLiveRoundsOptions) {
    this.#sessionStore = options.sessionStore;
    this.#scheduler = new RefreshScheduler({
      clock: options.clock,
      // The whole of the "read": advance the round and say so. A burst of frames —
      // a fan-out completing four phases at once — collapses into one advance, which
      // is one re-read rather than four.
      //
      // The performer's own `ReadRound` is deliberately unused: this puts nothing on
      // the wire, so there is no in-flight answer to supersede here. The read this
      // round drives is superseded by its own subject key, one module over.
      //
      // No `onError` is supplied, so a rejection re-throws rather than being
      // swallowed. Nothing in this path can refuse — the only way it rejects is a
      // subscriber throwing, which is a renderer defect and not a wire refusal, and
      // an `onError` that absorbed it would hide the one failure this can have.
      perform: () => {
        this.#advance();
        return Promise.resolve();
      },
    });
    this.#triggers =
      options.sessionStore === undefined
        ? undefined
        : new SessionRefreshTriggers({ target: this, sessionStore: options.sessionStore });
  }

  /** The round the caller keys its read on. Starts at zero and only ever rises. */
  public get round(): number {
    return this.#round;
  }

  /** Whether this reading has ended. How the resource seam recognises a corpse. */
  public get isDisposed(): boolean {
    return this.#disposed;
  }

  /**
   * Whether this reading watches `sessionStore`.
   *
   * `ArtifactPaneReader.isReadingFor`'s name and its reason: the seam keys on the
   * session id, and a projection rebuilt for the same session across a reconnect keeps
   * that key while being a different object — the one axis a key cannot carry. Without
   * the check this reading would go on listening to a store nothing else reads and its
   * round would stop advancing, silently.
   */
  public isReadingFor(sessionStore: SessionStore | undefined): boolean {
    return this.#sessionStore === sessionStore;
  }

  /**
   * Begin observing. Idempotent, because React mounts an effect twice in development
   * strict mode and a second observer would double every re-read in exactly the
   * environment where the budget is watched.
   */
  public start(): void {
    if (this.#started || this.#disposed) {
      return;
    }
    this.#started = true;
    this.#triggers?.start();
  }

  public subscribe(sink: (round: number) => void): Unsubscribe {
    return this.#changes.subscribe(sink);
  }

  /** Ask for the round to advance. The scheduler decides what a burst costs. */
  public requestRead(reason: RefreshReason): void {
    this.#scheduler.request(reason);
  }

  /**
   * Terminal. No later frame and no later focus can advance a round behind an unmount
   * or across a bridge swap — both schedulers this composes are terminal on dispose,
   * so a timer cannot outlive the pane that armed it.
   */
  public dispose(): void {
    this.#disposed = true;
    this.#triggers?.dispose();
    this.#scheduler.dispose();
  }

  #advance(): void {
    if (this.#disposed) {
      return;
    }
    this.#round += 1;
    this.#changes.emit(this.#round);
  }
}

/**
 * Mint one live-round reading for the window's bridge and the session in scope.
 *
 * THE SUBJECT IS THE BRIDGE AND THE KEY IS THE SESSION. A bridge swapped underneath —
 * the fixture's scenario switch, and the live shell's reconnect — is a different world
 * and mints a fresh reading, which is what makes the round start over rather than
 * carrying the previous scenario's count into the new one. The session is the key
 * because that is what a window holds many of.
 *
 * THE STORE AXIS IS AN EFFECT AND NOT PART OF THE KEY, which is
 * `use-artifact-reading.ts`'s split: a store rebuilt for the same session keeps the
 * whole address, so the replacement is published through the seam rather than keyed
 * on. `useSessionStoreRebind` is the same rule for callers whose store is required;
 * this pane's is optional, so the check is written here against the same member name.
 */
export function useWorkflowRunLiveRounds(
  bridge: ConsoleBridge,
  sessionStore: SessionStore | undefined,
): number {
  // The window's own clock, resolved once per bridge — `use-artifact-reading.ts`'s
  // shape. Under the fixture the scenario advances on frozen time, and a reading that
  // minted a clock of its own would coalesce on wall time while the world it watches
  // did not move.
  const clock = useMemo(() => consoleClockFor(bridge), [bridge]);
  const openRounds = useCallback(
    () => new WorkflowRunLiveRounds({ clock, sessionStore }),
    [clock, sessionStore],
  );
  const { value: rounds, settle } = useSubjectScopedResource(
    bridge,
    sessionStore?.sessionId,
    openRounds,
    CONTROLLER_DISPOSAL,
  );
  useEffect(() => {
    // THE STORE AXIS, AND ONLY IT. Disposal is the seam's, and the key already
    // carries the session — what is left is a projection rebuilt for the SAME session
    // across a reconnect, which keeps the whole address while being another object.
    if (!rounds.isReadingFor(sessionStore)) {
      settle()(openRounds());
      return;
    }
    rounds.start();
  }, [rounds, settle, sessionStore, openRounds]);
  const subscribe = useCallback(
    (onRoundChange: () => void) => rounds.subscribe(onRoundChange),
    [rounds],
  );
  const readRound = useCallback(() => rounds.round, [rounds]);
  return useSyncExternalStore(subscribe, readRound, readRound);
}

// When the run this pane is showing has moved under the answer it is holding.
//
// The run lifecycle is evented — twenty-one `workflow.*` types across four categories. A
// pane that read its snapshot once and re-read only when an operator at this keyboard
// performed a served control would go stale whenever the run moved another way: the
// engine advancing a phase, a park arming a resume, a second window's cancel or gate
// resolution. This module reports those moves as a round number the snapshot read is
// keyed on.
//
// AND IT IS NOT A POLL. The console's read policy puts reads on subscribe, on window
// focus, on reconnect, and on the terminal events the owning surface names, through one
// coalescing scheduler — and forbids an interval outright. This module is that policy
// applied to one run: `store/read/refresh-triggers.ts` observes the three outside
// reasons, `store/read/refresh-scheduler.ts` coalesces them, and what comes out is a
// ROUND NUMBER the snapshot read is keyed on. No timer is armed here beyond the
// scheduler's own coalescing window, and a session where nothing happens costs nothing.
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
// the read itself is `useSubjectRead`'s, which already owns the supersession this
// performer's own `ReadRound` would otherwise carry: a new key settles the read during
// the render that brings it, so no frame shows the previous round's snapshot as the
// answer to the new question. Two supersession mechanisms over one read would be two
// places to decide whether an answer still counts.
//
// AND IT IS SCOPED TO ONE RUN. A session runs many workflows, and every one of the
// twenty-one types is emitted for whichever run the engine advanced — so a reading that
// matched on KIND alone answered "something workflow-shaped happened in this session",
// which is true while another run is progressing and this one is not. Every pane in the
// window then re-read, once per frame, for as long as anything anywhere in the session
// was moving. The reading therefore takes the run it is about and admits a frame unless
// the frame names a different one; `ReadTriggerTarget.admitsTriggeringEvent` is the
// seam, and both of the console's trigger wirings consult it through one predicate so
// the two cannot come to disagree about when an answer goes stale.
//
// ARMING AGAINST THE KINDS IS SAFE. `packages/contracts` registers none of the twenty-one
// types, so `bridge/wire-shapes/workflow-events.ts` declares the set and
// `ReadTriggerTarget` takes it as the `ReadonlySet<string>` it is. A kind no daemon emits
// never matches, so this reading refreshes on the other two reasons and on the
// operator's own acts, and on these kinds when a daemon sends them. The same wire is why
// run scoping is a refusal of NAMED frames rather than a requirement for one: no
// registered payload guarantees the run id, and a reading that demanded it would go
// quiet on frames that omit it.

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import {
  WORKFLOW_EVENT_TYPES,
  workflowRunIdOfEventPayload,
} from "@renderer/services/wire-shapes/workflow-events.js";
import { consoleClockFor, type ConsoleBridge } from "@renderer/console/bridge/console-bridge.js";
import { Emitter, type Unsubscribe } from "@renderer/lib/emitter.js";
import { type ConsoleClock } from "@renderer/lib/clock.js";
import { CONTROLLER_DISPOSAL } from "@renderer/lib/subject-scoped/subject-scoped-disposal.js";
import { RefreshScheduler, type RefreshReason } from "@renderer/lib/reads/refresh-scheduler.js";
import { SessionRefreshTriggers } from "@renderer/store/reads/session-refresh-triggers.js";
import { useSubjectScopedResource } from "@renderer/hooks/subject-scoped/useSubjectScopedResource.js";
import { type ConsoleSessionEvent } from "@renderer/store/session/entities/entities.js";
import { type ReadTriggerTarget } from "@renderer/store/reads/read-triggers.js";
import { type SessionStore } from "@renderer/store/session/session-store.js";

/** What one live-round reading is opened against. */
export interface WorkflowRunLiveRoundsOptions {
  /** The window's clock, which the coalescing window is measured on. */
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
  /**
   * The run the pane holding this reading is showing.
   *
   * ABSENT on a pane that names no run, the same arm the store above has: such a pane
   * reads nothing, so there is no answer for a frame to make stale and every frame that
   * names a run names a different one.
   */
  readonly workflowRunId: string | undefined;
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
   *
   * THE KIND IS HALF THE QUESTION AND THE RUN IS THE OTHER HALF, which is what
   * {@link admitsTriggeringEvent} below adds. Every one of these types is emitted for
   * whichever run the engine advanced, so this set alone is "something workflow-shaped
   * happened somewhere in this session" — true of a run this pane is not showing.
   */
  public readonly triggeringEventKinds: ReadonlySet<string> = new Set<string>(WORKFLOW_EVENT_TYPES);

  readonly #scheduler: RefreshScheduler;
  /** Absent with no session: there is nothing to observe and nothing to detach. */
  readonly #triggers: SessionRefreshTriggers | undefined;
  readonly #sessionStore: SessionStore | undefined;
  readonly #workflowRunId: string | undefined;
  readonly #changes = new Emitter<number>("workflow run live round");

  #round = 0;
  #started = false;
  #disposed = false;

  public constructor(options: WorkflowRunLiveRoundsOptions) {
    this.#sessionStore = options.sessionStore;
    this.#workflowRunId = options.workflowRunId;
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
   * Whether this frame is about the run this reading is watching.
   *
   * THE RULE IS "UNLESS IT NAMES A DIFFERENT RUN", not "only if it names this one", and
   * the difference is the whole of what this method decides. A frame carrying a run
   * identifier is attributable and is admitted for this run and refused for every
   * other. A frame carrying none is not attributable at all, and this reading cannot
   * rule it out, so it is admitted and the pane re-reads.
   *
   * The asymmetry is deliberate. No registered payload guarantees the run id on the
   * frame, so a reading that demanded one would go quiet on every frame that omits it and
   * leave the pane stale. Admitting the unattributable frame gives up only the saving of
   * skipping a read, and only for frames nobody could attribute.
   *
   * WITH NO RUN ADDRESSED every named frame names a different run and is refused, which
   * falls out of the same comparison rather than being a second rule: such a pane has
   * put no read, so there is no answer for a frame to make stale.
   */
  public admitsTriggeringEvent(event: ConsoleSessionEvent): boolean {
    const namedRunId = workflowRunIdOfEventPayload(event.payload);
    return namedRunId === undefined || namedRunId === this.#workflowRunId;
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
 * Mint one live-round reading for the window's bridge, the session, and the run shown.
 *
 * THE SUBJECT IS THE BRIDGE AND THE KEY IS THE SESSION AND THE RUN. A bridge swapped
 * underneath — the live shell's reconnect — is a different world and mints a fresh
 * reading, so the round starts over rather than carrying the previous bridge's count into
 * the new one. The session and the run are the key because a window holds many of both,
 * and because the run is what this reading ADMITS frames against: a pane is retargeted
 * from one run to another without ever unmounting, so a reading keyed on the session
 * alone would go on admitting the run the pane had left and refusing the one it had
 * moved to.
 *
 * THE KEY IS DERIVED, which is `run-snapshot.ts`'s own shape for a subject compared by
 * value: one string, composed in one place, out of the facts that make this a different
 * question. A round starting over on a retarget costs nothing, because the read it
 * drives is keyed on the run as well and is a fresh question either way.
 *
 * THE STORE AXIS IS AN EFFECT AND NOT PART OF THE KEY, which is
 * `use-artifact-reading.ts`'s split: a store rebuilt for the same session keeps the
 * whole address, so the replacement is published through the seam rather than keyed
 * on. `useSessionStoreRebind` is the same rule for callers whose store is required;
 * this pane's is optional, so the check is written here against the same member name.
 *
 * @consumedBy the run pane's live refresh
 */
export function useWorkflowRunLiveRounds(
  bridge: ConsoleBridge,
  sessionStore: SessionStore | undefined,
  workflowRunId: string | undefined,
): number {
  // The window's own clock, resolved once per bridge — `use-artifact-reading.ts`'s
  // shape. A reading that minted a clock of its own would coalesce on wall time while
  // the world it watches ran on the window's.
  const clock = useMemo(() => consoleClockFor(bridge), [bridge]);
  const openRounds = useCallback(
    () => new WorkflowRunLiveRounds({ clock, sessionStore, workflowRunId }),
    [clock, sessionStore, workflowRunId],
  );
  const { value: rounds, settle } = useSubjectScopedResource(
    bridge,
    readingSubjectKey(sessionStore?.sessionId, workflowRunId),
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

/**
 * The subject this reading is held at: the session it watches and the run it is about.
 *
 * BOTH ABSENCES ARE SPELLED, and that is why the parts are joined rather than
 * concatenated raw: a pane with no session showing run `x` and a pane in session `x`
 * showing no run are two different readings, and a bare join would give both the same
 * key. Neither identifier can contain the separator — both are opaque wire values the
 * daemon mints — so the composition is unambiguous over the values that actually occur.
 */
function readingSubjectKey(
  sessionId: string | undefined,
  workflowRunId: string | undefined,
): string {
  return `${sessionId ?? "no-session"}#${workflowRunId ?? "no-run"}`;
}

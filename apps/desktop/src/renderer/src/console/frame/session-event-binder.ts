// The one thing in the console that subscribes to the bridge.
//
// `store/hooks.ts` states the rule this module realises: "No component subscribes
// to the bridge. Components subscribe to a STORE, and exactly one thing subscribes
// to the bridge — the apply chokepoint." Until this class there was no such thing.
// `SessionStoreRegistry.enqueue` had no caller anywhere in the tree and nothing
// called `daemon.subscribe`, so a session opened in the console received nothing:
// the fixture scenario's beats reached nobody, every view family would have
// rendered an empty projection of a live session, and the endurance tier was
// measuring an idle loop rather than a console under load.
//
// WHY IT LIVES IN `frame/` AND NOT IN `store/`
//
// It is the one object that has to know both ends — the registry's `enqueue` and
// the bridge's `daemon.subscribe`. `store/` sits BELOW `bridge/` in the console's
// family DAG precisely so that a store cannot reach a wire, and putting the binder
// there would invert that edge for the whole family. `frame/` is the composition
// root; joining two families it already imports is what a composition root is for.
//
// THREE PROPERTIES, EACH A FAILURE THIS CLASS EXISTS TO MAKE UNREPRESENTABLE
//
//   • **One apply path.** Every delivered event reaches the store through
//     `registry.enqueue`, which is the queue in front of `SessionStore.applyBatch`.
//     This class never touches a store, holds no store reference, and has no way
//     to write one — so "the chokepoint is the only writer" stays a structural
//     property rather than a convention a reviewer polices.
//   • **One subscription path.** A session's wire subscription is opened when the
//     registry says the session opened and closed when it says it closed, so a
//     subscription cannot outlive the store it feeds, and a store cannot exist
//     with nothing feeding it.
//   • **No lost open.** `attach` binds every session that is ALREADY open before
//     it subscribes to further changes. A binder that only listened for changes
//     would silently miss a session opened between construction and attachment,
//     and the symptom — one session that never updates — looks like a wire fault
//     rather than a wiring one.
//   • **No stream into a store that cannot be initialised.** A store buffers
//     rather than applies until a read gives it a base state, so binding a stream
//     to a registry whose `read` is a refusal rather than a reader feeds a buffer
//     nothing will ever drain — a long-running session retains its whole event
//     stream and projects none of it. `attach` reads
//     `SessionStoreRegistry.canInitialiseSessionStores` and takes no subscription
//     at all when the answer is no. Structural rather than a check the composition
//     root makes: every caller gets it, and it cannot be forgotten by the next one.
//   • **No subscription without the read that makes it mean something.** The
//     converse of the rule above, and it was the half that was missing: binding a
//     stream and never asking for a base state leaves the store buffering exactly
//     as if no read existed. `#bindSession` requests the read in the same act as
//     taking the subscription, so the two cannot be separated by a caller who
//     remembers one of them.
//   • **No session left unbound because the wire was away when it opened.** A
//     `daemon.subscribe` that throws leaves the session with no stream and no base
//     state, and the registry's `opened` change has already been delivered. What is
//     remembered about that, and what one returning edge is worth, is
//     `unbound-session-retry.ts` — a second subject this class was carrying.
//
// AND THE EDGE IT RETRIES ON IS NOT ONE THIS CLASS PRODUCES
//
// It was, and that was a deadlock rather than an economy. This class reported
// `unreachable` from its own failed open and `reachable` from its own successful one,
// and it is the only live-path consumer of the returning edge — so a window whose ONLY
// session failed to bind held the one state that could never change: the retry needed
// an edge, and the edge needed a bind. Transport recovery alone could not reach that
// session, and nothing on screen said why.
//
// So the observation moved DOWN, onto the door every daemon subscription in the window
// goes through (`bridge/transport/observed-subscription.ts`, reported into by
// `bridge/daemon/daemon-streams.ts` and `seats/wire-access.ts` as well as by the open
// below). This class reports nothing and subscribes once, for its whole life, to a
// signal other openers move: the node's provider-account tail coming back is a
// returning edge, and it is one a window with no bindable session can still observe.
//
// WHAT THE WIRE ACTUALLY OFFERS, AND WHAT THIS DOES ABOUT IT
//
// The preload contract declares `daemon.subscribe(event, handler)`: it names an
// EVENT and carries no parameter object, so there is nowhere on the call to put a
// session id. The session filter is therefore applied here, at the delivery
// boundary, against the session this subscription was opened for. One subscription
// per session is kept anyway rather than one shared subscription with a routing
// table, because the per-session subscription is what a parameter-carrying
// `session.subscribe` will need: when the wire grows a request shape, this call
// gains an argument and nothing else about the lifecycle moves.
//
// Reading a delivered payload is a different job, in `bridge/daemon/session-event-payload.ts`:
// this module owns WHICH sessions are bound and for how long, that one owns WHAT a delivered
// payload has to look like. The fixture handle is a third, in `session-diagnostics-handle.ts`:
// this class composes what the endurance tier may read — the three reads below, closed over
// this binder's own state — and that module owns the page property, the define that gates it,
// and the identity check that keeps a replaced binder's teardown from deleting the live one's
// handle. Splitting them is what stops a lifecycle file from being three files' worth of job.

import type { Unsubscribe } from "../core/index.js";
import { lossyStringify, reportTripwire } from "../core/index.js";
import {
  SESSION_EVENT_STREAM,
  openObservedSubscription,
  readConsoleSessionEvent,
  type ConsoleBridge,
} from "../bridge/index.js";
import {
  SessionDiagnosticsHandle,
  type ConsoleSessionDiagnostics,
} from "./session-diagnostics-handle.js";
import { UnboundSessionRetry } from "./unbound-session-retry.js";
import type { SessionStoreRegistry } from "../store/index.js";

/** The site every tripwire this module reports names. */
const SITE = "console/frame/session-event-binder.ts";

/**
 * The subscribe call, with the one brand bypass this module makes.
 *
 * The bridge declares `daemon.subscribe<E extends DaemonEvent>(event: E, handler:
 * (payload: DaemonEventPayload<E>) => void): Unsubscribe`, where the event name is
 * a `never`-shaped brand and the payload resolves to `unknown` — both stubs until
 * the daemon's event union lands. The event name is pinned to `string` (the
 * genuinely untypeable half) and the payload left `unknown`, which is honest: a
 * tighter payload type here would be a fiction, and `readConsoleSessionEvent`
 * (`bridge/daemon/session-event-payload.ts`) is what turns the `unknown` into something the
 * store may hold. Same posture as the two shipped renderer families that already
 * subscribe this way.
 */
type SessionStreamSubscribe = (event: string, handler: (payload: unknown) => void) => Unsubscribe;

export interface SessionEventBinderOptions {
  readonly registry: SessionStoreRegistry;
  readonly bridge: ConsoleBridge;
}

export class SessionEventBinder {
  readonly #registry: SessionStoreRegistry;
  readonly #bridge: ConsoleBridge;
  readonly #unsubscribeBySessionId = new Map<string, Unsubscribe>();
  readonly #appliedEventCountBySessionId = new Map<string, number>();
  /** Which failed opens are remembered, and what one returning edge is worth. */
  readonly #retry: UnboundSessionRetry;
  readonly #diagnosticsHandle = new SessionDiagnosticsHandle();
  #unsubscribeFromRegistry: Unsubscribe | undefined;
  #unsubscribeFromTransportReconnect: Unsubscribe | undefined;
  #unreadableDeliveryCount = 0;
  #droppedAfterCloseCount = 0;
  #attached = false;
  #disposed = false;

  public constructor(options: SessionEventBinderOptions) {
    this.#registry = options.registry;
    this.#bridge = options.bridge;
    // The three questions a pass asks, answered from here so the retry can reach a
    // retained id and nothing else — not a subscription map, not a store, not a wire.
    this.#retry = new UnboundSessionRetry({
      isRetired: () => this.#disposed,
      isStillOpen: (sessionId) => this.#registry.has(sessionId),
      rebind: (sessionId) => {
        this.#bindSession(sessionId);
      },
    });
  }

  /**
   * Start binding: subscribe to the registry, then bind what is already open.
   *
   * The registry subscription is taken FIRST and the already-open sweep runs
   * second, which is the order that cannot drop a session. Sweeping first would
   * leave a window between the sweep and the subscription in which an open goes
   * unobserved; taking the subscription first can at worst bind a session twice,
   * and `#bindSession` is idempotent by session id.
   *
   * A registry that can initialise no store gets NEITHER subscription — not the
   * registry's change feed and not the wire's — because every delivery would land
   * in a pre-initialisation buffer nothing can ever drain. The diagnostics handle
   * is still installed on that arm: "bound: none, applied: zero" is a reading, and
   * an absent handle is indistinguishable from a build with no binder at all.
   *
   * A THIRD SUBSCRIPTION IS TAKEN ON THAT SAME ARM: the transport's returning edge,
   * which is what re-attempts the sessions whose open threw. ONE subscription for this
   * binder's whole life, taken at its single lifecycle door rather than per session
   * bind or per render — the retained set is what a returning edge is walked against,
   * and a per-bind subscription would walk it once per session. The edge is produced by
   * the console's subscription doors and never by this class, so the retry costs no
   * probe, no timer, and no second reading of whether the wire is there — and the signal
   * emits only on `unreachable → reachable`, so a window whose wire never went away pays
   * nothing.
   *
   * Idempotent, and a no-op once disposed: a disposed binder holds no
   * subscription and must not be able to start one from a late effect.
   */
  public attach(): void {
    if (this.#disposed || this.#attached) {
      return;
    }
    this.#attached = true;
    if (this.#registry.canInitialiseSessionStores) {
      this.#unsubscribeFromRegistry = this.#registry.subscribe((change) => {
        if (change.change === "opened") {
          this.#bindSession(change.sessionId);
          return;
        }
        this.#unbindSession(change.sessionId);
      });
      this.#unsubscribeFromTransportReconnect = this.#bridge.transportReconnect.subscribe(() => {
        this.#retry.runOnePass();
      });
      for (const sessionId of this.#registry.openSessionIds) {
        this.#bindSession(sessionId);
      }
    }
    this.#diagnosticsHandle.install(this.#buildFixtureDiagnostics());
  }

  /** Sessions this binder holds a wire subscription for, in bind order. */
  public get boundSessionIds(): readonly string[] {
    return [...this.#unsubscribeBySessionId.keys()];
  }

  /** Open sessions whose stream could not be opened. The retry's own reading. */
  public get unboundSessionIds(): readonly string[] {
    return this.#retry.retainedSessionIds;
  }

  /** Binds re-attempted on a returning transport edge, whether or not they took. */
  public get retriedBindCount(): number {
    return this.#retry.retriedBindCount;
  }

  /** Events admitted to one session's apply chokepoint. Frozen once it closes. */
  public appliedEventCountFor(sessionId: string): number {
    return this.#appliedEventCountBySessionId.get(sessionId) ?? 0;
  }

  /**
   * Deliveries the wire made for a session that was no longer open.
   *
   * Counted rather than merely dropped: the drop is correct — the store they were
   * bound for is gone — but a stream still delivering into a closed session is a
   * leak upstream, and a count is how it becomes visible. Mirrors
   * `ApplyQueue.droppedAfterDisposeCount`, one layer up.
   */
  public get droppedAfterCloseCount(): number {
    return this.#droppedAfterCloseCount;
  }

  /**
   * Deliveries whose payload was not a session event this console can read.
   *
   * Counted and not reported on the tripwire, which is a deliberate split. A
   * tripwire is a detector for CONSOLE invariants; a payload shape is a WIRE fact,
   * and firing one here would report every event type the console has not learned
   * yet as a defect in the console. The count is the honest reading: it says how
   * much of the stream this build could not project, without claiming to know
   * whose fault that is.
   */
  public get unreadableDeliveryCount(): number {
    return this.#unreadableDeliveryCount;
  }

  public get isDisposed(): boolean {
    return this.#disposed;
  }

  /**
   * Release every subscription this binder holds. Final, and idempotent.
   *
   * The applied-event counts survive on purpose — see
   * `ConsoleSessionDiagnostics.appliedEventCountFor` — but nothing can read them
   * afterwards, because the fixture handle is removed here too.
   */
  public dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#unsubscribeFromRegistry?.();
    this.#unsubscribeFromRegistry = undefined;
    this.#unsubscribeFromTransportReconnect?.();
    this.#unsubscribeFromTransportReconnect = undefined;
    for (const unsubscribe of this.#unsubscribeBySessionId.values()) {
      unsubscribe();
    }
    this.#unsubscribeBySessionId.clear();
    // Released with the rest: a retained id is a promise to re-attempt, and a
    // disposed binder makes none.
    this.#retry.clear();
    this.#diagnosticsHandle.remove();
  }

  /**
   * Open one session's stream, and report what that told us about the transport.
   *
   * THE OPEN GOES THROUGH THE DOOR THAT OWNS WHAT AN OPEN PROVES, and this class
   * therefore reports nothing itself. `openObservedSubscription` tells the signal what
   * the transport did on this call exactly as it does for every other subscription the
   * window takes; a second, hand-written report here would be the same claim made twice
   * — and when it was the ONLY claim, this class was both the producer of the returning
   * edge and its only consumer, which is a deadlock rather than an economy.
   *
   * A throw used to leave this method as itself, out of the registry callback that
   * called it and into a mount effect, taking the window down for a transport that
   * was merely away. It is now recorded on three surfaces, and each one answers a
   * question the others cannot. The SIGNAL is told the wire is unreachable — by the
   * door, on the way out — so the returning edge exists at all. The session's own STORE
   * is marked `subscription-closed` through the registry — the declared degraded cause
   * `degradation.ts` reserves for "a wire that stopped", so the session shows a stream
   * it does not have as a named degradation rather than as a quiet, permanently empty
   * projection. And the id is RETAINED, so the edge has something to re-attempt.
   *
   * The store's cause is sticky until a completed re-pull clears it, which is exactly
   * right here — the retry asks for that re-pull, so a session that comes back stops
   * being degraded because it was re-read and not because it was re-subscribed.
   */
  #bindSession(sessionId: string): void {
    if (this.#disposed || this.#unsubscribeBySessionId.has(sessionId)) {
      return;
    }
    const subscribe = this.#bridge.sidekicks.daemon.subscribe as SessionStreamSubscribe;
    let release: Unsubscribe;
    try {
      release = openObservedSubscription(this.#bridge.transportReconnect, () =>
        subscribe(SESSION_EVENT_STREAM, (payload) => {
          this.#deliver(sessionId, payload);
        }),
      );
    } catch (subscriptionFailure: unknown) {
      this.#retry.retain(sessionId);
      this.#registry.markDegraded(sessionId, "subscription-closed");
      reportTripwire(
        "apply-chokepoint-bypass",
        SITE,
        `the event stream for session ${sessionId} could not be opened (${lossyStringify(subscriptionFailure)}); the binder holds no subscription for it, its store is marked subscription-closed, and the session is retried on the transport's returning edge`,
      );
      return;
    }
    this.#retry.forget(sessionId);
    this.#unsubscribeBySessionId.set(sessionId, release);
    // The read that gives the store its base state, asked for at the one moment
    // that knows a stream just started. `subscribe` is a registered refresh reason
    // and means precisely this. Without it a bound session buffers forever —
    // nothing else in the console calls `requestRefresh` on an open, so the store
    // layer stayed dormant even where a read WAS available. The refusal arm is
    // unreachable here (this runs on the registry's own `opened` change, so the
    // session is open) and is dropped rather than checked: a re-check would be a
    // second answer to a question the caller already answered.
    this.#registry.requestRefresh(sessionId, "subscribe");
  }

  #unbindSession(sessionId: string): void {
    // Dropped whether or not a subscription was ever taken: a session that closes
    // has nothing left to retry, and this is what bounds the retained set by the
    // open set rather than by the window's life.
    this.#retry.forget(sessionId);
    const unsubscribe = this.#unsubscribeBySessionId.get(sessionId);
    if (unsubscribe === undefined) {
      return;
    }
    this.#unsubscribeBySessionId.delete(sessionId);
    unsubscribe();
  }

  /**
   * One delivered payload, on the subscription opened for one session.
   *
   * The close race is real rather than theoretical and is why the refusal arm
   * exists: emission iterates a SNAPSHOT of the subscribers, so a listener that
   * closes a session part-way through a delivery still leaves this handler in the
   * batch being delivered — correctly, since it was subscribed when emission
   * began. `enqueue` answers with a refusal instead of throwing for exactly that
   * case, and a throw here would break the wire's own subscription for every other
   * session on it.
   */
  #deliver(sessionId: string, payload: unknown): void {
    const event = readConsoleSessionEvent(payload);
    if (event === undefined) {
      this.#unreadableDeliveryCount += 1;
      return;
    }
    if (event.sessionId !== sessionId) {
      // Another session's row, seen because the wire subscription carries no
      // session filter. Not a fault and not counted: the subscription opened for
      // THAT session is the one delivering it.
      return;
    }
    const refusal = this.#registry.enqueue(sessionId, [event]);
    if (refusal !== undefined) {
      this.#droppedAfterCloseCount += 1;
      reportTripwire(
        "apply-chokepoint-bypass",
        SITE,
        `a wire delivery for session ${sessionId} arrived after that session closed; the binder dropped it (${refusal.code}) rather than delivering into a store this window no longer holds`,
      );
      return;
    }
    this.#appliedEventCountBySessionId.set(sessionId, this.appliedEventCountFor(sessionId) + 1);
  }

  #buildFixtureDiagnostics(): ConsoleSessionDiagnostics {
    return Object.freeze({
      openSessionIds: (): readonly string[] => this.#registry.openSessionIds,
      appliedEventCountFor: (sessionId: string): number => this.appliedEventCountFor(sessionId),
      boundSessionIds: (): readonly string[] => this.boundSessionIds,
    });
  }
}

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
//     to a registry whose `read` is `SESSION_READ_UNREGISTERED` feeds a buffer
//     nothing will ever drain — a long-running session retains its whole event
//     stream and projects none of it. `attach` reads
//     `SessionStoreRegistry.canInitialiseSessionStores` and takes no subscription
//     at all when the answer is no. Structural rather than a check the composition
//     root makes: every caller gets it, and it cannot be forgotten by the next one.
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

import type { Unsubscribe } from "../core/index.js";
import { SESSION_DIAGNOSTICS_FIXTURE_GLOBAL, reportTripwire } from "../core/index.js";
import { SESSION_EVENT_STREAM, type ConsoleBridge } from "../bridge/index.js";
import type { ConsoleSessionEvent, SessionStoreRegistry } from "../store/index.js";

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
 * below is what turns the `unknown` into something the store may hold. Same
 * posture as the two shipped renderer families that already subscribe this way.
 */
type SessionStreamSubscribe = (event: string, handler: (payload: unknown) => void) => Unsubscribe;

/**
 * What a fixture build exposes to the endurance tier, and nothing more.
 *
 * Three reads, no writes and no handles: a tier driving a real window from outside
 * the renderer can ask what is open, what is bound, and how much has flowed, and
 * cannot open a session, close one, or apply an event.
 */
export interface ConsoleSessionDiagnostics {
  /** Sessions the registry currently holds a store for, in open order. */
  openSessionIds: () => readonly string[];
  /**
   * Events this window has put through one session's apply chokepoint.
   *
   * Deliberately NOT the store's timeline length: a store admits nothing until a
   * read gives it a base state, so a timeline reading is zero for every session
   * whose read has not landed, and a diagnostic that reports the same number
   * whether or not this binder exists is worse than no diagnostic at all. This
   * counts admissions to the chokepoint: deliveries the registry accepted for a
   * session's apply queue. It is zero — correctly, and beside `boundSessionIds()`
   * reading empty — on a window whose registry can initialise no store, because
   * that window takes no wire subscription in the first place.
   *
   * Retained after a session closes, so the count FREEZES rather than vanishing.
   * A reading that disappeared on close could not be told apart from a session
   * that never received anything.
   */
  appliedEventCountFor: (sessionId: string) => number;
  /** Sessions this binder currently holds a wire subscription for. */
  boundSessionIds: () => readonly string[];
}

/*
 * The property a fixture build hangs the session diagnostics on.
 *
 * Declared in `core/fixture-globals.ts` and re-exported here, so this installer
 * and the release-absence sweep that proves the handle absent read one string.
 * Re-exported rather than only imported because the tier that reads it reaches
 * this module by name, so a rename is a compile error there instead of a check
 * that silently starts reading `undefined` and reports nothing forever.
 */
export { SESSION_DIAGNOSTICS_FIXTURE_GLOBAL };

export interface SessionEventBinderOptions {
  readonly registry: SessionStoreRegistry;
  readonly bridge: ConsoleBridge;
}

export class SessionEventBinder {
  readonly #registry: SessionStoreRegistry;
  readonly #bridge: ConsoleBridge;
  readonly #unsubscribeBySessionId = new Map<string, Unsubscribe>();
  readonly #appliedEventCountBySessionId = new Map<string, number>();
  #unsubscribeFromRegistry: Unsubscribe | undefined;
  #installedDiagnostics: ConsoleSessionDiagnostics | undefined;
  #unreadableDeliveryCount = 0;
  #droppedAfterCloseCount = 0;
  #attached = false;
  #disposed = false;

  public constructor(options: SessionEventBinderOptions) {
    this.#registry = options.registry;
    this.#bridge = options.bridge;
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
      for (const sessionId of this.#registry.openSessionIds) {
        this.#bindSession(sessionId);
      }
    }
    this.#installFixtureDiagnostics();
  }

  /** Sessions this binder holds a wire subscription for, in bind order. */
  public get boundSessionIds(): readonly string[] {
    return [...this.#unsubscribeBySessionId.keys()];
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
    for (const unsubscribe of this.#unsubscribeBySessionId.values()) {
      unsubscribe();
    }
    this.#unsubscribeBySessionId.clear();
    this.#removeFixtureDiagnostics();
  }

  #bindSession(sessionId: string): void {
    if (this.#disposed || this.#unsubscribeBySessionId.has(sessionId)) {
      return;
    }
    const subscribe = this.#bridge.sidekicks.daemon.subscribe as SessionStreamSubscribe;
    this.#unsubscribeBySessionId.set(
      sessionId,
      subscribe(SESSION_EVENT_STREAM, (payload) => {
        this.#deliver(sessionId, payload);
      }),
    );
  }

  #unbindSession(sessionId: string): void {
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

  /*
   * Expose the reads to the page under the fixture define, and only there.
   *
   * The same guard, and for the same reason, as the tripwire registry's: the
   * endurance tier drives a real window from outside the renderer, so the only way
   * it can read this binder is through the page, and letting the tier treat an
   * unreachable binder as "nothing to assert" would be a check that passes whether
   * or not the thing it measures exists.
   *
   * `__SIDEKICKS_CONSOLE_FIXTURES__` is a literal at build time, so a release
   * bundle contains neither the property nor the object it would have held.
   */
  #installFixtureDiagnostics(): void {
    if (__SIDEKICKS_CONSOLE_FIXTURES__) {
      const diagnostics = this.#buildFixtureDiagnostics();
      this.#installedDiagnostics = diagnostics;
      (globalThis as Record<string, unknown>)[SESSION_DIAGNOSTICS_FIXTURE_GLOBAL] = diagnostics;
    }
  }

  /**
   * Remove this binder's handle, and only this binder's.
   *
   * One property, one renderer process — the tripwire registry's posture — so a
   * second console mounted in the same page replaces the first one's handle. The
   * identity check is what keeps the teardown of the REPLACED binder from deleting
   * the live one's.
   */
  #removeFixtureDiagnostics(): void {
    if (__SIDEKICKS_CONSOLE_FIXTURES__) {
      const page = globalThis as Record<string, unknown>;
      if (
        this.#installedDiagnostics !== undefined &&
        page[SESSION_DIAGNOSTICS_FIXTURE_GLOBAL] === this.#installedDiagnostics
      ) {
        delete page[SESSION_DIAGNOSTICS_FIXTURE_GLOBAL];
      }
      this.#installedDiagnostics = undefined;
    }
  }
}

/** The members read off a delivered payload, before anything is known about them. */
interface DeliveredPayloadShape {
  readonly sessionId?: unknown;
  readonly sequence?: unknown;
  readonly kind?: unknown;
  readonly occurredAt?: unknown;
  readonly actorParticipantId?: unknown;
  readonly payload?: unknown;
}

/**
 * Narrow a wire payload into the console's own event shape, or refuse it.
 *
 * `store/entities.ts` says where this belongs: `ConsoleSessionEvent` is a
 * renderer-local projection contract rather than a wire type, and "the bridge
 * adapter narrows a payload into this shape at the boundary, so exactly one module
 * knows the wire and everything above it reads this". This function is that
 * boundary for the session stream — the only place in the console that reads
 * fields off an `unknown` the bridge handed over.
 *
 * It narrows and it does not TRANSLATE. Where a delivered payload names its fields
 * differently the answer is a refusal, not a guess: a mapping invented here would
 * put wire member names in a module that has no contract to check them against,
 * and a mis-mapped field renders as confidently as a correct one.
 *
 * `sequence` must be an integer because the store's dedupe set, cursor, and gap
 * detection all key on it — a fractional sequence would make `cursor + 1` name a
 * position no event can ever occupy, and the session would be permanently
 * degraded by a gap that never closes.
 */
function readConsoleSessionEvent(deliveredPayload: unknown): ConsoleSessionEvent | undefined {
  if (typeof deliveredPayload !== "object" || deliveredPayload === null) {
    return undefined;
  }
  const { sessionId, sequence, kind, occurredAt, actorParticipantId, payload } =
    deliveredPayload as DeliveredPayloadShape;
  if (
    typeof sessionId !== "string" ||
    typeof sequence !== "number" ||
    !Number.isInteger(sequence) ||
    typeof kind !== "string" ||
    typeof occurredAt !== "string"
  ) {
    return undefined;
  }
  if (actorParticipantId !== undefined && typeof actorParticipantId !== "string") {
    return undefined;
  }
  if (
    payload !== undefined &&
    (typeof payload !== "object" || payload === null || Array.isArray(payload))
  ) {
    // An array is `typeof "object"` and is not a keyed payload. Admitting one
    // would hand every projector a value whose named members are all `undefined`
    // at a type that says they are readable.
    return undefined;
  }
  return {
    sessionId,
    sequence,
    kind,
    occurredAt,
    ...(actorParticipantId === undefined ? {} : { actorParticipantId }),
    // The one cast: the checks above establish a non-null object, which is all a
    // projector may assume about a payload it has not claimed a kind for.
    ...(payload === undefined ? {} : { payload: payload as Readonly<Record<string, unknown>> }),
  };
}

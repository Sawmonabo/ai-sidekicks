// The one thing in the renderer that subscribes to the bridge. Components subscribe to a store,
// and this feeds every store through `registry.enqueue`, the queue in front of
// `SessionStore.applyBatch`; without it a session opened in a window receives nothing. It lives in
// `services/` because it must know both the registry and `daemon.subscribe`, and `store/` sits
// below `services/` so a store cannot reach a wire. `app/hooks/useSessionStoreRegistry.ts`
// composes it with the registry.
//
// - One apply path: it holds no store reference, so the queue is the only writer.
// - One subscription path: a session's wire subscription opens when the registry says the session
//   opened and closes when it closed, so it cannot outlive its store.
// - No lost open: `attach` binds every session already open before listening for changes.
// - No subscription without a read: `#bindSession` requests the base-state read in the same act
//   as taking the subscription.
// - No session left unbound because the wire was away when it opened:
//   `failed-subscription-retry.ts` remembers failed opens and retries them on the returning edge.
// - No feed lost when it stops: a stream that ends after it opened is opened again from the
//   cursor of the last change it delivered, so the daemon catches up from there and nothing is
//   missed or applied twice. One that delivered since it opened is opened again through the
//   re-open waits (`reopen-backoff.ts`), so a stream that catches up and ends every time is not
//   opened in a loop; one that did not waits for the returning edge, so a stream the daemon keeps
//   ending never spins, and one the daemon refused is also tried again after a wait. A cursor the
//   daemon can no longer resolve is dropped and the session re-read instead. Nothing is drawn for
//   any of it: the service being unreachable is the status topic's to say.
//
// This class only consumes the returning edge; if it also produced it from its own opens, a
// window whose only session failed to bind could never retry. The edge is reported by
// `services/daemon/status.ts` from main's reading of the link, and by
// `services/transport/observed-subscription.ts`, which every daemon subscription goes through, so
// a window whose every stream ended with the service still sees it come back.
//
// Each session gets its own `session.subscribe`, and deliveries are still checked against that
// session because the stream comes from another process. A delivery is a frame: a batch of events
// oldest first, or the caught-up frame with none. When the daemon drops changes for this
// connection, the next frame carries the drop mark. The hole is measured in sequences, from the
// last change delivered to the frame's first, since the cursors are opaque. Within
// `MAX_REPAIRABLE_SEQUENCE_GAP` the frame is set aside and the stream opened again after the last
// change delivered, so the daemon fills the hole in order and the store never sees it; a
// caught-up frame names no sequence, so it is filled the same way. Past the bound the frame is
// applied and the session's re-read asked for, which shows the catching-up line. Reading a frame
// is `services/daemon/session/event/payload.ts`. The four reads the endurance tier makes
// (`diagnostics-handle.ts`) are composed here and handed out as `diagnostics`.

import { EVENT_CURSOR_UNRESOLVABLE_CODE } from "@ai-sidekicks/contracts/error";
import type { EventCursor } from "@ai-sidekicks/contracts/session/id";

import type { TranscriptWindowReading } from "#renderer/lib/transcript-window-diagnostics.js";
import { describeSubscriptionEnd, type DaemonSubscriptionEnd } from "#shared/daemon/forwarding.js";
import type { Unsubscribe } from "#shared/preload-api.js";
import { RealClock, type Clock } from "#renderer/lib/clock.js";
import {
  diagnosticStampAt,
  windowDiagnosticCapture,
} from "#renderer/lib/diagnostic-capture/capture.js";
import { transcriptWindowDiagnostics } from "#renderer/lib/transcript-window-diagnostics.js";
import { lossyStringify } from "#renderer/lib/wire/errors.js";
import { SESSION_EVENT_STREAM } from "#shared/daemon/streams.js";
import { MAX_REPAIRABLE_SEQUENCE_GAP } from "#renderer/store/session/caps.js";
import type { ProjectedSessionEvent } from "#renderer/store/session/entities/vocabulary.js";
import { readSessionId } from "../daemon/wire/identifiers.js";
import { openObservedSubscription } from "../transport/observed-subscription.js";
import { ReopenBackoff } from "../transport/reopen-backoff.js";
import { readSessionStreamFrame } from "../daemon/session/event/payload.js";
import { type PlatformBridge } from "../platform/bridge.js";
import { type SessionDiagnostics } from "./diagnostics-handle.js";
import { FailedSubscriptionRetry } from "./failed-subscription-retry.js";
import type { SessionStoreRegistry } from "#renderer/store/session/registry.js";

/** The source every diagnostic record this module captures names. */
const DIAGNOSTIC_SOURCE = "services/session-events";

/** Options for `SessionEventSubscriber`. */
export interface SessionEventSubscriberOptions {
  readonly registry: SessionStoreRegistry;
  readonly bridge: PlatformBridge;
  /** Times the waits before a stream that ended is opened again; the wall clock by default. */
  readonly clock?: Clock;
}

/** Binds each open session to its wire subscription and feeds the registry; see the header. */
export class SessionEventSubscriber {
  readonly #registry: SessionStoreRegistry;
  readonly #bridge: PlatformBridge;
  readonly #clock: Clock;
  readonly #bindingBySessionId = new Map<string, StreamBinding>();
  /** Where each open session's stream left off, where it delivered a change. */
  readonly #deliveredPositionBySessionId = new Map<string, DeliveredPosition>();
  /** Open sessions whose stream was bound once, so a later open is a resume. */
  readonly #resumingSessionIds = new Set<string>();
  readonly #appliedEventCountBySessionId = new Map<string, number>();
  /** Each open session's place in the re-open waits, from its stream's first end. */
  readonly #backoffBySessionId = new Map<string, ReopenBackoff>();
  /** Which failed opens are remembered, and what one returning edge is worth. */
  readonly #retry: FailedSubscriptionRetry;
  readonly #diagnostics: SessionDiagnostics;
  #unsubscribeFromRegistry: Unsubscribe | undefined;
  #unsubscribeFromTransportReconnect: Unsubscribe | undefined;
  #unreadableDeliveryCount = 0;
  #droppedAfterCloseCount = 0;
  #attached = false;
  #disposed = false;

  public constructor(options: SessionEventSubscriberOptions) {
    this.#registry = options.registry;
    this.#bridge = options.bridge;
    this.#clock = options.clock ?? new RealClock();
    // Answered from here so the retry reaches a retained id and nothing else.
    this.#retry = new FailedSubscriptionRetry({
      isRetired: () => this.#disposed,
      isStillOpen: (sessionId) => this.#registry.has(sessionId),
      rebind: (sessionId) => {
        this.#bindSession(sessionId);
      },
    });
    this.#diagnostics = this.#buildDiagnostics();
  }

  /**
   * Starts binding: subscribes to the registry, then binds what is already open. That order
   * cannot drop a session, whereas sweeping first would leave a window in which an open goes
   * unobserved; the worst case is binding twice, and `#bindSession` is idempotent by session id.
   *
   * It also takes one subscription for the subscriber's whole life to the transport's returning
   * edge, which re-attempts sessions whose open threw. The signal emits only on `unreachable →
   * reachable`, so a window whose wire never went away pays nothing. Idempotent, and a no-op once
   * disposed.
   */
  public attach(): void {
    if (this.#disposed || this.#attached) {
      return;
    }
    this.#attached = true;
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

  /** What the endurance tier reads about this subscriber, frozen and read-only. */
  public get diagnostics(): SessionDiagnostics {
    return this.#diagnostics;
  }

  /** Sessions this subscriber holds a wire subscription for, in bind order. */
  public get boundSessionIds(): readonly string[] {
    return [...this.#bindingBySessionId.keys()];
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
   * Deliveries the wire made for a session that was no longer open. Counted rather than merely
   * dropped, because a stream still delivering into a closed session is an upstream leak. Mirrors
   * `ApplyQueue.droppedAfterDisposeCount`.
   */
  public get droppedAfterCloseCount(): number {
    return this.#droppedAfterCloseCount;
  }

  /**
   * What of the stream this console could not read: one per delivered frame refused whole, and
   * one per event in a readable frame whose type the census pairs with another category. It is
   * counted, not reported on the tripwire, which detects console invariants; a payload shape is a
   * wire fact, and a tripwire would report every event type the console has not learned yet as a
   * console defect.
   */
  public get unreadableDeliveryCount(): number {
    return this.#unreadableDeliveryCount;
  }

  /**
   * Releases every subscription this subscriber holds. Final and idempotent. Applied-event counts
   * survive so `diagnostics` stays readable.
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
    for (const binding of this.#bindingBySessionId.values()) {
      binding.release();
    }
    this.#bindingBySessionId.clear();
    for (const backoff of this.#backoffBySessionId.values()) {
      backoff.cancel();
    }
    this.#backoffBySessionId.clear();
    // A retained id is a promise to re-attempt, and a disposed subscriber makes none.
    this.#retry.clear();
  }

  /**
   * Opens one session's stream through `openObservedSubscription`, which owns what an open proves
   * for the transport signal, so this class reports nothing itself. A session whose stream was
   * bound before resumes after the cursor of the last change it delivered.
   *
   * A throw is not re-raised: out of the registry callback it would reach a mount effect and take
   * the window down for a transport that was merely away. Instead the signal is told the wire is
   * unreachable (by `openObservedSubscription`) and the id is retained for the returning edge. A
   * first open also marks the store `subscription-closed`, so the session shows a named
   * degradation rather than a quiet empty projection; a resume does not, since the store still
   * holds everything delivered so far. The failure goes to the window's diagnostic capture: it is
   * a wire fact, not a broken invariant of this window. The store's cause is sticky until a
   * completed re-pull clears it, and the retry asks for that re-pull. A session id the daemon does
   * not admit, such as a hand-typed route address, has no stream to open, so it is marked closed
   * and not retained.
   */
  #bindSession(sessionId: string): void {
    if (this.#disposed || this.#bindingBySessionId.has(sessionId)) {
      return;
    }
    const wireSessionId = readSessionId(sessionId);
    if (wireSessionId === undefined) {
      this.#registry.markDegraded(sessionId, "subscription-closed");
      return;
    }
    const isResume = this.#resumingSessionIds.has(sessionId);
    const afterCursor = this.#deliveredPositionBySessionId.get(sessionId)?.cursor;
    const binding: StreamBinding = {
      release: () => undefined,
      hasDelivered: false,
      isReleased: false,
      openedAt: this.#clock.now(),
    };
    // Held before the open, because a catch-up may deliver, and set the frame aside, before the
    // open returns.
    this.#bindingBySessionId.set(sessionId, binding);
    let release: Unsubscribe;
    try {
      release = openObservedSubscription(this.#bridge.transportReconnect, () =>
        // The bridge's type is a claim about another process; `readSessionStreamFrame` checks it.
        this.#bridge.daemon.subscribe(
          SESSION_EVENT_STREAM,
          afterCursor === undefined
            ? { sessionId: wireSessionId }
            : { sessionId: wireSessionId, afterCursor },
          (frame: unknown) => {
            // A stream this class closed may still be mid-batch; its frames come again on the
            // stream that replaced it.
            if (binding.isReleased) {
              return;
            }
            binding.hasDelivered = true;
            this.#deliver(sessionId, binding, frame);
          },
          (end) => {
            this.#resumeEndedStream(sessionId, binding, end);
          },
        ),
      );
    } catch (subscriptionFailure: unknown) {
      this.#bindingBySessionId.delete(sessionId);
      this.#retry.retain(sessionId);
      if (!isResume) {
        this.#registry.markDegraded(sessionId, "subscription-closed");
      }
      recordWireFact(
        "subscription-open-failed",
        `session ${sessionId}: ${lossyStringify(subscriptionFailure)}`,
      );
      return;
    }
    binding.release = release;
    this.#retry.forget(sessionId);
    this.#resumingSessionIds.add(sessionId);
    // The base-state read, asked for at the moment a stream starts; without it a bound store
    // buffers forever. A stream resumed after a cursor needs none: the daemon catches it up from
    // there. The refusal arm is unreachable because this runs only for a session the registry
    // holds open, so it is dropped rather than re-checked.
    if (afterCursor === undefined) {
      this.#registry.requestRefresh(sessionId, "subscribe");
    }
    if (binding.isReleased) {
      // Its own catch-up set a frame aside and opened the stream again; this one is spent.
      release();
    }
  }

  /**
   * A stream that ended while the session was open: opened again after its last cursor, through
   * the re-open waits when it delivered since it opened and on the returning edge when it did
   * not. A refusal or a completion that came with no delivery is the daemon ending the stream with
   * the wire still there, so no returning edge may come: it is also tried again after a wait,
   * never at once. None of it is drawn.
   */
  #resumeEndedStream(sessionId: string, binding: StreamBinding, end: DaemonSubscriptionEnd): void {
    if (this.#disposed || this.#bindingBySessionId.get(sessionId) !== binding) {
      return;
    }
    this.#bindingBySessionId.delete(sessionId);
    recordWireFact("subscription-ended", `session ${sessionId}: ${describeSubscriptionEnd(end)}`);
    if (end.reason === "refused" && end.refusal.data?.type === EVENT_CURSOR_UNRESOLVABLE_CODE) {
      this.#deliveredPositionBySessionId.delete(sessionId);
      this.#bindSession(sessionId);
      return;
    }
    if (binding.hasDelivered) {
      const backoff = this.#backoffFor(sessionId);
      backoff.noteEnded(binding.openedAt);
      backoff.schedule(() => {
        this.#bindSession(sessionId);
      });
      return;
    }
    this.#retry.retain(sessionId);
    if (end.reason !== "failed") {
      const backoff = this.#backoffFor(sessionId);
      backoff.skipImmediateReopen();
      backoff.schedule(() => {
        this.#bindSession(sessionId);
      });
    }
  }

  #unbindSession(sessionId: string): void {
    // Dropped whether or not a subscription was taken; this bounds the retained set by the open
    // set.
    this.#retry.forget(sessionId);
    this.#deliveredPositionBySessionId.delete(sessionId);
    this.#resumingSessionIds.delete(sessionId);
    this.#backoffBySessionId.get(sessionId)?.cancel();
    this.#backoffBySessionId.delete(sessionId);
    const binding = this.#bindingBySessionId.get(sessionId);
    if (binding !== undefined) {
      this.#releaseBinding(sessionId, binding);
    }
  }

  /** Closes one stream this class holds, so frames still in its batch are not handled. */
  #releaseBinding(sessionId: string, binding: StreamBinding): void {
    binding.isReleased = true;
    this.#bindingBySessionId.delete(sessionId);
    binding.release();
  }

  /**
   * Fills a hole the daemon dropped: the stream is closed and opened again after the last change
   * it delivered, so the daemon sends the hole and what followed it in order. Through the re-open
   * waits, so a wire that stays full is not re-opened in a loop.
   */
  #fillDroppedChanges(sessionId: string, binding: StreamBinding): void {
    this.#releaseBinding(sessionId, binding);
    recordWireFact("dropped-changes-filled", `session ${sessionId}`);
    const backoff = this.#backoffFor(sessionId);
    backoff.noteEnded(binding.openedAt);
    backoff.schedule(() => {
      this.#bindSession(sessionId);
    });
  }

  /**
   * Handles one delivered frame. The drop mark is acted on before the events are queued. Within
   * the bound the frame is set aside and the hole filled from the last change delivered, which is
   * why the position is read before this frame moves it. Past it the store is marked short of rows
   * (which the catching-up line reads) and the session's re-read is asked for, so a session that
   * went quiet right after a drop does not stay short silently.
   *
   * The refusal arm of `enqueue` covers a close race: emission iterates a snapshot of subscribers,
   * so a session closed mid-delivery still reaches this handler, and a throw here would break the
   * wire's subscription for every other session on it.
   */
  #deliver(sessionId: string, binding: StreamBinding, delivered: unknown): void {
    const frame = readSessionStreamFrame(delivered);
    if (frame === undefined) {
      this.#unreadableDeliveryCount += 1;
      return;
    }
    // Only this session's events reach its store; another session's event has no store here and is
    // dropped without being counted as unreadable.
    const events = frame.events.filter((event) => event.sessionId === sessionId);
    const previous = this.#deliveredPositionBySessionId.get(sessionId);
    if (frame.dropped && this.#registry.has(sessionId) && isFillableDrop(previous, events)) {
      this.#fillDroppedChanges(sessionId, binding);
      return;
    }
    this.#unreadableDeliveryCount += frame.unreadableEventCount;
    if (this.#registry.has(sessionId)) {
      this.#deliveredPositionBySessionId.set(sessionId, {
        cursor: frame.resumeCursor,
        sequence: events.at(-1)?.sequence ?? previous?.sequence,
      });
    }
    if (frame.dropped) {
      // A refusal means the session closed during this delivery; the close-race arm below reports
      // a frame that still carried events.
      if (this.#registry.markDegraded(sessionId, "sequence-gap") === undefined) {
        this.#registry.requestRefresh(sessionId, "gap-repull");
      }
    }
    if (events.length === 0) {
      return;
    }
    const refusal = this.#registry.enqueue(sessionId, events);
    if (refusal !== undefined) {
      this.#droppedAfterCloseCount += 1;
      recordWireFact("delivery-after-close", `session ${sessionId}: ${refusal.code}`);
      return;
    }
    this.#appliedEventCountBySessionId.set(
      sessionId,
      this.appliedEventCountFor(sessionId) + events.length,
    );
  }

  #backoffFor(sessionId: string): ReopenBackoff {
    let backoff = this.#backoffBySessionId.get(sessionId);
    if (backoff === undefined) {
      backoff = new ReopenBackoff(this.#clock);
      this.#backoffBySessionId.set(sessionId, backoff);
    }
    return backoff;
  }

  #buildDiagnostics(): SessionDiagnostics {
    return Object.freeze({
      openSessionIds: (): readonly string[] => this.#registry.openSessionIds,
      appliedEventCountFor: (sessionId: string): number => this.appliedEventCountFor(sessionId),
      boundSessionIds: (): readonly string[] => this.boundSessionIds,
      transcriptWindowFor: (sessionId: string): TranscriptWindowReading | null =>
        transcriptWindowDiagnostics.readingFor(sessionId),
    });
  }
}

/**
 * One open stream: how to close it, whether it delivered since it opened, whether this class
 * closed it, and when it opened.
 */
interface StreamBinding {
  release: Unsubscribe;
  hasDelivered: boolean;
  isReleased: boolean;
  readonly openedAt: number;
}

/**
 * Where a stream left off: the cursor a re-open resumes after, and the sequence of the last event
 * of this session it delivered, which measures a hole the cursor cannot.
 */
interface DeliveredPosition {
  readonly cursor: EventCursor;
  readonly sequence: number | undefined;
}

/**
 * Whether a hole before this frame is filled from the daemon's record rather than repaired by a
 * read. The width is counted in sequences between the last event delivered and the frame's first;
 * where either is unknown (the caught-up frame, nothing delivered yet) it is filled, since the
 * daemon still holds every row.
 */
function isFillableDrop(
  previous: DeliveredPosition | undefined,
  events: readonly ProjectedSessionEvent[],
): boolean {
  const firstSequence = events[0]?.sequence;
  if (firstSequence === undefined || previous?.sequence === undefined) {
    return true;
  }
  return firstSequence - previous.sequence - 1 <= MAX_REPAIRABLE_SEQUENCE_GAP;
}

/** Capture a wire fact for diagnostics; it never reaches the screen or the tripwire. */
function recordWireFact(kind: string, detail: string): void {
  windowDiagnosticCapture.record({
    at: diagnosticStampAt(new RealClock()),
    severity: "warning",
    source: DIAGNOSTIC_SOURCE,
    kind,
    detail,
  });
}

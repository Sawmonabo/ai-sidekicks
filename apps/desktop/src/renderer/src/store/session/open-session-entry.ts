// One open session: the store, and the two schedulers bound to its life.
//
// Split out of `session-store-registry.ts` rather than living inside it, because
// the two answer different questions. This module answers "what is one open
// session made of, and how do its three parts stay consistent with each other";
// the registry answers "which sessions are open, and who is told when that set
// changes". Keeping them in one file put both jobs behind one name and pushed it
// past the length `apps/desktop/AGENTS.md` allows.
//
// An entry owns three things rather than one:
//
//   • the `SessionStore` itself;
//   • the `ApplyQueue` in front of its apply chokepoint, so a burst of wire events
//     is one transition and one render instead of N;
//   • the `RefreshScheduler` behind its re-pull, so every read is coalesced with an
//     absolute deadline and two reads never overlap.
//
// The three are created together and disposed together on purpose. A queue that
// outlived its store would drain into a dead object; a scheduler that outlived its
// store would arm a timer for a pane that is gone. Binding them to one entry makes
// both unrepresentable rather than merely discouraged.
//
// Binding them is also what closes the repair loop, and that is the reason the
// queue and the scheduler belong to ONE owner rather than to two. `applyBatch`
// answers with an `ApplyOutcome`, and a batch that opened a hole leaves the store
// degraded until a completed re-pull clears it. The drain below reads that outcome
// and asks this session's own scheduler for the re-pull, so a hole repairs itself
// instead of waiting for an unrelated refresh a quiet session never gets.
//
// THE RESUME RULE LANDS BESIDE THAT REPAIR, and for the same reason. Every read this
// entry performs answers with the log's own positions, and the resume rule is the
// CONSUMER's to obey: read up from where this user was last acknowledged rather
// than from the bottom of the window every time. `timeline-resume.ts` decides — and
// says there which arms are real and why there is no lost-event one — and this entry
// is what ACTS on the decision, by submitting the position on the next read.
//
// SO THE CURSOR RIDES THE READ, AND THE READ IS THE ONE THAT ALREADY HAPPENS. The
// resume position is the third argument of `SessionSnapshotReader`, supplied from the
// decision the previous read produced. There is no second read and no second path: a
// resume that opened its own read would be a second writer of the base state, racing
// the refresh scheduler that exists so two reads never overlap.
//
// AND THE REFUSED POSITION DEGRADES HONESTLY. A daemon that cannot resolve a submitted
// cursor answers `event.cursor_unresolvable`, and the entry does three things in one
// act rather than silently falling back: it forgets the position, it re-reads the
// window from its beginning through the same reader, and it RECORDS the refusal so the
// view says the remembered position could not be resumed. The refusal is not
// permanent — the next completed read settles whatever the daemon then acknowledges —
// and the cursor that was refused is remembered so the very next read does not submit
// it again, which would cost two reads per refresh for as long as it stayed refused.
//
// WHY THE DECISION CARRIES ITS OWN NOTIFICATION. The store's revision bump cannot carry
// it, even though a completed read writes the decision AND calls `initialize` in the
// same tick. That pairing is not sound and the refusal path is where it breaks:
// `initialize` consults `admitsSnapshotAt`, which REFUSES a snapshot behind the store's
// cursor — and the re-read after a refused position answers at the beginning of the
// window, which is exactly behind it. So the read completes, the decision settles, the
// revision does not move, and a reading subscribed to the revision alone never learns
// the refusal happened. The entry therefore reports its own settlement, through a
// callback the registry supplies, and the reading subscribes to that.
//
// It reads no wire itself. The `read` performer is supplied by the composition
// root, which is what keeps `store/` below `services/` in the import direction.

import { RealClock, type Clock } from "@renderer/lib/clock.js";
import {
  diagnosticStampAt,
  windowDiagnosticCapture,
} from "@renderer/lib/diagnostic-capture/diagnostic-capture.js";
import type { SessionDegradedCause } from "../session-degradation.js";
import type { EntityProjectorTable } from "./entities/entities.js";
import { ApplyQueue } from "./apply-queue.js";
import { RefreshScheduler, type RefreshReason } from "@renderer/lib/reads/refresh-scheduler.js";
import { type ApplyOutcome } from "./apply-outcome.js";
import { SessionStore, type SessionSnapshot } from "./session-store.js";
import {
  isUnresolvableCursorRejection,
  refuseUnresolvableResume,
  resolveTimelineResume,
  type TimelineResumeDecision,
} from "./timeline-resume.js";

/**
 * The read a refresh performs.
 *
 * Returns the snapshot to establish, or `undefined` for "nothing was read" —
 * deliberately not an empty snapshot, which would tell the store the session is
 * genuinely empty and clear its degraded flag on a read that never happened.
 *
 * `resumeFromCursor` is where the reader is asked to start: the position the previous
 * read acknowledged, or `undefined` for the beginning of the window.
 *
 * DECLARED REQUIRED, AND THAT DECLARATION GATES NOTHING BY ITSELF. A function of fewer
 * parameters is assignable to a function type with more, so an adapter written as
 * `async (sessionId) => …` satisfies this type exactly and drops the position in
 * silence — which is what shipped, and what `tsc` had no opinion about. The parameter
 * is required because it is not optional information: every caller of this type has a
 * position or has decided it has none. What HOLDS the forwarding is the behavioral
 * gate in `frame/session/session-lifecycle.bridge-swap.test.tsx`, which composes the real
 * adapter over a recording bridge and asserts the cursor reaches the request — a test
 * of the seam rather than of its signature, because the signature cannot fail.
 */
export type SessionSnapshotReader = (
  sessionId: string,
  reasons: readonly RefreshReason[],
  resumeFromCursor: string | undefined,
) => Promise<SessionSnapshot | undefined>;

/**
 * Everything one open session needs.
 *
 * Declared HERE, in the lower of the two modules, rather than in the registry that
 * is named after it: the registry hands its own options straight through to every
 * entry it makes, so the two shapes are one shape, and a copy in the upper module
 * would make `open-session-entry.ts` import back from `session-store-registry.ts`
 * for the type — the import cycle `.dependency-cruiser.mjs` forbids and whose own
 * remedy is to hoist the shared symbol down.
 */
export interface OpenSessionEntryOptions {
  /**
   * The read every session's refresh scheduler performs. REQUIRED, and required
   * on purpose: a refresh path with no read is a timer that fires into nothing.
   */
  readonly read: SessionSnapshotReader;
  /**
   * Called after every read that settles a resume decision, so a reading can
   * subscribe to the decision rather than to a store transition that may not happen.
   *
   * A callback the registry supplies rather than an emitter of this entry's own: the
   * fan-out belongs to the object views already hold, and an emitter per open
   * session would be one subscription per session per reading for a fact every
   * reading answers by asking the registry anyway.
   */
  readonly onTimelineResumeSettled?: () => void;
  /** Defaults to `RealClock`. Every queue and scheduler made from this shares it. */
  readonly clock?: Clock;
  /** Event-kind projectors handed to each store opened. */
  readonly projectors?: EntityProjectorTable;
  /** Timeline rows each store retains. */
  readonly timelineCap?: number;
  /** Apply-queue coalescing window. `0` means one drain per paint. */
  readonly applyCoalesceMs?: number;
  readonly refreshDebounceMs?: number;
  readonly refreshMaxWaitMs?: number;
}

/** One open session: its store and the two schedulers bound to it. */
export class OpenSessionEntry {
  public readonly store: SessionStore;
  public readonly applyQueue: ApplyQueue;
  public readonly refreshScheduler: RefreshScheduler;
  /**
   * What the newest completed read's cursor block said to do, or `undefined` before
   * one has landed.
   *
   * Kept as the LATEST decision rather than accumulated: each read carries the whole
   * cursor block, so the newest one supersedes its predecessor completely and a
   * history of them would be a record of positions the log has already moved past.
   */
  #timelineResume: TimelineResumeDecision | undefined = undefined;
  /**
   * The position the NEXT read submits, or `undefined` for the window's beginning.
   *
   * Held apart from the decision above because the two answer different questions and
   * diverge on exactly one path: after a refused position the decision is the refusal
   * a view renders, while what the next read submits is whatever the recovering
   * re-read then acknowledged. Folding them would make the notice clear itself.
   */
  #resumeFromCursor: string | undefined = undefined;
  /**
   * The one position the daemon refused, remembered so it is never submitted twice.
   *
   * ONE value rather than a set. A set of refused cursors is unbounded in a long
   * session and buys nothing: the daemon issues one acknowledged position per read, so
   * the only cursor a next read could re-submit is the one the last read named. What
   * this closes is the loop — refuse, re-read, be acknowledged at the same unresolvable
   * position, submit it again — which would cost two reads on every refresh for as long
   * as it stood.
   */
  #unresolvableCursor: string | undefined = undefined;
  readonly #onTimelineResumeSettled: (() => void) | undefined;
  readonly #releaseCauseCapture: () => void;

  public constructor(sessionId: string, options: OpenSessionEntryOptions) {
    this.#onTimelineResumeSettled = options.onTimelineResumeSettled;
    const clock = options.clock ?? new RealClock();
    this.store = new SessionStore({
      sessionId,
      ...(options.projectors === undefined ? {} : { projectors: options.projectors }),
      ...(options.timelineCap === undefined ? {} : { timelineCap: options.timelineCap }),
    });
    this.applyQueue = new ApplyQueue({
      clock,
      // The one place a batch of wire events reaches the store. Nothing else in
      // the console calls `applyBatch`, which is what makes the chokepoint a
      // structural property rather than a convention.
      drain: (events) => {
        const outcome = this.store.applyBatch(events);
        if (needsAuthoritativeRepull(outcome)) {
          // The outcome is the only notice a hole was opened, and only a completed
          // re-pull closes it. Through the scheduler rather than a direct read, so
          // a lossy burst costs one repair and never overlaps a read in flight.
          this.refreshScheduler.request("gap-repull");
        }
      },
      ...(options.applyCoalesceMs === undefined ? {} : { coalesceMs: options.applyCoalesceMs }),
    });
    this.refreshScheduler = new RefreshScheduler({
      clock,
      perform: async (reasons) => {
        await this.#performRead(options.read, sessionId, reasons);
      },
      // A failed read is a real degradation with a named cause, not an unhandled
      // rejection: the view renders "could not re-read" instead of stale rows
      // that look current.
      onError: () => {
        this.store.markDegraded("read-failed");
      },
      ...(options.refreshDebounceMs === undefined ? {} : { debounceMs: options.refreshDebounceMs }),
      ...(options.refreshMaxWaitMs === undefined ? {} : { maxWaitMs: options.refreshMaxWaitMs }),
    });
    // THE CAUSE GOES TO THE WINDOW'S DIAGNOSTIC CAPTURE AND NEVER TO THE SCREEN, where
    // one line under the session header says only that the window is catching up. One
    // warning each time the cause changes, recorded here because every writer of the
    // cause lands on this store and this entry holds the clock and the session.
    let recordedCause: SessionDegradedCause | undefined;
    this.#releaseCauseCapture = this.store.readable.subscribe((state) => {
      const cause = state.degradedCause;
      if (cause === recordedCause) {
        return;
      }
      recordedCause = cause;
      if (cause === undefined) {
        return;
      }
      windowDiagnosticCapture.record({
        at: diagnosticStampAt(clock),
        severity: "warning",
        source: "store/session",
        kind: "session-degraded",
        detail: `session ${sessionId}: ${cause}`,
      });
    });
  }

  /**
   * The resume decision the newest completed read settled, or `undefined` before one
   * has landed.
   *
   * Read by whatever renders the refused arm. `undefined` is deliberately not folded
   * into any of the settled arms: "no read has completed" is a different fact from
   * every one of them, and a view that showed the refusal for it would report a
   * failed resume every time a session opened.
   */
  public get timelineResume(): TimelineResumeDecision | undefined {
    return this.#timelineResume;
  }

  public dispose(): void {
    this.#releaseCauseCapture();
    this.applyQueue.dispose();
    this.refreshScheduler.dispose();
  }

  /**
   * One refresh: submit the remembered position, and recover from a refused one.
   *
   * The recovery is a SECOND CALL TO THE SAME READER rather than a second read path,
   * which is what keeps "two reads never overlap" true: both calls are inside the one
   * `perform` the scheduler is awaiting, so no other refresh can begin between them.
   *
   * A rejection that is anything else is re-raised untouched — the scheduler's own
   * `onError` arm marks the store degraded, which is the right report for a read that
   * failed and the wrong one for a position that was refused.
   */
  async #performRead(
    read: SessionSnapshotReader,
    sessionId: string,
    reasons: readonly RefreshReason[],
  ): Promise<void> {
    const submitted = this.#resumeFromCursor;
    let snapshot: SessionSnapshot | undefined;
    try {
      snapshot = await read(sessionId, reasons, submitted);
    } catch (rejection: unknown) {
      if (submitted === undefined || !isUnresolvableCursorRejection(rejection)) {
        throw rejection;
      }
      // The cursor is tested BEFORE the code is believed. `event.cursor_unresolvable`
      // refuses a request that carried a cursor, so a read this console submitted none
      // on cannot have raised it about a position of ours — and taking it as ours
      // would report a lost position on a read that never had one.
      this.#unresolvableCursor = submitted;
      this.#resumeFromCursor = undefined;
      this.#settleTimelineResume(refuseUnresolvableResume());
      snapshot = await read(sessionId, reasons, undefined);
      if (snapshot === undefined) {
        return;
      }
      // The refusal STANDS as the decision: it is what happened to this session's
      // resume cycle and it is what a view has to say. What the recovering read
      // acknowledged is carried forward as the next position, and nothing else.
      this.#rememberNextResumePosition(resolveTimelineResume(snapshot.timelineCursors));
      // The recovering read submitted nothing, so the window it established opens at
      // the beginning of the log and there is no position before it to name.
      this.store.initialize(snapshot);
      return;
    }
    if (snapshot === undefined) {
      return;
    }
    const decision = resolveTimelineResume(snapshot.timelineCursors);
    this.#rememberNextResumePosition(decision);
    // Settled BEFORE the base state is established, so the decision a reader sees
    // beside an initialized store is the one that read produced rather than its
    // predecessor's — and settled unconditionally, so a completed read always says
    // where the next one starts and not only when it went wrong.
    this.#settleTimelineResume(decision);
    // A completed re-pull is the ONE thing that clears the sticky degraded
    // flag — `initialize` does that — which is why the read lands here and
    // not on a caller that might forget.
    //
    // AND THE POSITION THIS READ WAS PERFORMED FROM TRAVELS WITH IT, because this
    // object is the only one that knows it: a session's stream replays from the
    // submitted cursor, so that cursor is where the window this read establishes
    // BEGINS, and the reply carries no member naming its oldest row. Without it the
    // transcript has no position to ask the log's earlier rows for and would have to
    // invent one out of an opaque cursor's bytes, which `timeline-resume.ts` refuses
    // for the whole console. Omitted rather than passed as `undefined` where none was
    // submitted: the member is optional and this package forbids the explicit-
    // undefined form.
    this.store.initialize(
      submitted === undefined ? snapshot : { ...snapshot, readFromCursor: submitted },
    );
  }

  /** Hold the newest decision and tell the registry it moved. */
  #settleTimelineResume(decision: TimelineResumeDecision): void {
    this.#timelineResume = decision;
    this.#onTimelineResumeSettled?.();
  }

  /**
   * Carry a completed read's acknowledged position forward to the next read.
   *
   * The one position never carried forward is the one the daemon just refused: it
   * would be submitted again on the next refresh, refused again, and recovered from
   * again — two reads per refresh for as long as the daemon kept acknowledging it.
   */
  #rememberNextResumePosition(decision: TimelineResumeDecision): void {
    if (decision.outcome !== "resume") {
      this.#resumeFromCursor = undefined;
      return;
    }
    this.#resumeFromCursor =
      decision.fromCursor === this.#unresolvableCursor ? undefined : decision.fromCursor;
  }
}

/**
 * Whether one `applyBatch` left the projection known-incomplete, so an
 * authoritative re-read is owed.
 *
 * Read off the outcome's OWN discriminants, never off the store's degraded cause —
 * that flag is sticky until a re-pull clears it, so it would make every batch after
 * the first look repair-worthy. These four are exactly the counts `applyBatch`
 * raises one for. `duplicates` and `refusedForeignSession` are absent on purpose: a
 * re-delivery costs nothing, a foreign-session event is a routing defect one layer
 * up, and neither leaves a hole in THIS store that a read could fill.
 */
function needsAuthoritativeRepull(outcome: ApplyOutcome): boolean {
  return (
    outcome.gapDetected ||
    outcome.droppedBeforeInitialization > 0 ||
    outcome.refusedDivergedSequence > 0 ||
    outcome.projectionFailures > 0
  );
}

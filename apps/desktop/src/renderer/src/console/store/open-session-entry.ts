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
// entry performs answers with the log's own three positions, and
// `api-payload-contracts.md` puts a rule on them the CONSUMER owns: resume from
// `acknowledged ?? earliest`, reset the projection when the acknowledged position has
// fallen below the floor, and refuse the whole cycle SDK-locally when the responder
// carries no floor at all. `timeline-resume.ts` decides; this entry is what acts,
// because the reset is a write to the store and the store has exactly one owner. The
// decision is kept rather than discarded so a surface can render the refused arm —
// which for an older daemon is a standing state and not an incident.
//
// It reads no wire itself. The `read` performer is supplied by the composition
// root, which is what keeps this family below `bridge/` in the console's DAG.

import { RealClock, type ConsoleClock, type ConsoleRefusal } from "../core/index.js";
import type { EntityProjectorRegistry } from "./entities.js";
import { ApplyQueue, RefreshScheduler, type RefreshReason } from "./scheduling.js";
import { type ApplyOutcome } from "./apply-outcome.js";
import { SessionStore, type SessionSnapshot } from "./session-store.js";
import { resolveTimelineResume, type TimelineResumeDecision } from "./timeline-resume.js";

/**
 * The read a refresh performs.
 *
 * Returns the snapshot to establish, or `undefined` for "nothing was read" — the
 * honest answer while a session's wire is unregistered, and deliberately not an
 * empty snapshot, which would tell the store the session is genuinely empty and
 * clear its degraded flag on a read that never happened.
 */
export type SessionSnapshotReader = (
  sessionId: string,
  reasons: readonly RefreshReason[],
) => Promise<SessionSnapshot | undefined>;

/**
 * What a caller does about reads: perform one, or carry the refusal that says why
 * it cannot.
 *
 * A refusal rather than a reason-less sentinel, and the two are not the same
 * mechanism wearing different names. Both answer the question a function-shaped
 * placeholder cannot be asked — can a store opened here ever be initialised? — and
 * a stream bound to one that cannot is a stream buffered forever and projected
 * never. The refusal answers it and also names the operation that would have served
 * the read and the document that owes the wire, which is what a surface renders as
 * the `not-checked` kind of nothing. One mechanism, and the strictly more
 * informative one.
 *
 * Still deliberately distinct from a reader that resolves `undefined`: that is a
 * read that HAPPENED and found nothing — transient, and the next refresh may well
 * succeed.
 */
export type SessionSnapshotRead = SessionSnapshotReader | ConsoleRefusal;

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
   * on purpose: a refresh path with no read is a timer that fires into nothing,
   * so a caller with no wire yet passes the refusal it would have rendered and
   * says so at the call site rather than getting that behaviour by default.
   */
  readonly read: SessionSnapshotRead;
  /** Defaults to `RealClock`. Every queue and scheduler made from this shares it. */
  readonly clock?: ConsoleClock;
  /** Event-kind projectors handed to each store opened. */
  readonly projectors?: EntityProjectorRegistry;
  /** Timeline rows each store retains. */
  readonly timelineCap?: number;
  /** Apply-queue coalescing window. `0` means one drain per paint. */
  readonly applyCoalesceMs?: number;
  readonly refreshDebounceMs?: number;
  readonly refreshMaxWaitMs?: number;
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
    outcome.droppedBeforeInitialisation > 0 ||
    outcome.refusedDivergedSequence > 0 ||
    outcome.projectionFailures > 0
  );
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

  public constructor(sessionId: string, options: OpenSessionEntryOptions) {
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
        if (typeof options.read !== "function") {
          // A refusal, not a reader. Nothing to perform, and nothing to report
          // either: the refusal is a STANDING fact the caller already renders,
          // not an error this read discovered, so `onError` stays for reads that
          // were attempted and failed.
          return;
        }
        const snapshot = await options.read(sessionId, reasons);
        if (snapshot === undefined) {
          return;
        }
        // The resume decision is taken BEFORE the base state is established, which is
        // the order the rule itself names: the reset has to happen ahead of the read
        // that lands on it, or `admitsSnapshotAt` refuses a floor-positioned snapshot
        // for arriving behind a cursor built on rows the daemon no longer holds.
        const decision = resolveTimelineResume(snapshot.timelineCursors);
        this.#timelineResume = decision;
        if (decision.outcome === "reset") {
          this.store.resetProjection("stream-diverged");
        }
        // A completed re-pull is the ONE thing that clears the sticky degraded
        // flag — `initialise` does that — which is why the read lands here and
        // not on a caller that might forget.
        this.store.initialise(snapshot);
      },
      // A failed read is a real degradation with a named cause, not an unhandled
      // rejection: the surface renders "could not re-read" instead of stale rows
      // that look current.
      onError: () => {
        this.store.markDegraded("read-failed");
      },
      ...(options.refreshDebounceMs === undefined ? {} : { debounceMs: options.refreshDebounceMs }),
      ...(options.refreshMaxWaitMs === undefined ? {} : { maxWaitMs: options.refreshMaxWaitMs }),
    });
  }

  /**
   * The resume decision the newest completed read produced, or `undefined` before
   * one has.
   *
   * Read by whatever renders the refused arm. `undefined` is deliberately not folded
   * into the refusal: "no read has completed" and "the responder carries no floor"
   * are different facts, and a surface that showed the second for the first would
   * report a version skew every time a session opened.
   */
  public get timelineResume(): TimelineResumeDecision | undefined {
    return this.#timelineResume;
  }

  public dispose(): void {
    this.applyQueue.dispose();
    this.refreshScheduler.dispose();
  }
}

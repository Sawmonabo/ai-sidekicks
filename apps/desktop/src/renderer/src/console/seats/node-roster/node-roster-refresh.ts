// When the absorbed roster re-reads, and what a burst of reasons costs.
//
// SPLIT OUT OF `node-roster-seam.ts`, WHICH OWNS WHAT THE READ ANSWERED. That module
// owns the seam's identity, its lifetime, and the observation it records; this one
// owns the other half of the same seam — the moment a re-read is asked for. Two
// subjects, and the file was already carrying both.
//
// THE ROSTER'S REFRESH WAS THE ONE THAT DID NOT GO THROUGH THE CHOKEPOINT.
// `apps/desktop/AGENTS.md` §Chokepoints: "every refresh goes through
// `console/store/read/refresh-scheduler.ts`". The absorbed roster re-read straight off the push —
// one `runtimenode.roster` per delivered `runtime_node.*` frame, and a node
// registering, declaring a capability and coming online inside one advance cost three
// reads of an answer that only the last of them was going to render. So the pushes,
// the window triggers, and the session's own lease frames all land here instead, and
// `RefreshScheduler` decides what the burst costs: a trailing debounce with an
// absolute deadline, so a continuous stream still gets a read.
//
// IT RAISES THE VIEW'S OWN HANDLER AND READS NOTHING ITSELF. `runtime-node-attach/` is
// Plan-003's and this console never edits it, so the refresh runs through the seam
// that view's own contract already gives: a presence push says WHEN to re-read, the
// view re-reads through its own path, and its refresh deliberately never re-enters
// `loading`. Handing it a fresh seam to force a read would return a live roster to its
// loading shape, which is the flash that view's own tripwire forbids.
//
// ONE PER `(seam, session)`, AND ITS LIFETIME IS THE SUBSCRIPTION'S. A coordinator is
// minted when a roster subscribes for a session and disposed when the last one
// releases, so a scheduler can never stay armed behind a surface nobody is rendering —
// the terminal-`dispose()` discipline `store/read/refresh-scheduler.ts` states, applied at the
// only boundary this seam has.

import type { ConsoleClock } from "../../core/index.js";
import { RefreshScheduler, type RefreshReason } from "../../store/index.js";

/**
 * The re-read coordinator for one session's absorbed roster.
 *
 * A class with private fields rather than a closure over a scheduler, on the family's
 * standing rule — and because the readers and the scheduler are one lifetime: the
 * last reader leaving is what makes the scheduler disposable, and a shape that held
 * them apart would need a second rule saying so.
 */
export class NodeRosterRefresh {
  readonly #scheduler: RefreshScheduler;
  // The change handlers the absorbed rosters registered for this session. A set,
  // because the same seam and session can be mounted twice — the agent console and
  // the settings page — and one scheduled refresh then raises both rather than each
  // mount reading on its own schedule.
  readonly #readers = new Set<() => void>();

  public constructor(clock: ConsoleClock) {
    this.#scheduler = new RefreshScheduler({
      clock,
      perform: async () => {
        this.#raiseEveryReader();
      },
      // NO `onError`, DELIBERATELY. This coordinator holds no state a failure could be
      // rendered into — the roster's own arms are the absorbed view's, and the refusal
      // a read answered is the seam's — so a handler here could only swallow. The
      // scheduler's absent arm re-throws out of an `async` body the clock discards
      // with `void`, which surfaces as an unhandled rejection and takes no other
      // session's pending work with it. A reader that cannot be raised is a defect in
      // the mount, and it stays visible.
    });
  }

  /** Reads actually raised. The coalescing assertion, counted rather than inferred. */
  public get raisedRefreshCount(): number {
    return this.#scheduler.performCount;
  }

  /** How many mounted rosters this coordinator raises. Zero means it may be dropped. */
  public get readerCount(): number {
    return this.#readers.size;
  }

  /**
   * Register one mounted roster's change handler, and hand back its release.
   *
   * Released with the subscription that registered it — a handler outliving the mount
   * would re-read through a seam nobody is rendering.
   */
  public addReader(onRefreshDue: () => void): () => void {
    this.#readers.add(onRefreshDue);
    return () => {
      this.#readers.delete(onRefreshDue);
    };
  }

  /**
   * Ask for a re-read. Repeated calls inside the coalescing window cost one.
   *
   * Deliberately NOT gated on there being a reader yet. A seam that signals
   * synchronously from inside its own `subscribe` reaches here before the mount that
   * subscribed has registered anything, and a gate would drop exactly that signal;
   * the scheduler holds the request instead and raises whoever is registered when it
   * fires.
   */
  public request(reason: RefreshReason): void {
    this.#scheduler.request(reason);
  }

  /** Drop the schedule and every reader. Terminal, on the scheduler's own contract. */
  public dispose(): void {
    this.#scheduler.dispose();
    this.#readers.clear();
  }

  /**
   * Raise every registered reader, then surface the first failure.
   *
   * EVERY READER IS RAISED even when one throws: two rosters are mounted on the same
   * `(seam, session)` in the settings page and the agent console, and letting the
   * first one's defect starve the second would leave a live surface silently stale —
   * the failure this whole seam exists to prevent. The failure is still raised rather
   * than swallowed, because a handler that cannot be raised is a defect in the mount
   * and not a state this seam may report as a completed refresh.
   */
  #raiseEveryReader(): void {
    let raiseFailure: unknown;
    let readerFailed = false;
    // A copy, so a reader that releases itself while being raised does not mutate the
    // set this loop is walking.
    for (const onRefreshDue of [...this.#readers]) {
      try {
        onRefreshDue();
      } catch (readerRejection: unknown) {
        if (!readerFailed) {
          readerFailed = true;
          raiseFailure = readerRejection;
        }
      }
    }
    if (readerFailed) {
      throw raiseFailure;
    }
  }
}

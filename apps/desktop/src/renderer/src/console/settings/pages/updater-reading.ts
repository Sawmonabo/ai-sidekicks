// What the updater said, and which of its two mouths said it.
//
// TWO SOURCES, AND THEY RACE
//
// The updates block opens a SUBSCRIPTION and asks for the current state once, in
// that order. Those two answers race. A transition the updater pushes after
// `getState()` was called but before it resolved is the NEWER fact, and an opening
// continuation that installed unconditionally would overwrite it with the state the
// updater held a moment earlier — hiding a `ready`, a `downloading`, or an error
// until the updater happens to push again, which from a terminal arm it never does.
//
// So the two sources are SEQUENCED rather than merged: the opening read installs
// only while nothing has been pushed, and the first push settles the question for
// the rest of that subscription's life. Both facts live in one holder carrying a
// `source` discriminator and a monotonic sequence, rather than in two `useState`
// setters — which side won is the property under test, and a pair of setters cannot
// be asked.
//
// THE OPENING IS RE-OPENABLE, SO `close()` IS NOT TERMINAL
//
// A React effect's cleanup runs between the two invocations StrictMode makes of one
// effect, and a bridge swap tears an opening down and builds another. A holder whose
// teardown were terminal would answer the second invocation with a dead object and
// the block would read nothing for the rest of the window's life. So an opening is a
// GENERATION: `close()` releases the subscription and invalidates every reply still
// in flight, and a later `open()` starts a fresh one.
//
// WHAT THIS HOLDS, AND WHAT IT DOES NOT
//
// The updater namespace rather than the whole bridge: this holder reads a state and
// a subscription and touches neither control, so taking the bridge would be taking
// a surface it has no business reaching — and would make its own test build a bridge
// to exercise a race that has nothing to do with one.

import type { SidekicksBridge, UpdateState } from "@ai-sidekicks/contracts";

import { wireRejectionToError } from "../../../../../shared/wire-errors.js";
import { Emitter, type Unsubscribe } from "../../core/index.js";
import { GenerationLatch, type GenerationClaim } from "../../store/index.js";

/**
 * What the block knows about the updater. Total; every arm renders something.
 *
 * `unreachable` is deliberately NOT one of `UpdateState`'s arms: it is the state of
 * the CONVERSATION rather than of the update, and folding it into `error` would
 * attribute a failure to an updater that was never asked.
 */
export type UpdateReading =
  | { readonly kind: "not-read" }
  | { readonly kind: "state"; readonly state: UpdateState }
  | { readonly kind: "unreachable"; readonly detail: string };

/**
 * Which side of the updater seam the held reading came from.
 *
 * Not rendered anywhere: it exists so the sequencing rule can be ASKED. A holder
 * that answered with the right state for the wrong reason — the opening read landing
 * last and happening to carry the same arm — is a holder that will lose the next
 * race, and only the source tells the two apart.
 */
type UpdateReadingSource = "none" | "opening" | "push";

/** The held reading, rebuilt on every accepted observation and held by identity. */
export interface UpdaterReadingSnapshot {
  readonly reading: UpdateReading;
  readonly source: UpdateReadingSource;
  /** Monotonic across accepted observations, so a re-render sees a new identity. */
  readonly sequence: number;
}

const NOTHING_READ: UpdaterReadingSnapshot = {
  reading: { kind: "not-read" },
  source: "none",
  sequence: 0,
};

/**
 * One window's reading of the updater, sequenced across its two sources.
 *
 * A class with private fields rather than a hook body, per `apps/desktop/AGENTS.md`:
 * it owns a subscription, an opening generation, and the rule that decides which
 * answer installs. The React binding lives in `UpdatesPage.tsx` and holds nothing.
 */
/**
 * The one key this holder claims, because it has exactly one act to be on a round of.
 *
 * Named rather than spelled at the two sites that use it: the latch is keyed by
 * string, and a key that disagreed between the take and the teardown would leave a
 * round nothing could supersede.
 */
const OPENING_KEY = "open";

export class UpdaterReadingHolder {
  readonly #updater: SidekicksBridge["update"];
  readonly #changes = new Emitter<void>("updater reading change");
  #snapshot: UpdaterReadingSnapshot = NOTHING_READ;
  #release: (() => void) | undefined = undefined;
  /** The openings this holder has made. One round per `open`, released by `close`. */
  readonly #openings = new GenerationLatch();
  /** Reset per opening, because each opening subscribes afresh. */
  #hasObservedPush = false;

  public constructor(updater: SidekicksBridge["update"]) {
    this.#updater = updater;
  }

  public snapshot(): UpdaterReadingSnapshot {
    return this.#snapshot;
  }

  public subscribe(sink: () => void): Unsubscribe {
    return this.#changes.subscribe(sink);
  }

  /**
   * Subscribe, then read once — in that order, and never the other way round.
   *
   * Subscribe-before-read for the reason every push-driven read in this console
   * gives: a transition landing after the read and before the handler attaches would
   * be lost, and the worst case the other way round is one redundant render. A
   * subscription that cannot be opened at all settles the whole reading as
   * unreachable and asks for no state, because there is nothing left to keep current.
   */
  public open(): void {
    this.close();
    const opening = this.#openings.supersedeAndClaim(this, OPENING_KEY);
    this.#hasObservedPush = false;
    try {
      this.#release = this.#updater.subscribe((state) => {
        this.#observePush(opening, state);
      });
      void this.#updater
        .getState()
        .then((state) => {
          this.#observeOpening(opening, { kind: "state", state });
        })
        .catch((readRejection: unknown) => {
          this.#observeOpening(opening, unreachableFrom(readRejection));
        });
    } catch (openingRejection: unknown) {
      this.#observeOpening(opening, unreachableFrom(openingRejection));
    }
  }

  /** Release the current opening. Not terminal: {@link open} starts another. */
  public close(): void {
    this.#openings.supersedeAll();
    const release = this.#release;
    this.#release = undefined;
    release?.();
  }

  /** A transition the updater pushed: always the newest fact this window has. */
  #observePush(opening: GenerationClaim, state: UpdateState): void {
    opening.settle(() => {
      this.#hasObservedPush = true;
      this.#install({ kind: "state", state }, "push");
    });
  }

  /**
   * The opening leg's own answer, installed only while nothing has been pushed.
   *
   * One entry point for both of its arms — the state it read and the failure that
   * stopped it — because they are the same fact about sequence: both describe the
   * moment the block opened, and a push is newer than either.
   */
  #observeOpening(opening: GenerationClaim, reading: UpdateReading): void {
    opening.settle(() => {
      if (this.#hasObservedPush) {
        return;
      }
      this.#install(reading, "opening");
    });
  }

  #install(reading: UpdateReading, source: UpdateReadingSource): void {
    this.#snapshot = { reading, source, sequence: this.#snapshot.sequence + 1 };
    this.#changes.emit();
  }
}

/**
 * The reading a rejection settles on, in the words the failure arrived in.
 *
 * Through the repository's one rejection normalizer rather than a local
 * `instanceof Error` ladder: it renders a wire envelope as its own `code: message`
 * instead of `[object Object]`, and its total arm cannot throw while composing the
 * sentence that says something failed.
 */
function unreachableFrom(rejection: unknown): UpdateReading {
  return {
    kind: "unreachable",
    detail: wireRejectionToError(rejection, { total: true }).message,
  };
}

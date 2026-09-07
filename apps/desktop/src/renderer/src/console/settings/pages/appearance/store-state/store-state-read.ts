// How this window's store-state reading is TAKEN, and why exactly one is in flight.
//
// THE RACE THIS CLOSES. The block wired two triggers — the mount and the window
// regaining focus — and each of them called `UiStateStore.health()` directly out of
// its own handler. `health()` measures the adapter's quota, which on the durable
// adapter is `navigator.storage.estimate()`, and that is a genuinely slow read: a
// window refocused while the first estimate was still outstanding had two of them
// running, and whichever ANSWERED last published. The older figure then replaced the
// newer one, and the block rendered a byte count and a pressure chip taken before the
// thing that changed. Nothing on screen said which reading it was showing.
//
// SO EVERY TRIGGER GOES THROUGH `store/scheduling.ts` AND NOTHING ELSE.
// `apps/desktop/AGENTS.md` §Chokepoints: "every refresh goes through
// `console/store/scheduling.ts`". That scheduler coalesces a burst of reasons into one
// read and SERIALIZES what it fires, so a reason raised while a read is outstanding
// becomes the NEXT read rather than a parallel one — which is what makes the overlap
// above unrepresentable rather than merely unlikely. No sequence number appears below,
// because the ordering is a consequence of routing through the chokepoint and a
// counter here would be a second answer to a question the substrate already answers.
//
// AND THE SETTLEMENT IS MEASURED AGAINST `store/generation-latch.ts`. Serialization
// bounds what this reading can race against ITSELF; it says nothing about a reading
// whose store was replaced or whose page unmounted while a call was outstanding.
// Nothing behind `health()` is cancellable — it takes no signal, and the adapter has
// no per-read cancel — so a superseded answer is IGNORED rather than stopped, which is
// exactly what the latch expresses.
//
// WHY IT IS A CLASS AND THE BLOCK IS NOT. `apps/desktop/AGENTS.md` §State and views:
// the schedule, the round, and the rule that decides which settlement installs are
// state, and a React body renders. {@link useStoreStateReading} is the binding and
// holds nothing of its own.

import { useSyncExternalStore } from "react";

import { useConsoleClock } from "../../../../bridge/index.js";
import {
  Emitter,
  NO_TRANSPORT_RECONNECT,
  type ConsoleClock,
  type Unsubscribe,
} from "../../../../core/index.js";
import { type UiStateStore } from "../../../../persistence/index.js";
import { consoleRefusalFrom } from "../../../../seats/index.js";
import {
  GenerationLatch,
  NO_TRIGGERING_EVENT_KINDS,
  RefreshScheduler,
  useSubjectScopedResource,
  useWindowReadTriggers,
  type ReadTriggerTarget,
  type RefreshReason,
  type SubjectScopedDisposal,
} from "../../../../store/index.js";
import type { StoreStateReading } from "./store-state-reading.js";

/** Names a read that produced no answer at all, where the thrown value named none. */
const STORE_STATE_ORIGIN = "ui-state-store";

/** The one key a store-health read is taken under. One question, so one key. */
const STORE_HEALTH_READ_KEY = "store-health-read";

/**
 * The pass before the first answer lands, held at module scope.
 *
 * One frozen value rather than a fresh literal per reading: `useSyncExternalStore`
 * compares identity, and a seed composed per call would re-render the block forever.
 */
const NOTHING_READ: StoreStateReading = Object.freeze({ kind: "unread" });

export interface StoreStateReadOptions {
  readonly uiStateStore: UiStateStore;
  /** The clock the scheduler arms on. The window's one clock, never a second. */
  readonly clock: ConsoleClock;
}

/**
 * One window's store-health reading, kept current by the two triggers it has.
 *
 * A {@link ReadTriggerTarget} so the wiring is the console's shared one: which
 * moments re-read is `store/read-triggers.ts`'s answer, what a burst costs is the
 * scheduler's, and what this class owns is the call and the settlement.
 */
export class StoreStateRead implements ReadTriggerTarget {
  /**
   * No timeline event refreshes this read, and the empty set states it.
   *
   * This is the WINDOW's storage adapter. No session event bears on how much room a
   * disk has, and a reading that listened for one would be tying a window-wide answer
   * to whichever session happened to be open.
   */
  public readonly triggeringEventKinds: ReadonlySet<string> = NO_TRIGGERING_EVENT_KINDS;
  readonly #uiStateStore: UiStateStore;
  readonly #changes = new Emitter<void>("store state read change");
  readonly #rounds = new GenerationLatch();
  readonly #scheduler: RefreshScheduler;
  #reading: StoreStateReading = NOTHING_READ;
  #isDisposed = false;

  public constructor(options: StoreStateReadOptions) {
    this.#uiStateStore = options.uiStateStore;
    this.#scheduler = new RefreshScheduler({
      clock: options.clock,
      perform: async () => {
        await this.#read();
      },
      // The read body turns a rejection into the `unreadable` arm itself and never
      // rejects, so this covers a defect in the publish rather than anything about
      // the store. It must exist: without it the scheduler re-throws, and a re-throw
      // inside a timer callback reaches no `catch` a surface could render.
      onError: () => undefined,
    });
  }

  /** What the block renders. One held value, so its identity is stable. */
  public snapshot(): StoreStateReading {
    return this.#reading;
  }

  public subscribe(sink: () => void): Unsubscribe {
    return this.#changes.subscribe(sink);
  }

  /** Whether this reading has been disposed. The re-mint reading its holder takes. */
  public get isDisposed(): boolean {
    return this.#isDisposed;
  }

  /**
   * Ask for a read.
   *
   * Every trigger arrives here and none of them calls `health()`: what a burst of
   * reasons costs is the scheduler's decision, and a block that asked directly is the
   * block that had two estimates outstanding at once.
   */
  public requestRead(reason: RefreshReason): void {
    if (this.#isDisposed) {
      return;
    }
    this.#scheduler.request(reason);
  }

  /** Terminal. An answer landing after this publishes nothing. */
  public dispose(): void {
    this.#isDisposed = true;
    this.#scheduler.dispose();
    this.#rounds.supersedeAll();
  }

  /**
   * Ask the store how it is, and publish only if this round is still the live one.
   *
   * The round is minted here and settles here, so the register holds nothing between
   * reads. What it buys is the settlement guard the scheduler cannot give: an answer
   * arriving after this window's store was replaced, or after the page unmounted,
   * finds no key naming its serial and installs nothing.
   */
  async #read(): Promise<void> {
    const round = this.#rounds.currentClaim(this, STORE_HEALTH_READ_KEY);
    try {
      const health = await this.#uiStateStore.health();
      round.settle(() => {
        this.#publish({ kind: "read", health });
      });
    } catch (rejection: unknown) {
      // A store that cannot describe itself is exactly the state a person on a broken
      // adapter is in, and reporting it as "in memory" would be a guess wearing an
      // answer's clothes. Without this arm the block renders "Asking the store how it
      // is" for the life of the window.
      round.settle(() => {
        this.#publish({
          kind: "unreadable",
          refusal: consoleRefusalFrom(rejection, STORE_STATE_ORIGIN),
        });
      });
    }
  }

  #publish(reading: StoreStateReading): void {
    this.#reading = reading;
    this.#changes.emit();
  }
}

/**
 * How a reading whose store moved is retired, declared once at module scope.
 *
 * At module scope because the hook holds it on a dependency of its own: a disposal
 * minted per render would restart the lifetime effect underneath a reading that had
 * not moved.
 */
const STORE_STATE_READ_DISPOSAL: SubjectScopedDisposal<StoreStateRead> = {
  dispose: (read) => {
    read.dispose();
  },
  isClosed: (read) => read.isDisposed,
};

/**
 * Ask the store how it is, at mount and whenever this window comes back.
 *
 * THE STORE IS THE SUBJECT. The reading is held per store rather than per window, so
 * a composition that replaced the store — an auxiliary window, a test moving between
 * two — reads the new store's own answer on the first pass rather than the previous
 * store's for one frame.
 *
 * THE CLOCK IS THE WINDOW'S, through `useConsoleClock` rather than a `RealClock` of
 * this reading's own. The scheduler arms a timeout, and `Spec-023 §Console Design
 * (Meridian)` fixes the fixture clock as the only clock a renderer reads in fixture
 * mode — a second time base here would leave this one read debouncing on wall time
 * while every other schedule in the window ran on frozen time. That hook also holds
 * the pin the read needs: a clock read straight from a render body has a new identity
 * every pass, and this reading is built around one.
 */
export function useStoreStateReading(uiStateStore: UiStateStore): StoreStateReading {
  const clock = useConsoleClock();
  const { value: read } = useSubjectScopedResource(
    uiStateStore,
    undefined,
    () => new StoreStateRead({ uiStateStore, clock }),
    STORE_STATE_READ_DISPOSAL,
  );
  // The one reading in the console that takes no reconnect signal: it asks the
  // WINDOW's storage adapter how it is, so the transport coming back moves nothing
  // in its answer. Stated rather than defaulted — see `NO_TRANSPORT_RECONNECT`.
  useWindowReadTriggers(read, NO_TRANSPORT_RECONNECT);
  return useSyncExternalStore(
    (onStoreChange: () => void) => read.subscribe(onStoreChange),
    () => read.snapshot(),
    () => read.snapshot(),
  );
}

// The console's one live announcer.
//
// `Spec-023 §Console Libraries` makes the headless primitives OWN-BUILD, and this
// is the one every family after the substrate would otherwise re-mint: a deck drop
// outcome, a run-state change, an attention item, a toast. Each of those minting
// its own `aria-live` node is not a style problem — a screen reader reads live
// regions in the order the DOM mutates them, so N regions is N speakers talking
// over each other, and the second one to change wins for reasons nobody can see.
//
// FOUR DECISIONS, each of which is a defect if it goes the other way.
//
//   1. **The regions live for the window, not for the announcement.** A live region
//      inserted into the document ALREADY CARRYING its text is not announced by
//      most screen readers: the observer fires on a subtree insertion whose region
//      semantics did not exist a moment earlier. So the regions mount empty with
//      the frame and are mutated afterwards; nothing here ever creates a node to
//      speak through. This is why the announcer is a long-lived object with a
//      `dispose()` rather than a function that renders something.
//
//   2. **Announcements are serialised, not overwritten.** A reader speaks one
//      message at a time. Replacing a region's text a frame after setting it means
//      the first message was never heard, so a second announcement arriving inside
//      the hold window is QUEUED behind the standing one and published when it
//      clears. The queue is bounded per lane (`LIVE_ANNOUNCEMENT_QUEUE_CAP`) and
//      sheds its oldest entry, which is the only shedding order that keeps the
//      newest fact.
//
//   3. **Identical consecutive messages coalesce.** Announcing the same words while
//      those words are still standing is a no-op at the region — the string did not
//      change, so nothing is spoken — and a render loop that called `announce` on
//      every pass would otherwise fill the queue with copies of one sentence and
//      shed every other announcement behind them. Coalescing is measured against
//      the lane's standing message AND its queue tail, so a repeat that arrives
//      after the clear is a real second announcement and is spoken again.
//
//   4. **One armed timer, ever.** `Spec-023 §Console Design (Meridian)`'s
//      idle-CPU budget is checked by counting armed work on the `ConsoleClock`
//      seam, so the announcer arms at most one timeout at a time — for the earliest
//      lane deadline — and re-arms from inside its own tick. Nothing polls, and an
//      idle announcer holds no handle at all.

import {
  Emitter,
  LIVE_ANNOUNCEMENT_HOLD_MS,
  LIVE_ANNOUNCEMENT_QUEUE_CAP,
  RealClock,
  type ConsoleClock,
  type EmitterSink,
  type ScheduledHandle,
  type Unsubscribe,
} from "../core/index.js";

/**
 * The two speech channels, declared once.
 *
 * `assertive` interrupts whatever the reader is saying, so it is reserved for
 * refusals and failures — the things that changed what the operator can do. Every
 * other announcement is `polite` and waits its turn. A third level is not a
 * vocabulary this console has: `aria-live="off"` is "do not announce", which is
 * spelled by not calling `announce`.
 */
export const ANNOUNCEMENT_POLITENESS_LEVELS = ["polite", "assertive"] as const;

export type AnnouncementPoliteness = (typeof ANNOUNCEMENT_POLITENESS_LEVELS)[number];

/** What a caller is handed by `useAnnounce`. Stable for the announcer's life. */
export type Announce = (message: string, politeness?: AnnouncementPoliteness) => void;

/** The text each region is showing right now. Empty string means "say nothing". */
export interface LiveAnnouncementState {
  readonly polite: string;
  readonly assertive: string;
}

export interface LiveAnnouncerOptions {
  /** Defaults to `RealClock`. The clear deadline is the only timer this class arms. */
  readonly clock?: ConsoleClock;
  /** Defaults to `LIVE_ANNOUNCEMENT_QUEUE_CAP`, per lane. */
  readonly queueCap?: number;
  /** Defaults to `LIVE_ANNOUNCEMENT_HOLD_MS`. */
  readonly holdMs?: number;
}

const SILENT: LiveAnnouncementState = { polite: "", assertive: "" };

export class LiveAnnouncer {
  readonly #clock: ConsoleClock;
  readonly #queueCap: number;
  readonly #holdMs: number;
  readonly #changes = new Emitter<LiveAnnouncementState>("live announcement");

  /** Waiting behind the standing message, per lane, oldest first. */
  readonly #queuedByPoliteness: Record<AnnouncementPoliteness, string[]> = {
    polite: [],
    assertive: [],
  };

  /**
   * When each lane's standing message may be cleared, on the injected clock.
   *
   * Per lane rather than one shared deadline: the two lanes publish at unrelated
   * moments, and a shared one would clear a message that had been standing for a
   * millisecond because the other lane's window happened to be closing.
   */
  readonly #clearableAtByPoliteness: Record<AnnouncementPoliteness, number> = {
    polite: 0,
    assertive: 0,
  };

  #state: LiveAnnouncementState = SILENT;
  #armedHandle: ScheduledHandle | undefined;
  #disposed = false;

  public constructor(options: LiveAnnouncerOptions = {}) {
    this.#clock = options.clock ?? new RealClock();
    this.#queueCap = options.queueCap ?? LIVE_ANNOUNCEMENT_QUEUE_CAP;
    this.#holdMs = options.holdMs ?? LIVE_ANNOUNCEMENT_HOLD_MS;
  }

  /**
   * Say something.
   *
   * A bound field rather than a method so its identity is the announcer's, for the
   * announcer's whole life: `useAnnounce` hands this straight to callers, and a
   * method would either lose `this` on the way — a private-field `TypeError` at the
   * first call — or have to be re-bound inside a `useCallback` whose dependency
   * list is a second place the binding can go wrong.
   */
  public readonly announce: Announce = (message, politeness = "polite"): void => {
    if (this.#disposed) {
      return;
    }
    const lane = this.#queuedByPoliteness[politeness];
    const standing = this.#state[politeness];
    const queuedLast = lane.at(-1);
    if (message === (queuedLast ?? standing)) {
      // Identical and consecutive: the words are already on their way to being
      // said. See decision 3 in the file header.
      return;
    }
    if (standing === "") {
      this.#publish(politeness, message);
    } else {
      lane.push(message);
      while (lane.length > this.#queueCap) {
        lane.shift();
      }
    }
    this.#armNextClear();
  };

  /** Subscribe to region text. The `LiveRegion` component is the only caller. */
  public subscribe(sink: EmitterSink<LiveAnnouncementState>): Unsubscribe {
    return this.#changes.subscribe(sink);
  }

  /**
   * The text both regions are showing.
   *
   * A stored object replaced only when something changed, because it is read as a
   * `useSyncExternalStore` snapshot: a fresh literal per read would make React see
   * a new value on every render and loop.
   */
  public get state(): LiveAnnouncementState {
    return this.#state;
  }

  /** True while a clear is armed. The idle-CPU claim reads this rather than a timer. */
  public get isArmed(): boolean {
    return this.#armedHandle !== undefined;
  }

  /** True once `dispose` has run. The provider's re-mint arm reads this. */
  public get isDisposed(): boolean {
    return this.#disposed;
  }

  /**
   * Drop everything armed, queued, and subscribed. Terminal: a late `announce`
   * from a component that has already unmounted must not be able to re-arm a timer
   * on a window that is gone.
   */
  public dispose(): void {
    this.#disposed = true;
    if (this.#armedHandle !== undefined) {
      this.#clock.cancel(this.#armedHandle);
      this.#armedHandle = undefined;
    }
    for (const politeness of ANNOUNCEMENT_POLITENESS_LEVELS) {
      this.#queuedByPoliteness[politeness].length = 0;
      this.#clearableAtByPoliteness[politeness] = 0;
    }
    this.#changes.clear();
  }

  #publish(politeness: AnnouncementPoliteness, message: string): void {
    this.#clearableAtByPoliteness[politeness] =
      message === "" ? 0 : this.#clock.now() + this.#holdMs;
    const next: LiveAnnouncementState = { ...this.#state, [politeness]: message };
    this.#state = next;
    this.#changes.emit(next);
  }

  /**
   * Clear every lane whose hold has expired, publish what was behind it, and re-arm
   * for whichever deadline is now soonest.
   *
   * The re-arm happens here rather than at the `scheduleTimeout` call site so there
   * is exactly one place a handle is minted and exactly one place it is dropped.
   */
  #runDueClears(): void {
    this.#armedHandle = undefined;
    if (this.#disposed) {
      return;
    }
    const now = this.#clock.now();
    for (const politeness of ANNOUNCEMENT_POLITENESS_LEVELS) {
      if (this.#state[politeness] === "") {
        continue;
      }
      if (this.#clearableAtByPoliteness[politeness] > now) {
        continue;
      }
      this.#publish(politeness, this.#queuedByPoliteness[politeness].shift() ?? "");
    }
    this.#armNextClear();
  }

  #armNextClear(): void {
    if (this.#disposed || this.#armedHandle !== undefined) {
      return;
    }
    // Only a standing message needs clearing; a queued one is not being read yet
    // and gets its own deadline when it is published.
    const deadlines = ANNOUNCEMENT_POLITENESS_LEVELS.filter(
      (politeness) => this.#state[politeness] !== "",
    ).map((politeness) => this.#clearableAtByPoliteness[politeness]);
    if (deadlines.length === 0) {
      return;
    }
    const delayMs = Math.max(0, Math.min(...deadlines) - this.#clock.now());
    this.#armedHandle = this.#clock.scheduleTimeout(() => {
      this.#runDueClears();
    }, delayMs);
  }
}

// The app's one live announcer: a single object every feature announces through, so there
// are not several `aria-live` nodes talking over each other.
//
// 1. The regions live for the window. A live region inserted already carrying text is not
//    announced by most screen readers, so the regions mount empty with the frame and are only
//    mutated afterwards.
// 2. Announcements are serialized. A second message inside the hold window queues behind the
//    standing one; each lane is bounded and sheds its oldest entry, keeping the newest fact.
// 3. Identical consecutive messages coalesce, measured against the standing message and the
//    queue tail, so a render loop cannot fill the queue with copies. A repeat after the clear
//    is spoken again.
// 4. At most one timer is armed, for the earliest lane deadline, and re-armed from its own tick.
//    Nothing polls, and an idle announcer holds no handle.

import { Emitter, type EmitterSink, type Unsubscribe } from "@renderer/lib/emitter.js";
import {
  LIVE_ANNOUNCEMENT_HOLD_MS,
  LIVE_ANNOUNCEMENT_QUEUE_CAP,
} from "./live-announcement-caps.js";
import { RealClock, type Clock, type ScheduledHandle } from "@renderer/lib/clock.js";

/**
 * The two speech channels. `assertive` interrupts the reader and is reserved for refusals and
 * failures; everything else is `polite`. "Do not announce" is not calling `announce`.
 */
export const ANNOUNCEMENT_POLITENESS_LEVELS = ["polite", "assertive"] as const;

/** One of `ANNOUNCEMENT_POLITENESS_LEVELS`. */
export type AnnouncementPoliteness = (typeof ANNOUNCEMENT_POLITENESS_LEVELS)[number];

/** What a caller is handed by `useAnnounce`. Stable for the announcer's life. */
export type Announce = (message: string, politeness?: AnnouncementPoliteness) => void;

/** The text each region is showing right now. Empty string means "say nothing". */
export interface LiveAnnouncementState {
  readonly polite: string;
  readonly assertive: string;
}

/** Construction options for `LiveAnnouncer`. */
export interface LiveAnnouncerOptions {
  /** Defaults to `RealClock`. The clear deadline is the only timer this class arms. */
  readonly clock?: Clock;
  /** Defaults to `LIVE_ANNOUNCEMENT_QUEUE_CAP`, per lane. */
  readonly queueCap?: number;
  /** Defaults to `LIVE_ANNOUNCEMENT_HOLD_MS`. */
  readonly holdMs?: number;
}

const SILENT: LiveAnnouncementState = { polite: "", assertive: "" };

/**
 * The window's announcer: owns the two lanes' standing text, queues, and the clear timer.
 * `dispose` is terminal.
 */
export class LiveAnnouncer {
  readonly #clock: Clock;
  readonly #queueCap: number;
  readonly #holdMs: number;
  readonly #changes = new Emitter<LiveAnnouncementState>("live announcement");

  /** Waiting behind the standing message, per lane, oldest first. */
  readonly #queuedByPoliteness: Record<AnnouncementPoliteness, string[]> = {
    polite: [],
    assertive: [],
  };

  /**
   * When each lane's standing message may be cleared; per lane because the lanes publish
   * independently.
   */
  readonly #clearableAtByPoliteness: Record<AnnouncementPoliteness, number> = {
    polite: 0,
    assertive: 0,
  };

  #state: LiveAnnouncementState = SILENT;
  #armedHandle: ScheduledHandle | undefined;
  #disposed = false;

  /** Says something. A bound field, so `useAnnounce` can hand it out without losing `this`. */
  public readonly announce: Announce = (message, politeness = "polite"): void => {
    if (this.#disposed) {
      return;
    }
    const lane = this.#queuedByPoliteness[politeness];
    const standing = this.#state[politeness];
    const queuedLast = lane.at(-1);
    if (message === (queuedLast ?? standing)) {
      // Identical and consecutive: already on its way to being said.
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

  public constructor(options: LiveAnnouncerOptions = {}) {
    this.#clock = options.clock ?? new RealClock();
    this.#queueCap = options.queueCap ?? LIVE_ANNOUNCEMENT_QUEUE_CAP;
    this.#holdMs = options.holdMs ?? LIVE_ANNOUNCEMENT_HOLD_MS;
  }

  /** Subscribes to region text; `LiveRegion` is the only caller. */
  public subscribe(sink: EmitterSink<LiveAnnouncementState>): Unsubscribe {
    return this.#changes.subscribe(sink);
  }

  /**
   * The text both regions show; replaced only on change, since it is a `useSyncExternalStore`
   * snapshot.
   */
  public get state(): LiveAnnouncementState {
    return this.#state;
  }

  /** True once `dispose` has run; the provider re-mints on it. */
  public get isDisposed(): boolean {
    return this.#disposed;
  }

  /**
   * Drops everything armed, queued and subscribed. Terminal: a late `announce` cannot re-arm a
   * timer.
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

  /** Clears every lane whose hold has expired, publishes what was behind it, and re-arms. */
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
    // Only a standing message needs clearing; a queued one gets a deadline when published.
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

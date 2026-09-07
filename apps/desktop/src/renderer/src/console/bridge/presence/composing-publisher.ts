// The composer's half of `activity.typing`: this participant, saying they are typing.
//
// THE READ HAS A HOME AND SO DOES THE WRITE, AND THEY ARE NOT THE SAME PLACE. The
// collaboration family folds everyone ELSE's activity into its indicator registry.
// This is the other direction — one participant's own publication — and its reader
// is the composer, which lives outside the console entirely and reaches each console
// family through that family's door. So it sits in `bridge/`: it is a write adapter
// over the growth port, the mirror image of the reads under `quotas/`, and the
// lowest family both the composer and any later publisher can reach.
//
// NEVER AWARENESS DIRECTLY (I-023-8). Every publication here is a growth-port call
// that stands in for the daemon presence handler surface Plan-002 T3.5 ships. The
// renderer holds no Yjs document, writes no Awareness field, and has no path to one:
// the port is the only seam, and under both bridges today it refuses.
//
// AND NEVER FOR A MEMBERSHIP-RESTRICTED CHANNEL. The suppression is applied
// daemon-side before anything leaves the machine, and a composer that published for a
// restricted channel would be routing around it even where the daemon would drop the
// write. The renderer cannot positively classify a channel — `ChannelListResponseChannel`
// carries `id`, `name`, `state`, and `participantCount` and no audience discriminator
// anywhere — so the gate is stated the only sound way round: publish ONLY where
// non-restriction is established, which is the session's own bootstrap channel and
// nothing else. {@link publishableChannelId} is that rule and the only way in.
//
// WHY THE BOOTSTRAP CHANNEL IS RECOGNISED BY ITS NAME AND NOT BY DERIVING ITS ID.
// `deriveMainChannelId` would name it exactly, and it hashes: reaching for it here
// would pull SHA-256 into the chunk the composer paints on first paint, to re-derive
// an id the session projection is already carrying beside the name that identifies
// it. `MAIN_CHANNEL_NAME` is the same contract's own constant, it is the canonical
// name mixed INTO that derivation, and comparing against it costs nothing.
//
// THREE BOUNDS, AND ALL THREE ARE THE CONSOLE'S. A publication every keystroke would
// be one wire call per character, so a publication is rate-limited to
// `COMPOSING_PUBLISH_INTERVAL_MS`; a person who stops typing is not composing, so a
// clear is armed at `COMPOSING_IDLE_STOP_MS` after the last keystroke; and both are
// stated against the receiver's `COMPOSING_RECEIVED_STALE_MS` in the module that
// declares all three. Nothing here polls: the interval is a comparison against the
// clock at the moment a keystroke arrives, and the stop is a single armed timeout
// that a later keystroke re-arms rather than a repeating one.
//
// A REFUSAL IS TERMINAL FOR THE PUBLISHER'S LIFETIME. The port refuses this wire
// under both bridges today, and a publisher that retried would put one refused call
// on the port per keystroke for the length of every message a person ever types. So
// the first refusal stops it: the composer goes on working and publishes nothing,
// which is exactly the state the corpus is in until Plan-002 T3.5 lands the surface.

import { MAIN_CHANNEL_NAME } from "@ai-sidekicks/contracts";

import {
  COMPOSING_IDLE_STOP_MS,
  COMPOSING_PUBLISH_INTERVAL_MS,
  type ConsoleClock,
  type ScheduledHandle,
} from "../../core/index.js";
import type { GrowthPort } from "../growth-port/growth-port.js";

/** What the composer knows about where it is addressed, and all this needs. */
export interface ComposingChannelTarget {
  /** The channel the send is addressed to, absent when it is the session's default. */
  readonly channelId: string | undefined;
  /** That channel's wire-verbatim projected name, absent until the log carries one. */
  readonly channelName: string | undefined;
}

/**
 * The channel this target may publish a composing indicator for, or `undefined`.
 *
 * Fail-closed and exported so the rule is drivable on its own rather than only
 * through a publisher holding a clock and a port. Two conjuncts, both required:
 *
 *   • an id, because `activity.typing` carries one and there is nothing to publish
 *     without it. A target with no id is the session's DEFAULT channel — an answer
 *     the wire supports for a send and not a channel this window can name — so it
 *     publishes nothing rather than guessing which channel that resolves to.
 *   • the canonical bootstrap NAME, because that channel is the one every member of
 *     the session is in by construction. Every other channel in the projection may
 *     be membership-restricted and the renderer has no member that would say.
 */
export function publishableChannelId(target: ComposingChannelTarget): string | undefined {
  return target.channelId !== undefined && target.channelName === MAIN_CHANNEL_NAME
    ? target.channelId
    : undefined;
}

/** What one publisher is built over. Constructed per addressed composer. */
export interface ComposingPublisherOptions {
  readonly growth: GrowthPort;
  readonly clock: ConsoleClock;
  readonly sessionId: string;
}

/**
 * One participant's composing publication, for one session.
 *
 * A class with private fields: it owns an armed timeout, a last-published instant,
 * and a terminal refusal, so it owns a teardown — and a suite drives every bound on
 * a frozen clock with no real timer and no bridge.
 */
export class ComposingPublisher {
  readonly #options: ComposingPublisherOptions;
  #stopHandle: ScheduledHandle | undefined;
  #publishedChannelId: string | undefined;
  #lastPublishedAtMilliseconds = 0;
  #isStopped = false;
  #isDisposed = false;

  public constructor(options: ComposingPublisherOptions) {
    this.#options = options;
  }

  /** The channel a publication is currently outstanding for, or `undefined`. */
  public get publishedChannelId(): string | undefined {
    return this.#publishedChannelId;
  }

  /** Whether a refusal has retired this publisher. Terminal once true. */
  public get isStopped(): boolean {
    return this.#isStopped;
  }

  /**
   * Whether this publisher has been released. Terminal once true.
   *
   * Read by the resource holder that owns its lifetime, which needs a way to
   * recognise a closed resource rather than assuming the one it holds is live.
   */
  public get isDisposed(): boolean {
    return this.#isDisposed;
  }

  /**
   * A person typed something, addressed here.
   *
   * Publishes when the target is publishable AND either the channel changed or the
   * rate-limit window has elapsed — and re-arms the idle clear on EVERY call, which
   * is what makes the stop measure the last keystroke rather than the last
   * publication. A target that is not publishable clears an outstanding publication
   * rather than leaving one standing: a person who moves from the bootstrap channel
   * to a restricted one has stopped composing where everybody could see it.
   */
  public noteComposing(target: ComposingChannelTarget): void {
    if (this.#isStopped || this.#isDisposed) {
      return;
    }
    const channelId = publishableChannelId(target);
    if (channelId === undefined) {
      this.stop();
      return;
    }
    this.#armStop();
    const now = this.#options.clock.now();
    const isNewChannel = channelId !== this.#publishedChannelId;
    const isWindowElapsed =
      now - this.#lastPublishedAtMilliseconds >= COMPOSING_PUBLISH_INTERVAL_MS;
    if (!isNewChannel && !isWindowElapsed) {
      return;
    }
    this.#publishedChannelId = channelId;
    this.#lastPublishedAtMilliseconds = now;
    void this.#publishSet(channelId);
  }

  /**
   * Publish the clear now — the send landed, the composer emptied, focus left.
   *
   * Idempotent, and safe with nothing outstanding: the armed stop is cancelled
   * either way, so a caller never has to ask whether it published in the first place.
   */
  public stop(): void {
    this.#cancelStop();
    if (this.#publishedChannelId === undefined) {
      return;
    }
    this.#publishedChannelId = undefined;
    this.#lastPublishedAtMilliseconds = 0;
    if (this.#isStopped || this.#isDisposed) {
      return;
    }
    void this.#publishClear();
  }

  /**
   * Release the publisher, clearing an outstanding publication on the way out.
   *
   * The clear is dispatched BEFORE the disposed flag is set, because the alternative
   * is a person who closed a window leaving a composing indicator up in everybody
   * else's roster until the receiver's own bound expired it.
   */
  public dispose(): void {
    this.stop();
    this.#cancelStop();
    this.#isDisposed = true;
  }

  /** Arm — or re-arm — the idle clear. One timeout, never a repeating one. */
  #armStop(): void {
    this.#cancelStop();
    this.#stopHandle = this.#options.clock.scheduleTimeout(() => {
      this.#stopHandle = undefined;
      this.stop();
    }, COMPOSING_IDLE_STOP_MS);
  }

  #cancelStop(): void {
    const handle = this.#stopHandle;
    if (handle === undefined) {
      return;
    }
    this.#stopHandle = undefined;
    this.#options.clock.cancel(handle);
  }

  async #publishSet(channelId: string): Promise<void> {
    await this.#dispatch(async () => {
      const outcome = await this.#options.growth.presenceComposingSet({
        sessionId: this.#options.sessionId,
        channelId,
      });
      return outcome.status === "served";
    });
  }

  async #publishClear(): Promise<void> {
    await this.#dispatch(async () => {
      const outcome = await this.#options.growth.presenceComposingClear({
        sessionId: this.#options.sessionId,
      });
      return outcome.status === "served";
    });
  }

  /**
   * Run one publication and retire the publisher unless the port served it.
   *
   * A thrown call and a refused one are the same answer here — the publication did
   * not happen — and both retire it. Nothing is surfaced: a composing indicator is
   * an ambient courtesy, and a person mid-sentence is the worst possible audience
   * for a message about a wire that has not been built yet. The state is readable on
   * {@link isStopped}, which is where a test asserts it.
   */
  async #dispatch(publish: () => Promise<boolean>): Promise<void> {
    try {
      if (await publish()) {
        return;
      }
    } catch {
      // Falls through to the same retirement: see above.
    }
    this.#isStopped = true;
    this.#publishedChannelId = undefined;
    this.#cancelStop();
  }
}

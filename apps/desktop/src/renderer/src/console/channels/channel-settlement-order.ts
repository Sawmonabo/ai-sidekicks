// Where one directory read sits against the lifecycle receipts it must not overwrite.
//
// THE DEFECT THIS EXISTS FOR. A mute answers, the `channel.muted` event starts a fresh
// directory read, and the person unmutes the same row before that read settles. The
// unmute's own receipt is the daemon's newest word about the channel — and then the read
// that was already on the wire lands reporting `muted`, because it was issued before the
// unmute happened. Compared by STATE, that reply looks like news: a third state, newer
// than the overlay, so the overlay went and the row flipped back to muted with Unmute
// offered again, over an act the daemon had already performed. Nothing on screen said so,
// and the next read put it right — which is worse than a visible failure, because the
// window in which the surface contradicts itself is exactly the window a person is
// looking at it.
//
// SO THE COMPARISON IS ORDER AND NOT STATE. A directory read takes its POSITION at the
// moment it is issued; a settled receipt advances the order for the channel it names. A
// reply from a read issued before that receipt cannot retire it and cannot render over
// it — while it still fills every other row, which is why the position is per channel
// rather than one flag over the whole reply. A surface that owns its own read orders the
// same collision one line up, with the receipt opening a round on the read line itself;
// here the directory read is a push-driven model the list only receives answers from, so
// the ordering travels ON the reply instead of aborting it.
//
// AND THE SEQUENCE SOURCE IS THE CONSOLE'S OWN. `store/read/generation-latch.ts` is the
// monotonic serial this repository already has, keyed by subject and key, and it is what
// is keyed here: one key per channel, superseded by each settlement for that channel. A
// counter of this module's own would be a second generation mechanism beside it — the one
// thing that guarantees two answers to "is this still current" that can disagree.

import { GenerationLatch, type CurrentGenerationClaim } from "../store/index.js";

/**
 * Where a read that was issued at some moment sits against the settlements so far.
 *
 * Taken at ISSUE and read at every later moment, never snapshotted into a boolean: a
 * receipt landing while this read is in flight has to move the answer, and that is the
 * whole case this exists for. So the position holds live claims and asks them.
 */
export interface ChannelSettlementPosition {
  /**
   * Whether the read holding this position was issued after this channel's newest
   * lifecycle settlement.
   *
   * `false` for a channel whose newest settlement landed after the read was issued —
   * including a channel that had no settlement at all when the read went out, which is
   * the ordinary shape of a first move on a row.
   */
  postdatesSettlementFor(channelId: string): boolean;
}

/**
 * The settlement order for one session's channel directory.
 *
 * A class with private fields rather than a counter in a hook body, and one per
 * directory: the order is about ONE read line and one set of receipts, and two surfaces
 * sharing an order would let either one's receipt retire the other's overlay.
 */
export class ChannelSettlementOrder {
  /**
   * The serial every position is measured against. Keyed by channel, so a receipt for
   * one row orders nothing about another and a stale reply still fills every row the
   * receipt did not name.
   *
   * The subject is this order itself: the latch holds subjects weakly, so the register
   * dies with the directory that owns it.
   */
  readonly #latch = new GenerationLatch();
  /**
   * The channels a receipt has ever named here.
   *
   * The latch enumerates no keys, and a position has to capture a claim for every
   * channel it might later be asked about — so the ids are held beside it. Bounded by
   * the channels this session has actually moved, which is the same bound the overlay
   * map has.
   */
  readonly #settledChannelIds = new Set<string>();

  /**
   * Record one settled lifecycle receipt: every read already issued is now older.
   *
   * Called when the daemon's answer lands and before anything is published from it, so
   * a read in flight is behind this settlement from the moment the answer exists rather
   * than from the moment a render notices it.
   */
  public noteSettled(channelId: string): void {
    this.#settledChannelIds.add(channelId);
    // The newest intent wins and never refuses, which is exactly a receipt: it is the
    // daemon's own answer, so it supersedes whatever position held this key.
    this.#latch.supersedeAndClaim(this, channelId);
  }

  /**
   * Take the position a read issued right now holds.
   *
   * Called BEFORE the request goes out, never after the reply lands: the question this
   * answers is which settlements the read could not have seen, and a position taken at
   * the reply would report every settlement as already seen.
   */
  public openRead(): ChannelSettlementPosition {
    return new CapturedSettlementPosition(
      new Map(
        [...this.#settledChannelIds].map((channelId) => [
          channelId,
          // `currentClaim` JOINS the round a settlement holds rather than superseding
          // it: a read is a reader of this order and never a writer of it.
          this.#latch.currentClaim(this, channelId),
        ]),
      ),
    );
  }
}

/**
 * One read's captured claims, asked live.
 *
 * Not exported: a position is minted by the order and by nothing else, so the only way
 * to hold one is to have taken a read out of the order that issued it.
 */
class CapturedSettlementPosition implements ChannelSettlementPosition {
  readonly #claimByChannelId: ReadonlyMap<string, CurrentGenerationClaim>;

  public constructor(claimByChannelId: ReadonlyMap<string, CurrentGenerationClaim>) {
    this.#claimByChannelId = claimByChannelId;
  }

  public postdatesSettlementFor(channelId: string): boolean {
    // No captured claim means this channel had no settlement when the read went out, so
    // any settlement it has now is newer than the read — the same answer a superseded
    // claim gives, reached by the other route.
    return this.#claimByChannelId.get(channelId)?.isCurrent ?? false;
  }
}

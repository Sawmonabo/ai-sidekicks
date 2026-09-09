// What the cost page HOLDS: one receipt read, and the last figure it was served.
//
// THREE TRIGGERS, ONE READ AT A TIME. The mount, the window regaining focus, and the
// transport coming back all ask this page to re-read, and they overlap in practice —
// a window that reconnects is a window that was just refocused. The page called the
// port directly from each of them, so two calls could be outstanding at once and
// whichever ANSWERED last won: an older receipt would replace a newer one on screen,
// and the retained figure beside it would be stamped with the later completion, so
// the stamp said the stale figure was the fresh one. Nothing on screen reported it.
//
// SO THE READ GOES THROUGH `store/read/refresh-scheduler.ts` AND NOTHING ELSE. That scheduler is
// the console's one refresh chokepoint — trailing debounce with an absolute deadline
// so a stream of reasons still gets a read, and SERIALIZED, so a reason raised while
// a read is in flight becomes the NEXT read rather than a parallel one. Two replies
// therefore never race, which is why no sequence number appears anywhere below: the
// property is a consequence of routing through the chokepoint, and a counter here
// would be a second answer to a question the substrate already answers.
//
// AND THE SETTLEMENT IS MEASURED AGAINST `store/read/generation-latch.ts`. Serialization
// bounds what this reading can race against ITSELF; it says nothing about a reading
// whose session moved or whose page unmounted while a call was outstanding. Nothing
// behind the bridge is cancellable, so a superseded reply is IGNORED rather than
// stopped — which is exactly what the latch expresses, and it is where the retained
// figure's instant is read, so the stamp belongs to the read that published.
//
// BOTH OF THOSE ARRIVE THROUGH `store/read/scheduled-reading.ts`, which is the whole of
// what this module no longer writes: the emitter, the scheduler with its `onError`
// arm, the latch, the disposal flag, and the `snapshot`/`subscribe`/`requestRead`/
// `dispose` skeleton were hand-written here and in fifteen other readings, with the
// revisioned publisher below character-for-character identical in three unrelated
// families. What stays is what is this page's: the question it asks, the refusal it
// spells when the port does not answer, the stamp on the figure it was served, and
// the fold that revises the snapshot.
//
// ONE READING PER SESSION, MINTED IN THE RENDER THAT FIRST SEES IT. The subject
// primitive addresses during the render rather than in an effect, so the pass that
// first sees a new session already reads that session's own empty seed — never the
// previous session's money figures under the new session's name for one frame.

import { useSyncExternalStore } from "react";

import type { ConsoleBridge } from "../../../bridge/index.js";
import type { ConsoleClock } from "../../../core/index.js";
import { consoleRefusalFrom } from "../../../seats/index.js";
import {
  NO_TRIGGERING_EVENT_KINDS,
  ScheduledReading,
  useSubjectScopedResource,
  useWindowReadTriggers,
  type SubjectScopedDisposal,
} from "../../../store/index.js";
import type {
  CostReceiptOutcome,
  CostReceiptReading,
  RetainedReceipt,
} from "./cost-receipt-model.js";

/** Names a read that produced no outcome at all, where the thrown value named none. */
const COST_RECEIPT_ORIGIN = "cost-receipt";

/** Everything the cost page renders from, in one value. */
export interface CostReceiptReadSnapshot {
  /** What the last settled read answered, or `undefined` before one has. */
  readonly reading: CostReceiptReading | undefined;
  /**
   * The last figure this session was actually served, held beside the reading.
   *
   * Beside rather than inside, which is the whole of what it is for: a re-read in
   * flight and a re-read refused both leave the reading without a figure, and a
   * window coming back from elsewhere would otherwise lose the number it was showing.
   */
  readonly retained: RetainedReceipt | undefined;
  /** Bumped on every transition, so `useSyncExternalStore` sees a new identity. */
  readonly revision: number;
}

const NOTHING_READ: CostReceiptReadSnapshot = {
  reading: undefined,
  retained: undefined,
  revision: 0,
};

export interface CostReceiptReadOptions {
  readonly bridge: ConsoleBridge;
  /**
   * The session being read, or `undefined` where this window has opened none.
   *
   * An absence rather than a zero: a settings address carries no session, so a page
   * addressed without one asks the accountant nothing at all rather than asking for
   * a receipt belonging to nobody.
   */
  readonly sessionId: string | undefined;
  /** The clock the scheduler arms on and the retained figure is stamped from. */
  readonly clock: ConsoleClock;
}

/**
 * One session's cost receipt, kept current by the three window triggers.
 *
 * A {@link ScheduledReading}, which is where the scheduler, the single-flight round,
 * the held snapshot and the disposal live; what this class adds is the call, the
 * refusal it spells, and the rule that decides which settlement installs.
 * {@link useCostReceiptRead} is the React binding and holds nothing.
 */
export class CostReceiptRead extends ScheduledReading<CostReceiptReadSnapshot> {
  /**
   * No timeline event refreshes this read, and the empty set states it.
   *
   * The receipt is emitted once per priced turn and this page holds no session store
   * to read a timeline from, so there is no kind it could listen for — which is why
   * the read goes through a scheduler rather than firing once at mount and never
   * again.
   */
  public readonly triggeringEventKinds: ReadonlySet<string> = NO_TRIGGERING_EVENT_KINDS;
  readonly #bridge: ConsoleBridge;
  readonly #sessionId: string | undefined;
  readonly #clock: ConsoleClock;

  public constructor(options: CostReceiptReadOptions) {
    super({
      clock: options.clock,
      initialSnapshot: NOTHING_READ,
      describeChange: "cost receipt read change",
    });
    this.#bridge = options.bridge;
    this.#sessionId = options.sessionId;
    this.#clock = options.clock;
  }

  /**
   * A page addressed with no session asks the accountant nothing.
   *
   * On the guard rather than at each trigger, so the three window reasons and any
   * later one are all answered by the same sentence.
   */
  protected override isReadable(): boolean {
    return this.#sessionId !== undefined;
  }

  /**
   * Read the receipt, and publish only if this round is still the live one.
   *
   * The round is minted here and settles here, so the register holds nothing between
   * reads. What it buys is the settlement guard the scheduler cannot give: a reply
   * arriving after this reading's session moved, or after the page unmounted, finds
   * no key naming its serial and installs nothing.
   */
  protected override async performRead(): Promise<void> {
    const sessionId = this.#sessionId;
    if (sessionId === undefined) {
      return;
    }
    const round = this.currentReadRound();
    try {
      const outcome = await this.#bridge.growth.orchestrationCostReceiptRead({ sessionId });
      round.settle(() => {
        this.#publishAnswer(outcome);
      });
    } catch (rejection: unknown) {
      // The port's contract is that it resolves, and a rejection is off it — which is
      // why this arm exists rather than being left to the window's unhandled handler.
      // Without it the page renders "Reading this session's receipt" for the life of
      // the window, reporting a read that failed as one still in flight.
      round.settle(() => {
        this.#publishChanges({
          reading: {
            kind: "unreadable",
            refusal: consoleRefusalFrom(rejection, COST_RECEIPT_ORIGIN),
          },
        });
      });
    }
  }

  /**
   * Install one settled outcome, and stamp the figure it served.
   *
   * The instant is read HERE — inside the round's settlement — rather than where the
   * call was made or where the render lands, so the stamp belongs to the read that
   * published and never to one whose reply was superseded on the way in.
   */
  #publishAnswer(outcome: CostReceiptOutcome): void {
    const reading: CostReceiptReading = { kind: "answered", outcome };
    if (outcome.status !== "served") {
      this.#publishChanges({ reading });
      return;
    }
    this.#publishChanges({
      reading,
      retained: {
        receipt: outcome.value,
        readAtIso: new Date(this.#clock.now()).toISOString(),
      },
    });
  }

  /**
   * Fold one transition in and revise the snapshot.
   *
   * The FOLD is this page's and the holding is the base's: whether a transition
   * revises a counter is a property of this snapshot type, and a reading that holds a
   * bare value has no counter to revise.
   */
  #publishChanges(changes: Partial<Omit<CostReceiptReadSnapshot, "revision">>): void {
    const current = this.snapshot();
    this.publish({ ...current, ...changes, revision: current.revision + 1 });
  }
}

/**
 * How a reading whose session moved is retired, declared once at module scope.
 *
 * At module scope because the hook holds it on a dependency of its own: a disposal
 * minted per render would restart the lifetime effect underneath a reading that had
 * not moved.
 */
const COST_RECEIPT_READ_DISPOSAL: SubjectScopedDisposal<CostReceiptRead> = {
  dispose: (read) => {
    read.dispose();
  },
  isClosed: (read) => read.isDisposed,
};

/**
 * Hold one reading per session, and wire the three triggers that refresh it.
 *
 * The reading is minted by the subject primitive rather than by a memo, because what
 * ends its life is the SESSION moving and not the component re-rendering — and the
 * primitive addresses during the render, so the first pass that sees a new session
 * already reads that session's own empty seed rather than the previous one's figures.
 */
export function useCostReceiptRead(
  bridge: ConsoleBridge,
  sessionId: string | undefined,
  clock: ConsoleClock,
): CostReceiptReadSnapshot {
  const { value: read } = useSubjectScopedResource(
    bridge,
    sessionId,
    () => new CostReceiptRead({ bridge, sessionId, clock }),
    COST_RECEIPT_READ_DISPOSAL,
  );
  // The window half only: this page holds no session store, so the session half would
  // have no timeline and no repair edge to listen to — which is also why the reconnect
  // edge is taken from the bridge rather than from a session's own repair.
  useWindowReadTriggers(read, bridge.transportReconnect);
  return useSyncExternalStore(
    (onStoreChange: () => void) => read.subscribe(onStoreChange),
    () => read.snapshot(),
    () => read.snapshot(),
  );
}

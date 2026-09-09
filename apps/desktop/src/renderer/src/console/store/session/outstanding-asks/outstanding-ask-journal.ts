// What is still waiting on a person, held OUTSIDE the window it was learned from.
//
// WHY THIS IS NOT A FOLD OVER THE TIMELINE, which is what it used to be. A session's
// stream replays from the position this participant was last acknowledged at, so a
// resumed read establishes a window whose head is somewhere in the middle of the log —
// and the store's `timeline` is that window and nothing else. It is also CAPPED, so a
// long session drops its oldest rows as it runs. A fold over it therefore loses an
// approval the moment its opening row falls out of the window, the count goes to zero,
// and the cast bar prints "Nothing needs you." over a run that is still blocked. That
// is the defect, and no amount of care inside the fold can fix it: the opener is not in
// the input.
//
// SO THE REGISTER IS A LEDGER OF LIFECYCLES AND NOT A VIEW OF ROWS. It is advanced by
// every event the store admits and by every row a backward page recovers, it is seeded
// from the base state a read establishes, and it is cleared by NOTHING that replaces or
// prunes the window. What it holds per lifecycle is two positions and an opener, which
// is all any reader needs and is far smaller than the rows those positions came from.
//
// AND IT IS ORDER-INSENSITIVE BY CONSTRUCTION, which is the property that makes the
// backward walk safe. Rows arrive at the tail in order and at the head in reverse, so a
// register that deleted a key on a terminal would be defeated by a page that then
// delivered that request's OPENING row: the opener would arrive after its own terminal
// and re-open a settled ask forever. Holding the two positions instead makes the answer
// a comparison rather than a history — outstanding means an opener with no terminal
// after it — and the same rows in any order give the same answer.
//
// WHAT THE BASE STATE CAN AND CANNOT CARRY, read rather than assumed. `SessionSnapshot`
// carries entities, and one entity kind answers an ask class authoritatively: a `run`
// row's `state` is a registered `RunState`, so a run blocked on an approval or an
// answer says so on the base state whatever the window's own rows hold. The three
// REQUEST lifecycles have no carrier at all — `store/entities/entities.ts` declares no kind for a
// provider ask or an intervention, and an `approval` row's state vocabulary is a
// renderer-local projection contract that no wire schema registers — so a request
// raised below the window's head is not merely absent, it is UNREADABLE from here.
// {@link OutstandingAskLedger.isWindowHeadUnread} is that fact, and a surface that
// printed an all-clear line over it would be reporting something it never read.

import type { ConsoleEntity, ConsoleSessionEvent } from "../../entities/index.js";
import {
  ATTENTION_RUN_STATE_KINDS,
  RUN_STATE_KINDS,
  identifiedRequestKeyOf,
  isAttentionRunState,
  lifecycleFor,
  runIdOf,
  uncorrelatedKey,
} from "./outstanding-ask-vocabulary.js";

/**
 * One request lifecycle, as two positions and the identity of whoever opened it.
 *
 * POSITIONS RATHER THAN A BOOLEAN, which is what makes the register order-insensitive:
 * a terminal that arrives before its own opener — the ordinary case on a backward page —
 * settles the request all the same, and an opener that arrives afterwards does not
 * re-open it.
 */
export interface OutstandingRequestRecord {
  /** Where the opening event sat, or `undefined` while only a terminal has been seen. */
  readonly openedAtSequence: number | undefined;
  /** Where the newest terminal sat, or `undefined` while none has been seen. */
  readonly closedAtSequence: number | undefined;
  /**
   * Who the OPENING event was attributed to.
   *
   * The opener's and never a resolver's: an approver is not the participant who was
   * blocked, so the identity an ask is attributed to is read once, when it opens.
   */
  readonly opener: string | undefined;
}

/** One run's newest known state, as the position it was read at and what it means. */
export interface OutstandingRunRecord {
  readonly atSequence: number;
  /** Whether that state is one a person has to act on. */
  readonly needsAttention: boolean;
  readonly opener: string | undefined;
}

/** Everything the register knows, as one immutable reading. */
export interface OutstandingAskLedger {
  readonly requestsByKey: ReadonlyMap<string, OutstandingRequestRecord>;
  readonly runsByRunId: ReadonlyMap<string, OutstandingRunRecord>;
  /**
   * Whether requests raised below this window's head exist that were never read here.
   *
   * True while the read that established the base state submitted a position — which is
   * exactly "this window starts partway through the log" — because the three request
   * lifecycles have no base-state carrier to seed them from. Run states are seeded and
   * are therefore NOT what this reports.
   */
  readonly isWindowHeadUnread: boolean;
}

/** What one read establishes about what is outstanding. */
export interface OutstandingAskSeed {
  readonly entities: readonly ConsoleEntity[];
  /**
   * The sequence the base state is current as of, which is the position every entity it
   * carries is seeded AT.
   *
   * So an event ahead of it supersedes the seed and one at or below it does not: a row
   * at or below the cursor is already folded into the entity the read carried, and
   * letting it win would put a run back into a state the base state has passed.
   */
  readonly cursor: number;
  /** The position the read was performed FROM, or `undefined` for the log's beginning. */
  readonly windowHeadCursor: string | undefined;
}

/**
 * One session's outstanding-ask ledger.
 *
 * A class with private fields per `apps/desktop/AGENTS.md`: it is state with two acts
 * that change it, and both acts have to be able to admit rows in any order without every
 * caller remembering why.
 */
export class OutstandingAskJournal {
  readonly #requestsByKey = new Map<string, OutstandingRequestRecord>();
  readonly #runsByRunId = new Map<string, OutstandingRunRecord>();
  #isWindowHeadUnread = false;
  /** Bumped on every change, so a reader can hold one reading and re-ask cheaply. */
  #revision = 0;
  #reading: OutstandingAskLedger | undefined;
  #readingRevision = -1;

  /**
   * Take what a completed read established, WITHOUT forgetting what is already here.
   *
   * A read re-establishes the WINDOW and says nothing about a request it did not carry,
   * so a register cleared here would lose exactly the older asks this class exists to
   * hold. What it does move is the window-head fact, because that is a property of the
   * read that just landed.
   */
  public seedFrom(seed: OutstandingAskSeed): void {
    this.#isWindowHeadUnread = seed.windowHeadCursor !== undefined;
    this.#revision += 1;
    for (const entity of seed.entities) {
      if (entity.kind !== "run") {
        continue;
      }
      this.#recordRunState({
        runId: entity.id,
        atSequence: seed.cursor,
        needsAttention: isAttentionRunState(entity.state),
        opener: entity.attributedTo,
      });
    }
  }

  /** Fold rows into the ledger. Safe in any order, at either end of the log. */
  public admit(events: readonly ConsoleSessionEvent[]): void {
    for (const event of events) {
      this.#admitOne(event);
    }
  }

  /**
   * What the register holds, as one frozen reading.
   *
   * Held between changes so a consumer subscribed to the store's revision re-derives
   * nothing while nothing moved: the maps are copied on the way out, because a reader
   * handed the live ones could watch them change underneath a render.
   */
  public get ledger(): OutstandingAskLedger {
    const reading = this.#reading;
    if (reading !== undefined && this.#readingRevision === this.#revision) {
      return reading;
    }
    const fresh: OutstandingAskLedger = {
      requestsByKey: new Map(this.#requestsByKey),
      runsByRunId: new Map(this.#runsByRunId),
      isWindowHeadUnread: this.#isWindowHeadUnread,
    };
    this.#reading = fresh;
    this.#readingRevision = this.#revision;
    return fresh;
  }

  #admitOne(event: ConsoleSessionEvent): void {
    if (RUN_STATE_KINDS.includes(event.kind)) {
      this.#recordRunState({
        runId: runIdOf(event) ?? uncorrelatedKey(event),
        atSequence: event.sequence,
        needsAttention: ATTENTION_RUN_STATE_KINDS.includes(event.kind),
        opener: event.actorId,
      });
      return;
    }
    const lifecycle = lifecycleFor(event.kind);
    if (lifecycle === undefined) {
      return;
    }
    const requestKey = identifiedRequestKeyOf(event, lifecycle);
    if (event.kind === lifecycle.openedBy) {
      this.#recordRequestOpened(requestKey ?? uncorrelatedKey(event), event);
      return;
    }
    if (requestKey !== undefined) {
      this.#recordRequestClosed(requestKey, event.sequence);
    }
  }

  #recordRunState(record: { readonly runId: string } & OutstandingRunRecord): void {
    const held = this.#runsByRunId.get(record.runId);
    // NEWEST WINS, and equal loses. A row at the seed's own position is one the base
    // state has already folded in, so replaying it would put a run back into the state
    // it was in when this window opened.
    if (held !== undefined && held.atSequence >= record.atSequence) {
      return;
    }
    this.#runsByRunId.set(record.runId, {
      atSequence: record.atSequence,
      needsAttention: record.needsAttention,
      opener: record.opener,
    });
    this.#revision += 1;
  }

  #recordRequestOpened(requestKey: string, event: ConsoleSessionEvent): void {
    const held = this.#requestsByKey.get(requestKey);
    if (held !== undefined && held.openedAtSequence !== undefined) {
      return;
    }
    this.#requestsByKey.set(requestKey, {
      openedAtSequence: event.sequence,
      closedAtSequence: held?.closedAtSequence,
      opener: event.actorId,
    });
    this.#revision += 1;
  }

  #recordRequestClosed(requestKey: string, atSequence: number): void {
    const held = this.#requestsByKey.get(requestKey);
    if (held !== undefined && (held.closedAtSequence ?? -1) >= atSequence) {
      return;
    }
    this.#requestsByKey.set(requestKey, {
      openedAtSequence: held?.openedAtSequence,
      closedAtSequence: atSequence,
      opener: held?.opener,
    });
    this.#revision += 1;
  }
}

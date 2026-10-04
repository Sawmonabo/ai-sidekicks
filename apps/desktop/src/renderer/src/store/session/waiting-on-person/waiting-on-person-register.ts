// What is still waiting on a person, held outside the window it was learned from.
//
// Not a fold over the store's `transcript`: a resumed read starts mid-log and the transcript is
// capped, so an approval's opening row can be gone while the run is still blocked. The register
// is advanced by every admitted event and recovered backward page, seeded from each read's base
// state, and cleared by nothing that replaces or prunes the window.
//
// It keeps two positions per lifecycle (the opener and the newest terminal), so rows in any order
// give the same answer. A backward page delivers an opener after its terminal, and a register that
// deleted a key on a terminal would re-open a settled ask.
//
// The seed reads only `run` entities, whose `state` is a registered `RunState`. The request
// lifecycles have no base-state carrier, so a request raised below the window's head is
// unreadable from here; {@link WaitingOnPersonRecords.isWindowHeadUnread} reports that.

import { RUN_STATE_KINDS } from "@renderer/store/session-events/run-state-kinds.js";
import type { StoredEntity, ProjectedSessionEvent } from "../entities/entities.js";
import {
  ATTENTION_RUN_STATE_KINDS,
  identifiedRequestKeyOf,
  isAttentionRunState,
  lifecycleFor,
  runIdOf,
  uncorrelatedKey,
} from "./waiting-on-person-states.js";

/**
 * One request lifecycle, as two positions. A terminal seen before its opener still settles the
 * request (the ordinary case on a backward page), and a later opener does not re-open it.
 */
export interface WaitingRequestRecord {
  /** Where the opening event sat, or `undefined` while only a terminal has been seen. */
  readonly openedAtSequence: number | undefined;
  /** Where the newest terminal sat, or `undefined` while none has been seen. */
  readonly closedAtSequence: number | undefined;
}

/** One run's newest known state, as the position it was read at and what it means. */
export interface WaitingRunRecord {
  readonly atSequence: number;
  /** Whether that state is one a person has to act on. */
  readonly needsAttention: boolean;
}

/** Everything the register knows, as one immutable reading. */
export interface WaitingOnPersonRecords {
  readonly requestsByKey: ReadonlyMap<string, WaitingRequestRecord>;
  readonly runsByRunId: ReadonlyMap<string, WaitingRunRecord>;
  /**
   * Whether requests raised below this window's head may exist that were never read here.
   * True while the read that established the base state submitted a position, since the window
   * then starts partway through the log. Run states are seeded, so they are not what this reports.
   */
  readonly isWindowHeadUnread: boolean;
}

/** What one read establishes about what is outstanding. */
export interface WaitingOnPersonSeed {
  readonly entities: readonly StoredEntity[];
  /**
   * The sequence the base state is current as of, which every entity it carries is seeded at.
   * An event at or below it is already folded into the seed and must not supersede it.
   */
  readonly cursor: number;
  /** The position the read was performed FROM, or `undefined` for the log's beginning. */
  readonly windowHeadCursor: string | undefined;
}

/**
 * One session's waiting-on-person register, advanced by rows admitted in any order.
 */
export class WaitingOnPersonRegister {
  readonly #requestsByKey = new Map<string, WaitingRequestRecord>();
  readonly #runsByRunId = new Map<string, WaitingRunRecord>();
  #isWindowHeadUnread = false;
  /** Bumped on every change, so a reader can hold one reading and re-ask cheaply. */
  #revision = 0;
  #reading: WaitingOnPersonRecords | undefined;
  #readingRevision = -1;

  /**
   * Take what a completed read established without forgetting the asks already held; only the
   * window-head fact is replaced.
   */
  public seedFrom(seed: WaitingOnPersonSeed): void {
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
      });
    }
  }

  /** Fold rows into the register. Safe in any order, at either end of the log. */
  public admit(events: readonly ProjectedSessionEvent[]): void {
    for (const event of events) {
      this.#admitOne(event);
    }
  }

  /**
   * What the register holds, as one frozen reading. Cached between changes, and the maps are
   * copies so a render cannot watch them change.
   */
  public get records(): WaitingOnPersonRecords {
    const reading = this.#reading;
    if (reading !== undefined && this.#readingRevision === this.#revision) {
      return reading;
    }
    const fresh: WaitingOnPersonRecords = {
      requestsByKey: new Map(this.#requestsByKey),
      runsByRunId: new Map(this.#runsByRunId),
      isWindowHeadUnread: this.#isWindowHeadUnread,
    };
    this.#reading = fresh;
    this.#readingRevision = this.#revision;
    return fresh;
  }

  #admitOne(event: ProjectedSessionEvent): void {
    if (RUN_STATE_KINDS.includes(event.kind)) {
      this.#recordRunState({
        runId: runIdOf(event) ?? uncorrelatedKey(event),
        atSequence: event.sequence,
        needsAttention: ATTENTION_RUN_STATE_KINDS.includes(event.kind),
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

  #recordRunState(record: { readonly runId: string } & WaitingRunRecord): void {
    const held = this.#runsByRunId.get(record.runId);
    // Newest wins and equal loses: a row at the seed's own position is already folded into it.
    if (held !== undefined && held.atSequence >= record.atSequence) {
      return;
    }
    this.#runsByRunId.set(record.runId, {
      atSequence: record.atSequence,
      needsAttention: record.needsAttention,
    });
    this.#revision += 1;
  }

  #recordRequestOpened(requestKey: string, event: ProjectedSessionEvent): void {
    const held = this.#requestsByKey.get(requestKey);
    if (held !== undefined && held.openedAtSequence !== undefined) {
      return;
    }
    this.#requestsByKey.set(requestKey, {
      openedAtSequence: event.sequence,
      closedAtSequence: held?.closedAtSequence,
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
    });
    this.#revision += 1;
  }
}

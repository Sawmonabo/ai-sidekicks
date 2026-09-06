// The frames one stream carried that this build could not read, counted rather than
// dropped.
//
// A DELIVERY THIS BUILD CANNOT READ IS A PARTIAL READ AND NOT A DROP. A tail whose
// parse discards a payload that failed its registered schema, and goes on serving
// what it already held as current, leaves a changed row stale with nothing anywhere
// saying so — which reads exactly like a stream that has not moved. So an unreadable
// delivery moves no row, because the fold never saw it and guessing at it would be
// worse than ignoring it, and the reading says both halves: live, and behind.
//
// HOISTED ON THE SECOND USE. `queue-reading.ts` and `provider-account-quota.ts` each
// tail a registered union, and each held this same pair of fields, bumped on the same
// arm, published under the same two member names. One class, so two streams cannot
// drift into two vocabularies for one fact and a surface that renders both reads one.
//
// THE CLEARING POLICY IS NOT HERE, and that is the one thing the two streams
// genuinely disagree about: the queue's snapshot restates its whole list at one
// moment and supersedes what preceded it, while the account plane's read answers for
// an instant its tail has already moved past and so may never claim to cover a frame
// that arrived after it. That disagreement is a CALL each owner makes where its own
// argument lives — never a mode flag passed in here, which would move the argument
// away from the reasoning and leave neither site stating it.
//
// BOUNDED BY CONSTRUCTION. Only the newest refusal is kept, so the refusals do not
// accumulate, and the sentence names member paths rather than the payload — that
// rule is `refusedMemberPaths`' and stays in `core/`. There is deliberately no
// derived `isPartial` flag beside the count: a boolean whose whole body is
// `count > 0` is a second reading of one fact, and the surfaces compose their notice
// from the count and the refusal together through the partial-read primitive.

import type { ConsoleRefusal } from "../../core/index.js";

/** What a reading carries about the deliveries its stream made unreadably. */
export interface UnreadableDeliveryReading {
  /**
   * Deliveries that parsed as no registered shape on this stream.
   *
   * One vocabulary for every stream that tails a registered union — the queue's, the
   * account plane's, the run-state feed's — so a surface rendering two of them is not
   * reading two words for one fact.
   */
  readonly unreadableDeliveryCount: number;
  /**
   * The newest unreadable delivery's own parse refusal, naming the members that
   * failed. Bounded by keeping only the newest — the refusals do not accumulate —
   * and by naming member paths rather than carrying the payload that failed.
   */
  readonly unreadableRefusal: ConsoleRefusal | undefined;
}

/**
 * A parse's issue list, narrowed to the one member a refusal sentence reads.
 *
 * The same shape `refusedMemberPaths` takes, so a composer written against that
 * helper is admissible here without restating its parameter.
 */
export type UnreadableDeliveryIssues = readonly { readonly path: readonly PropertyKey[] }[];

/**
 * One stream's unreadable-delivery ledger.
 *
 * A class with private fields rather than two fields on each reading, because the
 * count and the refusal move together on every arm — a delivery that failed to parse
 * writes both — and a holder that could move one without the other is how a console
 * comes to report a partial read it can no longer explain.
 *
 * The refusal COMPOSER is a constructor parameter rather than a sentence this module
 * builds. What a person needs to read is which stream refused and what it was
 * reading, and only that stream's own family knows either.
 */
export class UnreadableDeliveryLedger {
  readonly #refusalFor: (issues: UnreadableDeliveryIssues) => ConsoleRefusal;
  #unreadableDeliveryCount = 0;
  #unreadableRefusal: ConsoleRefusal | undefined = undefined;

  public constructor(refusalFor: (issues: UnreadableDeliveryIssues) => ConsoleRefusal) {
    this.#refusalFor = refusalFor;
  }

  /** The two members a feed carries, as they stand. */
  public get reading(): UnreadableDeliveryReading {
    return {
      unreadableDeliveryCount: this.#unreadableDeliveryCount,
      unreadableRefusal: this.#unreadableRefusal,
    };
  }

  /** Record one delivery this build could not read, and what it failed on. */
  public record(issues: UnreadableDeliveryIssues): void {
    this.#unreadableDeliveryCount += 1;
    this.#unreadableRefusal = this.#refusalFor(issues);
  }

  /** Forget what is recorded, for a stream whose own reading has superseded it. */
  public clear(): void {
    this.#unreadableDeliveryCount = 0;
    this.#unreadableRefusal = undefined;
  }
}

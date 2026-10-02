// Counts the frames a stream carried that this build could not read, rather than dropping them.
//
// An unreadable delivery is a partial read, not a drop: it moves no row because the fold never
// saw it, and the reading reports the stream as live but behind. Streams that tail a registered
// union share these two fields so they do not drift into two vocabularies for one fact.
// Whether a snapshot supersedes earlier counts is each owner's call, not a flag passed in here.

import { refuse, refusedMemberPaths, type Refusal } from "@renderer/lib/refusal.js";

/** What a reading carries about the deliveries its stream could not read. */
export interface UnreadableDeliveryReading {
  /** Deliveries that parsed as no registered shape on this stream. */
  readonly unreadableDeliveryCount: number;
  /**
   * The newest unreadable delivery's parse refusal, naming the members that failed. Only the
   * newest is kept, and it carries member paths, never the payload.
   */
  readonly unreadableRefusal: Refusal | undefined;
}

/**
 * A parse's issue list, narrowed to the `path` member a refusal sentence reads.
 *
 * Matches the parameter of `refusedMemberPaths`, so a composer built on that helper fits.
 */
export type UnreadableDeliveryIssues = readonly { readonly path: readonly PropertyKey[] }[];

/** The composer one stream hands its counter: an issue list in, that stream's refusal out. */
export type UnreadableDeliveryRefusalComposer = (issues: UnreadableDeliveryIssues) => Refusal;

/** The one code every stream raises for a delivery it could not read. */
const UNREADABLE_DELIVERY_REFUSAL_CODE = "delivery-unreadable";

/**
 * One stream's unreadable-delivery count. The count and the refusal move together, so a
 * holder cannot advance one without the other; the stream owner supplies the refusal composer.
 */
export class UnreadableDeliveryCounter {
  readonly #refusalFor: UnreadableDeliveryRefusalComposer;
  #unreadableDeliveryCount = 0;
  #unreadableRefusal: Refusal | undefined = undefined;

  public constructor(refusalFor: UnreadableDeliveryRefusalComposer) {
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

/**
 * Builds a stream's unreadable-delivery refusal composer from that stream's own words. The
 * sentence names the failing member paths and never the payload, which is unvalidated and
 * unbounded.
 */
export function unreadableDeliveryRefusalComposerFor(stream: {
  /** The subsystem name every refusal this stream raises carries. */
  readonly origin: string;
  /**
   * What a person reads before the failing members: which delivery did not parse, against
   * which registered shape, and what did not change. No trailing punctuation.
   */
  readonly sentence: string;
}): UnreadableDeliveryRefusalComposer {
  return (issues) =>
    refuse(
      stream.origin,
      UNREADABLE_DELIVERY_REFUSAL_CODE,
      `${stream.sentence}: ${refusedMemberPaths(issues).join(", ")}.`,
    );
}

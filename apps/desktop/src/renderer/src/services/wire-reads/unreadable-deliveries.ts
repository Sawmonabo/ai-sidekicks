// Counts the frames a stream carried that this build could not read, rather than dropping them.
//
// An unreadable delivery is a partial read, not a drop: it moves no row because the fold never
// saw it, and the reading reports the stream as live but behind. Streams that tail a registered
// union share these two fields so they do not drift into two vocabularies for one fact.
// Whether a snapshot supersedes earlier counts is each owner's call, not a flag passed in here.
// The failing member paths go to diagnostics, never into the refusal's sentence.

import {
  recordRefusedMemberPaths,
  type RefusedMemberIssues,
} from "@renderer/lib/diagnostic-capture/refused-member-record.js";
import { refuse, type Refusal } from "@renderer/lib/refusal/refusal.js";

/** What a reading carries about the deliveries its stream could not read. */
export interface UnreadableDeliveryReading {
  /** Deliveries that parsed as no registered shape on this stream. */
  readonly unreadableDeliveryCount: number;
  /** The refusal standing for the stream's unreadable deliveries, once there has been one. */
  readonly unreadableRefusal: Refusal | undefined;
}

/** One stream's own words for a delivery it could not read. */
export interface UnreadableDeliveryStream {
  /** The subsystem name every refusal this stream raises carries. */
  readonly origin: string;
  /**
   * Which delivery did not parse, against which registered shape, and what did not change. No
   * trailing punctuation.
   */
  readonly sentence: string;
}

/** The one code every stream raises for a delivery it could not read. */
const UNREADABLE_DELIVERY_REFUSAL_CODE = "delivery-unreadable";

/**
 * One stream's unreadable-delivery count. The count and the refusal move together, so a holder
 * cannot advance one without the other.
 */
export class UnreadableDeliveryCounter {
  readonly #stream: UnreadableDeliveryStream;
  readonly #refusal: Refusal;
  #unreadableDeliveryCount = 0;
  #unreadableRefusal: Refusal | undefined = undefined;

  public constructor(stream: UnreadableDeliveryStream) {
    this.#stream = stream;
    this.#refusal = refuse(stream.origin, UNREADABLE_DELIVERY_REFUSAL_CODE, `${stream.sentence}.`);
  }

  /** The two members a feed carries, as they stand. */
  public get reading(): UnreadableDeliveryReading {
    return {
      unreadableDeliveryCount: this.#unreadableDeliveryCount,
      unreadableRefusal: this.#unreadableRefusal,
    };
  }

  /** Record one delivery this build could not read; what it failed on goes to diagnostics. */
  public record(issues: RefusedMemberIssues): void {
    this.#unreadableDeliveryCount += 1;
    this.#unreadableRefusal = this.#refusal;
    recordRefusedMemberPaths({
      source: this.#stream.origin,
      kind: UNREADABLE_DELIVERY_REFUSAL_CODE,
      subject: "delivery",
      issues,
    });
  }

  /** Forget what is recorded, for a stream whose own reading has superseded it. */
  public clear(): void {
    this.#unreadableDeliveryCount = 0;
    this.#unreadableRefusal = undefined;
  }
}

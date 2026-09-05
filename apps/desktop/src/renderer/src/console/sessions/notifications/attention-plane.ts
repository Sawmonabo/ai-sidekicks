// The attention plane: what the console may say about "what needs me".
//
// `Spec-023 §Console Design (Meridian)` §Notification center and the attention
// plane puts the whole answer in the daemon's projection: items are read, never
// counted here. So this module holds a fold and a reading vocabulary — and no
// derivation of attention at all, and no narrowing either.
//
// The narrowing, the read seam, and the session fan-out live next door in
// `attention-projection-read.ts`. This module takes items that already survived
// that boundary, which is why nothing here is typed `unknown`: by the time a value
// reaches the fold, the question "is this an attention item" has been answered.
//
// WHEN the seam is read, and what re-reads it, is `attention-read.ts` — this module
// owns the fold and holds no lifetime at all.

import type { ConsoleRefusal } from "../../core/index.js";
import { unreadableDeliveryReading, type ReadingState } from "../../primitives/index.js";
import type { AttentionItem, AttentionSeverity } from "../../bridge/index.js";
import type { RefusedAttentionSession } from "./attention-projection-read.js";

/** One session's live attention, split on the axis suppression keys on. */
export interface AttentionSessionGroup {
  readonly sessionId: string;
  readonly actionable: readonly AttentionItem[];
  readonly informational: readonly AttentionItem[];
}

/**
 * The fold over one projection read.
 *
 * An encapsulated value rather than four loose helpers: the center, the
 * all-sessions list, and the tests all ask the same three questions of one read,
 * and three functions each re-walking the array would be three chances to
 * disagree about what "live" means.
 *
 * IT COUNTS NOTHING THE DAEMON DID NOT SEND. The only arithmetic here is
 * partitioning and ordering. Severity is read off each item; the session-scoped
 * aggregate is an item the projection built, not a reduction this class performs.
 * `Spec-023 §Console Design (Meridian)`: "Never counts attention itself; severity
 * per row comes from the attention projection."
 *
 * A resolved item is dropped at construction. `resolvedAt` is the daemon's word
 * that the item has cleared, and a center that kept it would be offering a person
 * work that is already done.
 */
export class AttentionPlane {
  readonly #liveItems: readonly AttentionItem[];
  readonly #groups: readonly AttentionSessionGroup[];
  readonly #severityBySessionId: ReadonlyMap<string, AttentionSeverity>;

  public constructor(items: readonly AttentionItem[]) {
    this.#liveItems = items.filter((item) => item.resolvedAt === undefined);
    this.#groups = groupBySession(this.#liveItems);
    this.#severityBySessionId = new Map(
      this.#groups.map((group) => [
        group.sessionId,
        group.actionable.length > 0 ? "actionable" : "informational",
      ]),
    );
  }

  /** Every unresolved item, oldest first. Ordering is the projection's own. */
  public get liveItems(): readonly AttentionItem[] {
    return this.#liveItems;
  }

  /** Live items grouped by session, sessions ordered by their oldest item. */
  public get groups(): readonly AttentionSessionGroup[] {
    return this.#groups;
  }

  /** True while any session has actionable attention. Drives the density fold. */
  public get hasActionable(): boolean {
    return this.#groups.some((group) => group.actionable.length > 0);
  }

  /**
   * The severity that applies to one session, or `undefined` when the projection
   * carries nothing for it.
   *
   * `undefined` is not "clear". It is the absence a row renders as nothing at all,
   * because a row that showed an all-clear mark for a session the projection never
   * mentioned would be reporting an answer to a question nobody asked.
   */
  public severityFor(sessionId: string): AttentionSeverity | undefined {
    return this.#severityBySessionId.get(sessionId);
  }
}

function groupBySession(items: readonly AttentionItem[]): readonly AttentionSessionGroup[] {
  const bySessionId = new Map<
    string,
    { actionable: AttentionItem[]; informational: AttentionItem[] }
  >();
  for (const item of items) {
    const existing = bySessionId.get(item.sessionId) ?? { actionable: [], informational: [] };
    if (item.severity === "actionable") {
      existing.actionable.push(item);
    } else {
      existing.informational.push(item);
    }
    bySessionId.set(item.sessionId, existing);
  }
  return [...bySessionId].map(([sessionId, split]) => ({
    sessionId,
    actionable: split.actionable,
    informational: split.informational,
  }));
}

/**
 * What one projection read produced, as a value a view narrows on.
 *
 * Four phases and not two: a read in flight, a read that was never put, a read that
 * answered, and a read that FAILED. Collapsing the second into the third would let
 * the all-clear line stand for a question nobody asked, which is exactly the
 * conflation the five kinds of nothing exist to prevent — and collapsing the fourth
 * into the second would report a reader that broke as a reader that was never asked,
 * which is the same conflation from the other side.
 *
 * The `read` arm carries its own COVERAGE, because a read that answered is not the
 * same as a read that answered for everything it asked about, and one phase for
 * both would make the difference unrenderable.
 */
export type AttentionReading =
  | { readonly phase: "reading" }
  | { readonly phase: "not-asked" }
  | { readonly phase: "refused"; readonly refusal: ConsoleRefusal }
  | {
      readonly phase: "read";
      readonly plane: AttentionPlane;
      /** Members the boundary refused. A fact about the reader, not about attention. */
      readonly droppedCount: number;
      /** Sessions that never answered. Non-empty means the coverage is incomplete. */
      readonly refusedSessions: readonly RefusedAttentionSession[];
    };

/** The arm that answered. Named once, so the readings below take it directly. */
export type AnsweredAttentionReading = Extract<AttentionReading, { readonly phase: "read" }>;

/** What every surface and every announcement calls what this read was of. */
export const ATTENTION_SUBJECT = "what needs you";

/**
 * How complete a read that ANSWERED was, in the console's own vocabulary.
 *
 * One fact today and deliberately a set rather than one member: `droppedCount` is
 * members the boundary could not read, which is exactly `partial` — a producer that
 * counted what it could not read. The sentence for it comes from
 * `primitives/partial-read.ts` and from nowhere else, so the panel and the spoken
 * settlement cannot drift into saying different things about one number.
 *
 * `refusedSessions` is deliberately NOT folded in here. The nearest kind is a
 * refusal `beside-an-answer`, whose sentence carries no figure — and how many of the
 * sessions asked never answered is the whole of what that fact tells a person, so
 * mapping it there would trade a count for a grammar. It stays the family's own
 * sentence until the vocabulary carries a counted coverage reading.
 *
 * The other three phases map to nothing: they are rule 8's absences, which the panel
 * renders through `Nothing` and `RefusalCard` as the whole of what it has.
 */
export function answeredReadingStates(reading: AnsweredAttentionReading): readonly ReadingState[] {
  return [unreadableDeliveryReading(reading.droppedCount, undefined)];
}

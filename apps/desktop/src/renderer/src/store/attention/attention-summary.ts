// The attention plane: what the console may say about "what needs me".
//
// The whole answer lives in the daemon's projection: items are read, never counted
// here. So this module holds a fold and a reading vocabulary — and no derivation of
// attention at all, and no narrowing either.
//
// It takes items that are already typed, which is why nothing here is typed
// `unknown`. WHEN the projection is read is `attention-read.ts` — this module owns the
// fold and holds no lifetime at all.

import { compareInstants, parseInstant } from "@renderer/lib/instant.js";
import { type Refusal } from "@renderer/lib/refusal.js";
import {
  unreadableDeliveryReading,
  type ReadingState,
} from "@renderer/console/primitives/index.js";
import type { AttentionItem, AttentionSeverity } from "@ai-sidekicks/contracts";

/** One session the projection read could not cover, with the refusal it answered with. */
export interface RefusedAttentionSession {
  readonly sessionId: string;
  readonly refusal: Refusal;
}

/** One session's live attention, split on the axis suppression keys on. */
export interface AttentionSessionGroup {
  readonly sessionId: string;
  readonly actionable: readonly AttentionItem[];
  readonly informational: readonly AttentionItem[];
}

/**
 * What one projection read produced, as a value a view narrows on.
 *
 * Two phases: a read in flight and a read that answered. A read that fails is not a
 * phase; its rejection reaches whoever performs the read.
 *
 * The `read` arm carries its own COVERAGE, because a read that answered is not the
 * same as a read that answered for everything it asked about, and one phase for
 * both would make the difference unrenderable.
 */
export type AttentionReading =
  | { readonly phase: "reading" }
  | {
      readonly phase: "read";
      readonly plane: AttentionSummary;
      /** Members the boundary refused. A fact about the reader, not about attention. */
      readonly droppedCount: number;
      /** Sessions that never answered. Non-empty means the coverage is incomplete. */
      readonly refusedSessions: readonly RefusedAttentionSession[];
      /**
       * Every session this read asked about, carried through from the fan-out.
       *
       * The denominator the refusals are a numerator over, and the only member that
       * says which sessions a settled read speaks FOR. A view that renders the
       * projection needs neither; the emitter needs both, because an item from a
       * session this read has only just begun addressing is the state of the world
       * rather than something that happened.
       */
      readonly addressedSessionIds: readonly string[];
    };

/** The arm that answered. Named once, so the readings below take it directly. */
export type AnsweredAttentionReading = Extract<AttentionReading, { readonly phase: "read" }>;

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
 * The console never counts attention itself; severity per row comes from the
 * attention projection.
 *
 * A resolved item is dropped at construction. `resolvedAt` is the daemon's word
 * that the item has cleared, and a center that kept it would be offering a person
 * work that is already done.
 */
export class AttentionSummary {
  readonly #liveItems: readonly AttentionItem[];
  readonly #groups: readonly AttentionSessionGroup[];
  readonly #severityBySessionId: ReadonlyMap<string, AttentionSeverity>;

  public constructor(items: readonly AttentionItem[]) {
    this.#liveItems = oldestFirst(items.filter((item) => item.resolvedAt === undefined));
    this.#groups = groupBySession(this.#liveItems);
    this.#severityBySessionId = new Map(
      this.#groups.map((group) => [
        group.sessionId,
        group.actionable.length > 0 ? "actionable" : "informational",
      ]),
    );
  }

  /**
   * Every unresolved item, oldest first — established here, not assumed.
   *
   * `attentionProjectionRead` is registered in no code package and states no
   * ordering, so a projection answering newest-first is a frame nothing forbids.
   */
  public get liveItems(): readonly AttentionItem[] {
    return this.#liveItems;
  }

  /**
   * Live items grouped by session, sessions ordered by their oldest item.
   *
   * Derived from {@link liveItems} rather than sorted a second time: the grouping
   * keys on first appearance, and over an oldest-first list first appearance IS the
   * session's oldest item.
   */
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

/**
 * The live items in the order a person reads them: oldest first.
 *
 * Each stamp is parsed ONCE and the readings are sorted, rather than parsing inside
 * the comparator, where a list of n items costs n log n parses of the same strings.
 *
 * `compareInstants` sorts an unreadable stamp last, which is the corpus rule for one
 * everywhere else: a row whose instant no reader can parse renders an em dash and
 * sits at the end rather than claiming a position it did not earn. The sort is
 * stable, so two items the wire stamped at the same instant keep the projection's
 * own order between them.
 */
function oldestFirst(items: readonly AttentionItem[]): readonly AttentionItem[] {
  return items
    .map((item) => ({ item, createdAt: parseInstant(item.createdAt) }))
    .sort((left, right) => compareInstants(left.createdAt, right.createdAt, "oldest-first"))
    .map((stamped) => stamped.item);
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

/** What every view and every announcement calls what this read was of. */
export const ATTENTION_SUBJECT = "what needs you";

/**
 * How complete a read that ANSWERED was, in the console's own vocabulary.
 *
 * One fact today and deliberately a set rather than one member: `droppedCount` is
 * members the boundary could not read, which is exactly `partial` — a producer that
 * counted what it could not read. The sentence for it comes from
 * `primitives/reading/partial-read.ts` and from nowhere else, so the panel and the spoken
 * settlement cannot drift into saying different things about one number.
 *
 * `refusedSessions` is deliberately NOT folded in here. The nearest kind is a
 * refusal `beside-an-answer`, whose sentence carries no figure — and how many of the
 * sessions asked never answered is the whole of what that fact tells a person, so
 * mapping it there would trade a count for a grammar. It stays the attention read's own
 * sentence until the vocabulary carries a counted coverage reading.
 *
 * The phase that is still reading maps to nothing: the panel renders it through
 * `Nothing` as the whole of what it has.
 */
export function answeredReadingStates(reading: AnsweredAttentionReading): readonly ReadingState[] {
  return [unreadableDeliveryReading(reading.droppedCount, undefined)];
}

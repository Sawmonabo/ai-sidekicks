// The attention summary: what the console may say about "what needs me". The answer lives in
// the daemon's projection; this module holds a fold and a reading vocabulary, and derives no
// attention of its own. When the projection is read is `hooks/useAttentionProjection.ts`.

import { compareInstants, parseInstant } from "@renderer/lib/instant.js";
import { type Refusal } from "@renderer/lib/refusal.js";
import { unreadableDeliveryReading, type ReadingState } from "@renderer/lib/partial-read.js";
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
 * Two phases: a read in flight and a read that answered. A failed read is not a phase; its
 * rejection reaches whoever performs the read. The `read` arm carries its coverage, because a
 * read that answered is not the same as one that answered for everything it asked about.
 */
export type AttentionReading =
  | { readonly phase: "reading" }
  | {
      readonly phase: "read";
      readonly summary: AttentionSummary;
      /** Members the boundary refused. A fact about the reader, not about attention. */
      readonly droppedCount: number;
      /** Sessions that never answered. Non-empty means the coverage is incomplete. */
      readonly refusedSessions: readonly RefusedAttentionSession[];
      /**
       * Every session this read asked about, carried through from the fan-out.
       *
       * The denominator the refusals are over, and the only member that says which sessions a
       * settled read speaks for. The notifier needs it, because an item from a session this
       * read has only just begun addressing is the state of the world, not something new.
       */
      readonly addressedSessionIds: readonly string[];
    };

/** The arm that answered. */
export type AnsweredAttentionReading = Extract<AttentionReading, { readonly phase: "read" }>;

/**
 * The fold over one projection read.
 *
 * One value answers the center, the all-sessions list and the tests, so they cannot disagree
 * about what "live" means. It counts nothing the daemon did not send: the only arithmetic is
 * partitioning and ordering, and severity is read off each item. A resolved item is dropped at
 * construction, since `resolvedAt` is the daemon's word that it has cleared.
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
   * Every unresolved item, oldest first.
   *
   * The order is established here because the projection states no ordering.
   */
  public get liveItems(): readonly AttentionItem[] {
    return this.#liveItems;
  }

  /**
   * Live items grouped by session, sessions ordered by their oldest item.
   *
   * Derived from {@link liveItems}: over an oldest-first list, first appearance is the
   * session's oldest item, so no second sort is needed.
   */
  public get groups(): readonly AttentionSessionGroup[] {
    return this.#groups;
  }

  /** True while any session has actionable attention. Drives the density fold. */
  public get hasActionable(): boolean {
    return this.#groups.some((group) => group.actionable.length > 0);
  }

  /**
   * The severity that applies to one session, or `undefined` when the projection carries
   * nothing for it. `undefined` is not "clear": a row renders it as nothing at all, since an
   * all-clear mark for a session the projection never mentioned would answer a question nobody
   * asked.
   */
  public severityFor(sessionId: string): AttentionSeverity | undefined {
    return this.#severityBySessionId.get(sessionId);
  }
}

/**
 * The live items in the order a person reads them: oldest first.
 *
 * Each stamp is parsed once and the readings are sorted, rather than parsing inside the
 * comparator. `compareInstants` sorts an unreadable stamp last, and the sort is stable, so
 * items stamped at the same instant keep the projection's order.
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
 * How complete a read that answered was, in the console's own vocabulary.
 *
 * Today the only fact is `droppedCount`, which maps to `partial`; its sentence comes from
 * `lib/partial-read.ts` alone, so the panel and the spoken settlement say the same thing.
 * `refusedSessions` is not folded in, because how many sessions never answered is the whole of
 * what it tells a person and a `beside-an-answer` refusal carries no figure; it stays the
 * attention read's own sentence. The still-reading phase maps to nothing.
 */
export function answeredReadingStates(reading: AnsweredAttentionReading): readonly ReadingState[] {
  return [unreadableDeliveryReading(reading.droppedCount, undefined)];
}

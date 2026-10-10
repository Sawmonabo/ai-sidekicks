// Child runs and handoffs as structure the transcript can draw. One index serves both because the
// feed asks both questions per row. A handoff is a projection entry, never an event type; its
// `fromActor`, `toActor` and `reason` are read off the payload and rendered verbatim or as an
// absence, never inferred.

import type { ChildRunSummary } from "@ai-sidekicks/contracts/transcript/child-run-summary";
import type { SessionEventType } from "@ai-sidekicks/contracts/event/registry";
import type { TranscriptEventRow } from "@ai-sidekicks/contracts/transcript/row";

import { readWireString } from "#renderer/lib/wire/strings.js";
// The one open-payload reader; it answers the `rollback_boundary` arm's typed payload with an
// empty record.
import { projectedPayload } from "#renderer/store/session/events/wire-payload.js";
import { PublishedKeyedList } from "../window/published-keyed-list.js";
import { SubagentAnchorIndex } from "./subagent-anchors.js";

/**
 * The wire types that mean work changed hands: a child run taking a piece of it. Typed as the
 * wire union so a member the contract does not register fails to compile rather than match no
 * row.
 */
const HANDOFF_WIRE_TYPES: readonly SessionEventType[] = ["subagent.started", "subagent.completed"];

/** One row that carries a summarized child run. */
export interface ChildRunEntry {
  readonly rowId: string;
  /**
   * The latest summary this window carries for the child, whichever row carried it. The card
   * stays anchored at `rowId` while its state, size and completeness are the newest.
   */
  readonly summary: ChildRunSummary;
  /** The row's own actor, or `undefined` where the row named none. */
  readonly actorId: string | undefined;
  readonly timestamp: string;
  /**
   * The later rows that re-summarized this child run, in log order; the last is the row
   * {@link summary} came from. One card updates rather than one card per re-summary.
   */
  readonly resummarizedRowIds: readonly string[];
}

/**
 * One row that hands work from one actor to another. Every member but `rowId`, `wireType` and
 * `timestamp` is optional on the wire, and an absent one renders as an absence.
 */
export interface HandoffEntry {
  readonly rowId: string;
  /** The projected event type, verbatim, so the row can say what it was read from. */
  readonly wireType: string;
  readonly fromActor: string | undefined;
  readonly toActor: string | undefined;
  readonly reason: string | undefined;
  readonly timestamp: string;
  /**
   * The child run this handoff opened, when the row names one. A handoff that names one is threaded
   * to that run group's header (keyed by run id); one that does not draws no thread.
   */
  readonly childRunId: string | undefined;
}

/**
 * Child-run and handoff structure over one log, asked per row per frame. Rows join one at a time,
 * in log order, so a log read a stretch at a time costs each stretch its own rows and the entries
 * they move; each changed entry is a new object and the rest keep theirs.
 */
export class ChildRunIndex {
  readonly #subagentAnchors = new SubagentAnchorIndex();
  /** Every child-run entry, in the order each child's first summarized row arrived. */
  readonly #childRunEntries = new PublishedKeyedList<ChildRunEntry, ChildRunEntry>(
    (entry) => entry.rowId,
    (entry) => entry,
  );
  readonly #childRunEntryPositionByChildRunId = new Map<string, number>();
  readonly #handoffEntries = new PublishedKeyedList<HandoffEntry, HandoffEntry>(
    (entry) => entry.rowId,
    (entry) => entry,
  );

  public constructor(rows: readonly TranscriptEventRow[] = []) {
    for (const row of rows) {
      this.admit(row);
    }
  }

  /** Fold one row in, after every row admitted before it. */
  public admit(row: TranscriptEventRow): void {
    this.#subagentAnchors.admit(row);
    this.#admitChildRunSummary(row);
    this.#admitHandoff(row);
  }

  /**
   * Take `next`, a row projected again with only its child-run summary moved, in place of the row
   * of its id admitted before. The child's entry takes the summary when `next` is the newest row
   * summarizing it.
   */
  public replaceRow(next: TranscriptEventRow): void {
    const summary = next.childRunSummary;
    const position =
      summary === undefined
        ? undefined
        : this.#childRunEntryPositionByChildRunId.get(summary.runId);
    const entry = position === undefined ? undefined : this.#childRunEntries.at(position);
    if (summary !== undefined && position !== undefined && entry !== undefined) {
      const newestRowId = entry.resummarizedRowIds.at(-1) ?? entry.rowId;
      if (newestRowId === next.id && entry.summary !== summary) {
        this.#childRunEntries.set(position, { ...entry, summary });
      }
    }
    const handoffPosition = this.#handoffEntries.positionOf(next.id);
    if (handoffPosition !== undefined) {
      this.#handoffEntries.set(handoffPosition, handoffEntryOf(next));
    }
  }

  /** Every summarized child run in the window, in log order. */
  public childRunEntries(): readonly ChildRunEntry[] {
    return this.#childRunEntries.list();
  }

  /** Every handoff in the window, in log order. */
  public handoffEntries(): readonly HandoffEntry[] {
    return this.#handoffEntries.list();
  }

  /** The child-run entry behind a row, for the feed's per-row dispatch. Kept until one moves. */
  public childRunEntryByRowId(): ReadonlyMap<string, ChildRunEntry> {
    return this.#childRunEntries.map();
  }

  /** The handoff entry behind a row, for the same dispatch. Kept until one moves. */
  public handoffEntryByRowId(): ReadonlyMap<string, HandoffEntry> {
    return this.#handoffEntries.map();
  }

  // The member is on `TranscriptEventRowBase`, so this reads it without narrowing on `kind`:
  // dropping a child run on a `general` row would hide background work.
  #admitChildRunSummary(row: TranscriptEventRow): void {
    const summary = row.childRunSummary;
    if (summary === undefined) {
      return;
    }
    const position = this.#childRunEntryPositionByChildRunId.get(summary.runId);
    const held = position === undefined ? undefined : this.#childRunEntries.at(position);
    if (position !== undefined && held !== undefined) {
      // The latest observation is what the card shows, at the first row's anchor. Only the summary
      // moves; the anchor, actor and timestamp stay the first row's so the card does not travel.
      this.#childRunEntries.set(position, {
        ...held,
        summary,
        resummarizedRowIds: [...held.resummarizedRowIds, row.id],
      });
      return;
    }
    const added = this.#childRunEntries.push({
      rowId: row.id,
      summary,
      actorId: row.actor,
      timestamp: row.timestamp,
      resummarizedRowIds: [],
    });
    this.#childRunEntryPositionByChildRunId.set(summary.runId, added);
  }

  // A row qualifies on its `type` alone: one carrying handoff members under another type is not a
  // handoff, since the projection decides the set. A `subagent.started` and its
  // `subagent.completed` are one handoff observed twice; the anchor index picks the row it is
  // drawn at, and a row naming no subagent draws its own entry.
  #admitHandoff(row: TranscriptEventRow): void {
    // `some` rather than `includes`: `type` is the free-form contract string, the table is the
    // narrowed union.
    if (
      HANDOFF_WIRE_TYPES.some((wireType) => wireType === row.type) &&
      !this.#subagentAnchors.isAnchoredElsewhere(row.id)
    ) {
      this.#handoffEntries.push(handoffEntryOf(row));
    }
  }
}

/**
 * Every row carrying a child-run summary, in log order, for a caller that reads a log once. A
 * re-summarized child keeps one entry, at its first row.
 */
export function deriveChildRunEntries(
  rows: readonly TranscriptEventRow[],
): readonly ChildRunEntry[] {
  return new ChildRunIndex(rows).childRunEntries();
}

/** Every handoff in the window, in log order, for a caller that reads a log once. */
export function deriveHandoffEntries(rows: readonly TranscriptEventRow[]): readonly HandoffEntry[] {
  return new ChildRunIndex(rows).handoffEntries();
}

/** One handoff row's entry, its members read off the payload and rendered verbatim. */
function handoffEntryOf(row: TranscriptEventRow): HandoffEntry {
  const payload = projectedPayload(row);
  return {
    rowId: row.id,
    wireType: row.type,
    fromActor: readWireString(payload["fromActor"]),
    toActor: readWireString(payload["toActor"]),
    reason: readWireString(payload["reason"]),
    timestamp: row.timestamp,
    childRunId: childRunIdOf(row),
  };
}

/**
 * The child run a handoff row opened, or `undefined`. The parsed summary wins over the free-form
 * payload member. Neither falls back to the row's own `runId`, which is the parent: that would
 * thread a handoff to the run group it already sits in.
 */
function childRunIdOf(row: TranscriptEventRow): string | undefined {
  return row.childRunSummary?.runId ?? readWireString(projectedPayload(row)["childRunId"]);
}

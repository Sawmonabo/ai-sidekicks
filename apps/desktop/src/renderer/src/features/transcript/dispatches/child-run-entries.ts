// Child runs and handoffs as structure the transcript can draw. One index serves both because the
// feed asks both questions per row. A handoff is a projection entry, never an event type; its
// `fromActor`, `toActor` and `reason` are read off the payload and rendered verbatim or as an
// absence, never inferred.

import {
  type ChildRunSummary,
  type SessionEventType,
  type TimelineRow,
} from "@ai-sidekicks/contracts";

import { readWireString } from "@renderer/lib/wire-strings.js";
// The one open-payload reader; it answers the `rollback_boundary` arm's typed payload with an
// empty record.
import { projectedPayload } from "@renderer/store/session-events/wire-payload.js";
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
   * stays anchored at `rowId` while its state, size, completeness and producing node are the
   * newest.
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
 * Child-run and handoff structure over one loaded window, derived once and asked per row per
 * frame. The derivation is a pure fold that a test can drive with no DOM.
 */
export class ChildRunIndex {
  readonly #rows: readonly TimelineRow[];
  #childRunEntries: readonly ChildRunEntry[] | undefined;
  #handoffEntries: readonly HandoffEntry[] | undefined;
  #childRunEntriesByRowId: ReadonlyMap<string, ChildRunEntry> | undefined;
  #handoffEntriesByRowId: ReadonlyMap<string, HandoffEntry> | undefined;

  public constructor(rows: readonly TimelineRow[]) {
    this.#rows = rows;
  }

  /** Every summarized child run in the window, in log order. */
  public childRunEntries(): readonly ChildRunEntry[] {
    this.#childRunEntries ??= deriveChildRunEntries(this.#rows);
    return this.#childRunEntries;
  }

  /** Every handoff in the window, in log order. */
  public handoffEntries(): readonly HandoffEntry[] {
    this.#handoffEntries ??= deriveHandoffEntries(this.#rows);
    return this.#handoffEntries;
  }

  /** The child-run entry behind a row, for the feed's per-row dispatch. */
  public childRunEntryByRowId(): ReadonlyMap<string, ChildRunEntry> {
    this.#childRunEntriesByRowId ??= new Map(
      this.childRunEntries().map((entry) => [entry.rowId, entry]),
    );
    return this.#childRunEntriesByRowId;
  }

  /** The handoff entry behind a row, for the same dispatch. */
  public handoffEntryByRowId(): ReadonlyMap<string, HandoffEntry> {
    this.#handoffEntriesByRowId ??= new Map(
      this.handoffEntries().map((entry) => [entry.rowId, entry]),
    );
    return this.#handoffEntriesByRowId;
  }
}

/**
 * Every row carrying a child-run summary, in log order. The member is on `TimelineRowBase`, so
 * this reads it without narrowing on `kind`: dropping a child run on a `general` row would hide
 * background work.
 */
export function deriveChildRunEntries(rows: readonly TimelineRow[]): readonly ChildRunEntry[] {
  const entriesByChildRunId = new Map<string, ChildRunEntryUnderConstruction>();
  const entries: ChildRunEntryUnderConstruction[] = [];
  for (const row of rows) {
    if (row.childRunSummary === undefined) {
      continue;
    }
    const held = entriesByChildRunId.get(row.childRunSummary.runId);
    if (held !== undefined) {
      held.resummarizedRowIds.push(row.id);
      // The latest observation is what the card shows, at the first row's anchor. Only the summary
      // moves; the anchor, actor and timestamp stay the first row's so the card does not travel.
      held.summary = row.childRunSummary;
      continue;
    }
    const entry: ChildRunEntryUnderConstruction = {
      rowId: row.id,
      summary: row.childRunSummary,
      actorId: row.actor,
      timestamp: row.timestamp,
      resummarizedRowIds: [],
    };
    entriesByChildRunId.set(row.childRunSummary.runId, entry);
    entries.push(entry);
  }
  return entries;
}

/**
 * Every handoff in the window, in log order. A row qualifies on its `type` alone: one carrying
 * handoff members under another type is not a handoff, since the projection decides the set.
 */
export function deriveHandoffEntries(rows: readonly TimelineRow[]): readonly HandoffEntry[] {
  const anchors = new SubagentAnchorIndex(rows);
  const entries: HandoffEntry[] = [];
  for (const row of rows) {
    // `some` rather than `includes`: `type` is the free-form contract string, the table is the
    // narrowed union.
    if (!HANDOFF_WIRE_TYPES.some((wireType) => wireType === row.type)) {
      continue;
    }
    // A `subagent.started` and its `subagent.completed` are one handoff observed twice; the anchor
    // index picks the row it is drawn at. A row naming no subagent draws its own entry.
    if (!anchors.isAnchoredElsewhere(row.id)) {
      const payload = projectedPayload(row);
      entries.push({
        rowId: row.id,
        wireType: row.type,
        fromActor: readWireString(payload["fromActor"]),
        toActor: readWireString(payload["toActor"]),
        reason: readWireString(payload["reason"]),
        timestamp: row.timestamp,
        childRunId: childRunIdOf(row),
      });
    }
  }
  return entries;
}

/**
 * One entry while the fold runs: `summary` is writable here and readonly on {@link ChildRunEntry},
 * so only the fold moves it.
 */
interface ChildRunEntryUnderConstruction {
  readonly rowId: string;
  summary: ChildRunSummary;
  readonly actorId: string | undefined;
  readonly timestamp: string;
  readonly resummarizedRowIds: string[];
}

/**
 * The child run a handoff row opened, or `undefined`. The parsed summary wins over the free-form
 * payload member. Neither falls back to the row's own `runId`, which is the parent: that would
 * thread a handoff to the run group it already sits in.
 */
function childRunIdOf(row: TimelineRow): string | undefined {
  return row.childRunSummary?.runId ?? readWireString(projectedPayload(row)["childRunId"]);
}

// Child runs and handoffs, as structure the ledger can draw.
//
// WHAT WAS MISSING. A row carries `childRunSummary` and nothing rendered it: the
// chapter header raised an incompleteness marker over a whole chapter and the child
// run itself — its state, how much it holds, and which node produced it — reached no
// row at all. A handoff was worse off still: work changing hands read as an ordinary
// receipt in the log beside every other row.
//
// TWO ENTRY KINDS, ONE INDEX, because they are asked the same way at the same moment:
// the feed's row renderer holds one window and asks, per row, "is this row one of the
// ledger's own treatments". Two indexes would be two passes over one window for two
// lookups that are always both performed.
//
// A HANDOFF IS A PROJECTION ENTRY AND NEVER AN EVENT TYPE. `Spec-013 §Timeline Entry
// Types` names `handoff` as an entry the projection produces; no `handoff` event type
// is registered anywhere and nothing here looks for one. What the console has is the
// set of wire types that mean work changed hands, and this directory is that set's
// one home: it is the only surface that draws a handoff, so the vocabulary sits
// beside the renderer that spends it rather than in a second table somewhere else.
//
// EVERY MEMBER IS READ AS ITSELF. `fromActor`, `toActor`, `reason` and `channelId` are
// the four members `Spec-013` names on the entry; each is read off the projected
// payload through the console's one wire-string reader and rendered verbatim or
// rendered as an absence. Nothing here composes a sentence, maps an unrecognized value
// onto a phrase, or infers a `toActor` from a row's own actor — an inferred handoff
// target is a claim about who has the work, made by the renderer.

import {
  type ChildRunSummary,
  type SessionEventType,
  type TimelineRow,
} from "@ai-sidekicks/contracts";

import { readWireString } from "../../../core/index.js";
// The ledger's one open-payload reader, which answers the `rollback_boundary` arm's
// TYPED payload with an empty record rather than widening it into a bag.
import { projectedPayload } from "../../cards/wire-payload.js";
import { SubagentAnchorIndex } from "./subagent-anchoring.js";

/**
 * The wire types that mean work changed hands.
 *
 * An agent joining or leaving the session, and a child run taking a piece of it.
 * Typed as the wire union rather than as bare strings, so a member the contract does
 * not register fails to compile here instead of silently matching no row. Declared
 * here because this directory holds the console's one handoff renderer, so the
 * vocabulary and the treatment that spends it are one module — the shape
 * `apps/desktop/AGENTS.md` asks for ("two sides of one seam share a module").
 */
export const HANDOFF_WIRE_TYPES: readonly SessionEventType[] = [
  "agent.attached",
  "agent.detached",
  "subagent.started",
  "subagent.completed",
];

/** One row that carries a summarized child run. */
export interface ChildRunEntry {
  readonly rowId: string;
  /**
   * The LATEST summary this window carries for the child, whichever row carried it.
   *
   * The anchor above and this are different questions: where the card is drawn, and
   * what it says. A child summarized again after progress or termination is the same
   * child observed later, so the figures a reader sees — its state, how much it holds,
   * whether the reading is complete, and which node produced it — are the newest ones,
   * while the card itself stays where it was.
   */
  readonly summary: ChildRunSummary;
  /** The row's own actor, or `undefined` where the row named none. */
  readonly actorId: string | undefined;
  readonly timestamp: string;
  /**
   * The later rows that re-summarized this same child run, in log order.
   *
   * Carried rather than drawn: the card is anchored at the row that first named the
   * child, so a child re-summarized twenty times is one card that updates rather than
   * twenty cards down the log. The list is what makes that claim checkable, and the
   * last entry in it is the row {@link summary} came from.
   */
  readonly resummarizedRowIds: readonly string[];
}

/**
 * One row that hands work from one actor to another.
 *
 * Every member but `rowId`, `wireType` and `timestamp` is optional on the wire, and
 * each absent one is rendered as an absence rather than filled in.
 */
export interface HandoffEntry {
  readonly rowId: string;
  /** The projected event type, verbatim, so the row can say what it was read from. */
  readonly wireType: string;
  readonly fromActor: string | undefined;
  readonly toActor: string | undefined;
  readonly reason: string | undefined;
  readonly channelId: string | undefined;
  readonly timestamp: string;
  /**
   * The child run this handoff opened, when the row names one.
   *
   * What the handoff thread is drawn to: the child run's chapter header is keyed by
   * its run id, so a handoff that names one can be threaded to the chapter it
   * started and one that does not draws no thread rather than an invented one.
   */
  readonly childRunId: string | undefined;
}

/**
 * Child-run and handoff structure over one loaded window.
 *
 * A class for the reason `SupersededIndex` and `LedgerChapterIndex` are: the answers
 * are asked once per row per frame and derived once per window, and the derivation
 * is a pure fold that a test can drive with no DOM at all.
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
 * Every row carrying a child-run summary, in log order.
 *
 * The member is on `TimelineRowBase`, so it reaches all four arms and this reads it
 * without narrowing on `kind`: a child run summarized onto a `general` row is still a
 * child run, and dropping it because the row carries no run attribution would hide
 * background work — which `Spec-013` forbids in terms.
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
      // THE LATEST OBSERVATION IS WHAT THE CARD SHOWS, and the FIRST row is where it
      // shows it. The two are different questions and the fold used to answer both
      // with the first row: a child that progressed, terminated, gained a producing
      // node or lost transcript entries kept rendering the state, count, completeness
      // and provenance of the moment it was first named, with every later reading in
      // the window discarded. Only the summary moves; the anchor, its actor and its
      // timestamp stay the row's, so the card does not travel down the log.
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
 * Every handoff in the window, in log order.
 *
 * A row qualifies on its `type` alone — the projected event type, which is free-form
 * by contract and compared against the one table above. A row that carries handoff
 * members under some other type is NOT a handoff: the entry set is the projection's
 * to decide, and admitting a row on the presence of a `toActor` member would let any
 * payload become one.
 */
export function deriveHandoffEntries(rows: readonly TimelineRow[]): readonly HandoffEntry[] {
  const anchors = new SubagentAnchorIndex(rows);
  const entries: HandoffEntry[] = [];
  for (const row of rows) {
    // `some` rather than `includes`: a row's `type` is the free-form string the
    // timeline contract carries, and the vocabulary above is the narrowed wire union.
    if (!HANDOFF_WIRE_TYPES.some((wireType) => wireType === row.type)) {
      continue;
    }
    // ANCHORED, WHERE THE ROW NAMES A SUBAGENT. A `subagent.started` and the
    // `subagent.completed` that follows it are one handoff observed twice, and the
    // anchor index decides which row it is drawn at — first-wins, so a completion, a
    // resume and a compaction inside the child all leave the card where it was. A row
    // that names no subagent identity is anchored by nothing and draws its own entry.
    if (!anchors.isAnchoredElsewhere(row.id)) {
      const payload = projectedPayload(row);
      entries.push({
        rowId: row.id,
        wireType: row.type,
        fromActor: readWireString(payload["fromActor"]),
        toActor: readWireString(payload["toActor"]),
        reason: readWireString(payload["reason"]),
        channelId: readWireString(payload["channelId"]),
        timestamp: row.timestamp,
        childRunId: childRunIdOf(row),
      });
    }
  }
  return entries;
}

/**
 * One entry while the fold is still running.
 *
 * The two members a later row may still move are writable HERE and readonly on
 * {@link ChildRunEntry}, so the fold can advance them and a consumer cannot: the
 * published type is what every reader holds, and the pass that builds it is the only
 * thing that ever writes one.
 */
interface ChildRunEntryUnderConstruction {
  readonly rowId: string;
  summary: ChildRunSummary;
  readonly actorId: string | undefined;
  readonly timestamp: string;
  readonly resummarizedRowIds: string[];
}

/**
 * The child run a handoff row opened, or `undefined`.
 *
 * The summary is consulted FIRST because it is a parsed contract shape and the
 * payload member is a free-form read: where a row carries both, the one the schema
 * validated wins. Neither is invented from the row's own `runId`, which on these rows
 * is the PARENT — threading a handoff to its own parent chapter would draw a line
 * from a row to the chapter it already sits in.
 */
function childRunIdOf(row: TimelineRow): string | undefined {
  return row.childRunSummary?.runId ?? readWireString(projectedPayload(row)["childRunId"]);
}

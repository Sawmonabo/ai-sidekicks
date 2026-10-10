// One loaded transcript window, derived from a session's log on every store revision. The
// virtualizer's rows are identity only (`key`, `parentKey`, `rootCursor`); `rowsByKey` joins a key
// to its projected row. The window is unfurled (every member of every run group) because the fold
// in `feed/run-group-fold.ts` runs after it, and Find counts a folded group's rows.
//
// A log the store grew at its end is derived a stretch at a time: the appended events are projected
// and joined to every index, and only what they touched is published anew. Anything else the store
// does to its log (a rollback marking held rows, a page read before the head, a release, a fresh
// read) derives the window again from the whole log. The run groups' headers read the store's run
// entities, so new run facts over the same log seal again only the groups whose header they move.

import type { TranscriptEventRow } from "@ai-sidekicks/contracts/transcript/row";

import { type ProjectedSessionEvent } from "#renderer/store/session/entities/vocabulary.js";
import {
  ChildRunIndex,
  type ChildRunEntry,
  type HandoffEntry,
} from "../dispatches/child-run-entries.js";
import { TranscriptRowProjector } from "../projection/rows.js";
import { RunGroupIndex, type RunEntitiesByRunId, type RunGroup } from "../runs/groups.js";
import {
  SystemMessageClassifier,
  type SystemMessageReading,
} from "../system-messages/classifier.js";
import { type ViewportRow } from "../viewport/snapshot.js";
import { PublishedKeyedList } from "./published-keyed-list.js";
import { ReplyIndex } from "./reply-rows.js";
import { appendedStretchOf } from "./row-positions.js";
import { hasSameMembers } from "./row-retention.js";

/**
 * What one pipeline stage admitted and the rows it removed. The stage reports its own removals
 * because it already has them; deriving them downstream costs two whole-projection passes per
 * stage on every append while a query is in the find field.
 */
export interface TranscriptPipelineStage {
  readonly window: TranscriptWindowModel;
  /** The rows this stage took out of the window it was handed, in log order. */
  readonly removedRows: readonly TranscriptEventRow[];
}

/**
 * The removal a pass-through stage reports. One shared array: a consumer keys a memo on its
 * identity, and a fresh `[]` per pass would re-run that memo on every append.
 */
export const NO_ROWS_REMOVED: readonly TranscriptEventRow[] = [];

/**
 * Everything one render of the transcript needs, derived once per store revision. A member that
 * did not change keeps its identity, and so does every row and identity object that did not.
 */
export interface TranscriptWindowModel {
  /** The virtualizer's identity list; the viewport keys its reconcile on it. */
  readonly viewportRows: readonly ViewportRow[];
  readonly rowsByKey: ReadonlyMap<string, TranscriptEventRow>;
  /** Which rows a rollback boundary later in the log supersedes. */
  readonly supersededRowIds: ReadonlySet<string>;
  /**
   * The run group behind each header row, keyed by the group's own key, which the header row is.
   * Every run group has an entry, live or ended, folded or open.
   */
  readonly runGroupByHeaderKey: ReadonlyMap<string, RunGroup>;
  /** The key of the run group each member row belongs to, by row id; other rows have no entry. */
  readonly runGroupKeyByRowId: ReadonlyMap<string, string>;
  /**
   * The system message behind each row that is one, consulted by the feed's row renderer before
   * the registered one. Only this map carries the classification; a second copy would go stale.
   */
  readonly systemMessageByRowId: ReadonlyMap<string, SystemMessageReading>;
  /**
   * The child-run summary behind each row that carries one. A re-summarized child has one entry,
   * at the row that first named it, carrying the latest summary.
   */
  readonly childRunEntryByRowId: ReadonlyMap<string, ChildRunEntry>;
  /** The handoff behind each row that is one, on the same dispatch. */
  readonly handoffEntryByRowId: ReadonlyMap<string, HandoffEntry>;
  /**
   * Each reply's rows, in log order, under the row that carries the reply's foot and its Copy of
   * the whole reply. Each list keeps its identity while the reply does not move.
   */
  readonly replyRowIdsByFootRowId: ReadonlyMap<string, readonly string[]>;
  /** The rows in log order, for find and the run group fold. */
  readonly rows: readonly TranscriptEventRow[];
  /** The runs the log names that have not ended, by run id: the log is busy while one stands. */
  readonly liveRunIds: ReadonlySet<string>;
}

/**
 * The window over one session's log, kept across the store's revisions. Each `derive` answers the
 * window of the log it is handed with the store's run entities; a log that only grew at its end
 * costs its new events and the rows and run groups they touched, new run entities over the same
 * log cost the groups whose header they move, and any other log is derived whole.
 */
export class TranscriptWindowDerivation {
  #transcript: readonly ProjectedSessionEvent[] = [];
  #runEntities: RunEntitiesByRunId | undefined;
  /** The row each held event was last published as, kept across whole derivations. */
  readonly #rowByEvent = new WeakMap<ProjectedSessionEvent, TranscriptEventRow>();
  /** The last window published, and the indexes it was published from. */
  #held: { model: TranscriptWindowModel; readonly accumulation: WindowAccumulation } | undefined;

  /**
   * The window of `transcript`, which may be any log: grown, rewritten or another altogether, its
   * run groups reading `runEntities`, the store's run entities.
   */
  public derive(
    transcript: readonly ProjectedSessionEvent[],
    runEntities: RunEntitiesByRunId,
  ): TranscriptWindowModel {
    const held = this.#held;
    const isSameRunEntities = runEntities === this.#runEntities;
    this.#runEntities = runEntities;
    const appended =
      held === undefined
        ? undefined
        : transcript === this.#transcript
          ? []
          : appendedStretchOf(this.#transcript, transcript);
    this.#transcript = transcript;
    if (held === undefined || appended === undefined) {
      const accumulation = new WindowAccumulation(this.#rowByEvent, runEntities);
      this.#held = { model: accumulation.admitWholeLog(transcript, held?.model), accumulation };
      return this.#held.model;
    }
    if (appended.length > 0) {
      held.model = held.accumulation.admitStretch(appended, runEntities, held.model);
    } else if (!isSameRunEntities) {
      held.model = held.accumulation.admitRunEntities(runEntities, held.model);
    }
    return held.model;
  }
}

/** Derive the whole window from one log and its run entities, for a caller that derives once. */
export function deriveTranscriptWindow(
  transcript: readonly ProjectedSessionEvent[],
  runEntities: RunEntitiesByRunId,
): TranscriptWindowModel {
  return new TranscriptWindowDerivation().derive(transcript, runEntities);
}

/**
 * Every index one log's window is published from, grown a stretch at a time. One accumulation
 * serves a log until the store does anything but append to it.
 */
class WindowAccumulation {
  readonly #projector: TranscriptRowProjector;
  readonly #rows = new PublishedKeyedList<TranscriptEventRow, TranscriptEventRow>(
    (row) => row.id,
    (row) => row,
  );
  /** The identity list under construction, or `undefined` while the published one stands. */
  #viewportRows: ViewportRow[] | undefined;
  readonly #runGroupIndex: RunGroupIndex;
  readonly #runGroups = new PublishedKeyedList<RunGroup, RunGroup>(
    (runGroup) => runGroup.key,
    (runGroup) => runGroup,
  );
  // One classifier reads the whole log; its readings reach the model only as the map below, so a
  // narrowing and the feed share one classification.
  readonly #classifier = new SystemMessageClassifier();
  readonly #systemMessages = new PublishedKeyedList<SystemMessageReading, SystemMessageReading>(
    (systemMessage) => systemMessage.rowId,
    (systemMessage) => systemMessage,
  );
  readonly #childRunIndex = new ChildRunIndex();
  readonly #replyIndex = new ReplyIndex();
  #supersededRowIds: ReadonlySet<string> = new Set<string>();
  /** The superseded set this stretch is adding to, copied from the published one on first need. */
  #growingSupersededRowIds: Set<string> | undefined;

  /**
   * `rowByEvent` holds the row each event was last published as, across accumulations;
   * `runEntities` are the store's run entities the run groups first read.
   */
  public constructor(
    rowByEvent: WeakMap<ProjectedSessionEvent, TranscriptEventRow>,
    runEntities: RunEntitiesByRunId,
  ) {
    this.#projector = new TranscriptRowProjector(rowByEvent);
    this.#runGroupIndex = new RunGroupIndex(runEntities);
  }

  /**
   * The window of a whole log. A held event's row keeps its object; a row read anew that is equal
   * member for member to the one `previous` published under its key keeps that object, and so does
   * an unchanged identity, so the memos under the feed redraw only what moved.
   */
  public admitWholeLog(
    transcript: readonly ProjectedSessionEvent[],
    previous: TranscriptWindowModel | undefined,
  ): TranscriptWindowModel {
    const previousIdentityByKey = new Map(
      (previous?.viewportRows ?? []).map((identity) => [identity.key, identity]),
    );
    const admittedRows: TranscriptEventRow[] = [];
    // Retained before any index reads a row, so every index, the feed and every memo under it see
    // the object actually published.
    const retain = (row: TranscriptEventRow): TranscriptEventRow => {
      const previousRow = previous?.rowsByKey.get(row.id);
      return previousRow !== undefined && hasSameMembers(previousRow, row) ? previousRow : row;
    };
    for (const row of this.#projector.project(transcript, retain).rows) {
      this.#admitRow(row);
      admittedRows.push(row);
    }
    if (previous !== undefined) {
      // A stretch keeps its key, and a person's fold of it, across a page landing before it or a
      // release of its first row; identities are built after, so they hang from the kept key.
      this.#runGroupIndex.adoptKeys(previous.runGroupKeyByRowId);
      this.#replyIndex.retainRowLists(previous.replyRowIdsByFootRowId);
    }
    const runGroupKeyByRowId = this.#runGroupIndex.runGroupKeyByRowId();
    this.#viewportRows = admittedRows.map((row) =>
      identityOf(row, runGroupKeyByRowId.get(row.id), previousIdentityByKey.get(row.id)),
    );
    return this.#publish(undefined);
  }

  /**
   * The window after `events` joined the end of the log `previous` was published from, its run
   * groups reading `runEntities`.
   */
  public admitStretch(
    events: readonly ProjectedSessionEvent[],
    runEntities: RunEntitiesByRunId,
    previous: TranscriptWindowModel,
  ): TranscriptWindowModel {
    // Read first, so a run the stretch first names takes its facts as they stand now.
    this.#runGroupIndex.admitRunEntities(runEntities);
    const batch = this.#projector.project(events);
    // A child run the stretch moved restamps its creation row, which an earlier stretch projected.
    for (const eventId of batch.movedSummaryEventIds) {
      const position = this.#rows.positionOf(eventId);
      const heldRow = position === undefined ? undefined : this.#rows.at(position);
      const restamped =
        heldRow === undefined ? undefined : this.#projector.withCurrentSummary(heldRow);
      if (position !== undefined && heldRow !== undefined && restamped !== undefined) {
        this.#rows.set(position, restamped);
        this.#childRunIndex.replaceRow(restamped);
      }
    }
    for (const row of batch.rows) {
      this.#viewportRows ??= [...previous.viewportRows];
      this.#viewportRows.push(identityOf(row, this.#admitRow(row), undefined));
    }
    return this.#publish(previous);
  }

  /**
   * The window `previous` was published as, its run groups reading `runEntities`: `previous`
   * itself when no header and no run's ending moved.
   */
  public admitRunEntities(
    runEntities: RunEntitiesByRunId,
    previous: TranscriptWindowModel,
  ): TranscriptWindowModel {
    return this.#runGroupIndex.admitRunEntities(runEntities) ? this.#publish(previous) : previous;
  }

  /** Join `row` to every index, answering the key of the run group it joined, if any. */
  #admitRow(row: TranscriptEventRow): string | undefined {
    const systemMessage = this.#classifier.classify(row);
    // The group is decided here, before anything is drawn, so every stage and the window cap read
    // one membership.
    const parentKey = this.#runGroupIndex.admit(row, systemMessage !== undefined);
    this.#rows.push(row);
    if (systemMessage !== undefined) {
      this.#systemMessages.push(systemMessage);
    }
    this.#childRunIndex.admit(row);
    this.#replyIndex.admit(row);
    if (row.kind !== "general" && row.superseded !== undefined) {
      this.#growingSupersededRowIds ??= new Set(this.#supersededRowIds);
      this.#growingSupersededRowIds.add(row.id);
    }
    return parentKey;
  }

  #publish(previous: TranscriptWindowModel | undefined): TranscriptWindowModel {
    for (const runGroup of this.#runGroupIndex.sealTouched()) {
      const position = this.#runGroups.positionOf(runGroup.key);
      if (position === undefined) {
        this.#runGroups.push(runGroup);
      } else {
        this.#runGroups.set(position, runGroup);
      }
    }
    const viewportRows = this.#viewportRows ?? previous?.viewportRows ?? [];
    this.#viewportRows = undefined;
    this.#supersededRowIds = this.#growingSupersededRowIds ?? this.#supersededRowIds;
    this.#growingSupersededRowIds = undefined;
    return {
      viewportRows,
      rowsByKey: this.#rows.map(),
      supersededRowIds: this.#supersededRowIds,
      runGroupByHeaderKey: this.#runGroups.map(),
      runGroupKeyByRowId: this.#runGroupIndex.runGroupKeyByRowId(),
      systemMessageByRowId: this.#systemMessages.map(),
      childRunEntryByRowId: this.#childRunIndex.childRunEntryByRowId(),
      handoffEntryByRowId: this.#childRunIndex.handoffEntryByRowId(),
      replyRowIdsByFootRowId: this.#replyIndex.replyRowIdsByFootRowId(),
      rows: this.#rows.list(),
      liveRunIds: this.#runGroupIndex.liveRunIds(),
    };
  }
}

/**
 * A row's viewport identity: the one `previousIdentity` names when it says the same, else a new
 * one. Each row is its own cut unit, the finest the window cap can act on: a cursor shared across a
 * page would make the cap all-or-nothing over every row the page delivered.
 */
function identityOf(
  row: TranscriptEventRow,
  parentKey: string | undefined,
  previousIdentity: ViewportRow | undefined,
): ViewportRow {
  return previousIdentity !== undefined &&
    previousIdentity.parentKey === parentKey &&
    previousIdentity.rootCursor === row.id
    ? previousIdentity
    : { key: row.id, parentKey, rootCursor: row.id };
}

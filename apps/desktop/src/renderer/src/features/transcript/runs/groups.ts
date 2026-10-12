// Run groups: one unbroken stretch of a run's rows under one header. A row joins a run by its
// carried `runId` only (a `general` row has none), and a run's stretch ends where a row from
// outside it is drawn between two of its cards: a person's message, another agent's reply or call,
// or a session row with a card. The run goes on under a new header at its next card. A
// notification (a system message) never ends a stretch: it joins the stretch it lands in when that
// stretch is its run's, and otherwise stands on its own. Rows keep the log's order inside a group,
// and groups keep the order their first card arrived in, the order their headers stand in. A group
// with no card draws nothing, so it is published only once its first card arrives, and its header
// stands above that card. Whether a person folded a group is `feed/fold-state.ts`'s, never this
// module's. This module renders nothing; `RunGroupHeader.tsx` draws the model.
//
// What a header says of its run (who acts for it, the account it is billed to, its state) and
// whether the run has ended are the run's facts from the session store, which the daemon folded
// over the whole log, never the window's rows: a run whose naming row lies outside the window
// reads the same as one whose rows are all held. A long stretch whose window the store let go
// past keeps counting the drawn rows it let go, carried from one derivation of the log to the
// next until they are read back.

import type { TranscriptEventRow } from "@ai-sidekicks/contracts/transcript/row";
import {
  isTranscriptRunEnded,
  transcriptRunHeaderStateOf,
  type TranscriptRunFactsFold,
} from "@ai-sidekicks/contracts/transcript/run-facts";

import type { StoredEntity } from "#renderer/store/session/entities/vocabulary.js";
import { classifyTranscriptRow } from "../rows/kind.js";
import { SystemMessageClassifier } from "../system-messages/classifier.js";
import { PublishedKeyedList } from "../window/published-keyed-list.js";

/** The session store's run entities by run id, whose facts each run group reads. */
export type RunEntitiesByRunId = Readonly<Record<string, StoredEntity>>;

/**
 * The drawn rows of a stretch the store let go past one end of the rows it holds, and have not
 * been read back.
 */
export interface ReleasedRunEntries {
  /** How many drawn rows went there. */
  readonly count: number;
  /** The lowest sequence they were let go from, so a row read back among them counts back. */
  readonly fromSequence: number;
  /** The highest sequence they were let go from. */
  readonly toSequence: number;
  /** The outermost event let go: the stretch's first at its earlier end, its last at the later. */
  readonly outermostEvent: Pick<TranscriptEventRow, "sequence" | "cursor">;
}

/**
 * The window derived before a whole derivation, which carries what its stretches let go and where
 * its notifications sat.
 */
export interface PreviousRunGroups {
  readonly runGroupByHeaderKey: ReadonlyMap<string, RunGroup>;
  readonly runGroupKeyByRowId: ReadonlyMap<string, string>;
  readonly rowsByKey: ReadonlyMap<string, TranscriptEventRow>;
}

/** One stretch of one run's rows, folded. */
export interface RunGroup {
  /**
   * The group's own key, which its header row is keyed by and every member row's identity hangs
   * from: minted from its run and the row its stretch began at, and kept while the stretch grows,
   * when a page lands before it, and when its first row is let go. No two groups share one.
   */
  readonly key: string;
  /** The run this group is a stretch of, wire-verbatim. */
  readonly runId: string;
  /**
   * The row the header stands above: the stretch's first card, its first drawn row; with rows let
   * go before it, its first drawn row the log holds.
   */
  readonly headerRowId: string;
  /** The group's row ids in arrival order, cached so the header and body read one array. */
  readonly rowIds: readonly string[];
  readonly rowCount: number;
  /**
   * Where in `rowIds` the rows that draw something stand, in order: the entries its header
   * counts and the calls a long run's window is cut in.
   */
  readonly drawnRowPositions: readonly number[];
  /** Who acts for the run, wire-verbatim, or `undefined` where no event of it names anyone. */
  readonly actorId: string | undefined;
  /**
   * The newest run state the log reported for the run, wire-verbatim, on its newest group only:
   * an earlier stretch's header no longer says what the run is doing. `undefined` there, where the
   * run has no state, and after a rewind.
   */
  readonly runStateEventType: string | undefined;
  /** The provider account the run was admitted under, wire-verbatim, or `undefined` for none. */
  readonly payingAccountId: string | undefined;
  /** The drawn rows let go before the first row the log holds, or `undefined` for none. */
  readonly releasedEarlier: ReleasedRunEntries | undefined;
  /** The drawn rows let go after the last row the log holds, or `undefined` for none. */
  readonly releasedLater: ReleasedRunEntries | undefined;
}

/**
 * The run group fold over one log, kept across the log's appended stretches: a row joins its
 * group as it arrives, and only the groups a stretch touched are sealed again, so an appended row
 * costs its own group. A group's key is minted from the row it began at, or adopted from the window
 * derived before, and never changes after it is published; no two groups hold the same key.
 */
export class RunGroupIndex {
  readonly #runsByRunId = new Map<string, RunAccumulator>();
  /** Every group, in the order its first row arrived. */
  readonly #groups: GroupAccumulator[] = [];
  /** The groups with a card, in the order each one's first card arrived. */
  readonly #drawnGroups: GroupAccumulator[] = [];
  /** The groups to seal again, in the order a stage publishes them: a group's first card last. */
  readonly #touchedGroups = new Set<GroupAccumulator>();
  /** Every group's key, so a minted key never repeats one a group already holds. */
  readonly #keys = new Set<string>();
  readonly #memberships = new PublishedKeyedList<Membership, string>(
    (membership) => membership.rowId,
    (membership) => membership.group.key,
  );
  /** How many rows with a card the log has admitted, a clock for when a stretch was broken. */
  #cardCount = 0;
  /** The group the newest card joined, or `undefined` when that card stood outside every group. */
  #lastCardGroup: GroupAccumulator | undefined;
  readonly #liveRunIds = new Set<string>();
  #publishedLiveRunIds: ReadonlySet<string> | undefined;
  /** The window derived before this log, whose stretches a notification may stay in. */
  #previous: PreviousRunGroups | undefined;
  /** The group of this log that took the first row of each earlier stretch, by its earlier key. */
  readonly #groupByPreviousKey = new Map<string, GroupAccumulator>();
  #runEntities: RunEntitiesByRunId;

  /** `runEntities` are the session store's run entities, whose facts each run's groups read. */
  public constructor(runEntities: RunEntitiesByRunId) {
    this.#runEntities = runEntities;
  }

  /**
   * Fold one row in, in log order, and answer the key of the group it joined, or `undefined` for
   * a row that stands outside every group. `isNotification` is whether the row is a system message.
   */
  public admit(row: TranscriptEventRow, isNotification: boolean): string | undefined {
    const rowKind = classifyTranscriptRow(row)?.kind;
    if (rowKind === "user-message") {
      // A person's message is never a run's own row, even one stamped with the run it steers.
      this.#countOutsideCard();
      return undefined;
    }
    const run = row.kind === "general" ? undefined : this.#runOf(row.runId);
    if (isNotification) {
      const group = this.#notificationGroupOf(row);
      if (group === undefined || (run !== undefined && group.run !== run)) {
        return undefined;
      }
      // A notification draws, but it is no card: it neither breaks nor opens a stretch.
      this.#join(group, row, false, true);
      return group.key;
    }
    const hasCard = rowKind !== undefined;
    if (run === undefined) {
      if (hasCard) {
        this.#countOutsideCard();
      }
      return undefined;
    }
    let group = run.newestGroup;
    if (group === undefined || (hasCard && this.#isBroken(group))) {
      group = this.#openGroup(run, row);
    }
    this.#join(group, row, hasCard, hasCard);
    return group.key;
  }

  /**
   * Read the window derived before this one while a whole log is admitted, so a notification whose
   * card the store let go stays in the stretch that card put it in, as the whole log has it.
   * Called before the log's first row.
   */
  public followPrevious(previous: PreviousRunGroups): void {
    this.#previous = previous;
  }

  /**
   * Give each group the key its rows held in the window derived before this one, so a stretch,
   * and a person's fold of it, keeps its key when a page lands before it or its first row is let
   * go. Each group, in log order, takes the earlier key of its first card whose key is still free,
   * so where two stretches merged the earlier keeps its key. Only then does a group with no card
   * take the earlier key of any of its rows: a row that draws nothing joins its run's newest
   * stretch, which may not be the stretch it sat in before. Every other group is minted afresh.
   * Called once a whole log is admitted, before any publish.
   */
  public adoptKeys(previousKeyByRowId: ReadonlyMap<string, string>): void {
    const adoptedKeyByGroup = new Map<GroupAccumulator, string>();
    const adoptThrough = (group: GroupAccumulator, rowIds: readonly string[]): void => {
      for (const rowId of rowIds) {
        const previousKey = previousKeyByRowId.get(rowId);
        if (previousKey !== undefined && !this.#keys.has(previousKey)) {
          this.#keys.add(previousKey);
          adoptedKeyByGroup.set(group, previousKey);
          return;
        }
      }
    };
    this.#keys.clear();
    for (const group of this.#groups) {
      adoptThrough(group, group.cardRowIds);
    }
    for (const group of this.#groups) {
      if (group.cardRowIds.length === 0) {
        adoptThrough(group, group.rowIds);
      }
    }
    for (const group of this.#groups) {
      group.key = adoptedKeyByGroup.get(group) ?? this.#mintKey(group.run.runId, group.firstRowId);
    }
  }

  /**
   * Carry the drawn rows each stretch let go across a whole derivation, after `adoptKeys`. A group
   * carries the counts of the group `previous` held under its key: a drawn row read back is
   * counted back, and a drawn row of that group this log lacks is counted as let go before or
   * after the rows the group holds. A row is let go when the log still holds rows of `previous` on
   * both sides of it, or on its one side where it lay past an end: the store let go of history it
   * can read again. A row this log lacks any other way went with a read that replaced the window,
   * so the group counts its own rows alone. A group with rows let go before it stands its header
   * at its first drawn row, as the whole log has the rows it holds under the header. `rows` are
   * this log's rows in order, and `rowOf` reads one by id.
   */
  public carryReleasedRows(
    previous: PreviousRunGroups,
    rows: readonly TranscriptEventRow[],
    rowOf: (rowId: string) => TranscriptEventRow | undefined,
  ): void {
    const isLetGo = letGoReaderOf(rows, previous.rowsByKey);
    for (const group of this.#groups) {
      const carried = previous.runGroupByHeaderKey.get(group.key);
      const firstSequence = rowOf(group.firstRowId)?.sequence;
      if (carried === undefined || firstSequence === undefined) {
        continue;
      }
      let earlier = carried.releasedEarlier;
      let later = carried.releasedLater;
      // A drawn row read back since `previous` is counted back from the end it was let go at.
      for (const position of group.drawnRowPositions) {
        const rowId = group.rowIds[position]!;
        const sequence = rowOf(rowId)?.sequence;
        if (sequence === undefined || previous.rowsByKey.has(rowId)) {
          continue;
        }
        if (isAmong(earlier, sequence)) {
          earlier = { ...earlier, count: earlier.count - 1 };
        } else if (isAmong(later, sequence)) {
          later = { ...later, count: later.count - 1 };
        }
      }
      let isReplaced = false;
      for (const position of carried.drawnRowPositions) {
        const rowId = carried.rowIds[position]!;
        const row = previous.rowsByKey.get(rowId);
        if (row === undefined || rowOf(rowId) !== undefined) {
          continue;
        }
        if (!isLetGo(row.sequence)) {
          isReplaced = true;
        } else if (row.sequence < firstSequence) {
          earlier = withReleasedRow(earlier, row, "earlier");
        } else {
          later = withReleasedRow(later, row, "later");
        }
      }
      group.releasedEarlier =
        !isReplaced && earlier !== undefined && earlier.count > 0 ? earlier : undefined;
      group.releasedLater =
        !isReplaced && later !== undefined && later.count > 0 ? later : undefined;
      const firstDrawnPosition = group.drawnRowPositions[0];
      if (
        group.releasedEarlier !== undefined &&
        group.headerRowId !== undefined &&
        firstDrawnPosition !== undefined
      ) {
        group.headerRowId = group.rowIds[firstDrawnPosition];
      }
      this.#touchedGroups.add(group);
    }
  }

  /**
   * Read each run's facts from `runEntities`, the store's newer run entities, sealing again the
   * groups whose header they changed and moving a run that started or ended; answers whether
   * either moved. A run whose facts keep their object costs nothing.
   */
  public admitRunEntities(runEntities: RunEntitiesByRunId): boolean {
    if (runEntities === this.#runEntities) {
      return false;
    }
    this.#runEntities = runEntities;
    const publishedLiveRunIds = this.liveRunIds();
    for (const run of this.#runsByRunId.values()) {
      this.#takeFacts(run, runEntities[run.runId]?.runFacts);
    }
    return this.#touchedGroups.size > 0 || this.liveRunIds() !== publishedLiveRunIds;
  }

  /** The groups with a card a row joined or changed in since the last call, each sealed afresh. */
  public sealTouched(): readonly RunGroup[] {
    const sealed = [...this.#touchedGroups].flatMap(sealDrawnRunGroup);
    this.#touchedGroups.clear();
    return sealed;
  }

  /** Every group with a card, sealed now, in the order each one's first card arrived. */
  public runGroups(): readonly RunGroup[] {
    return this.#drawnGroups.flatMap(sealDrawnRunGroup);
  }

  /** The key of the group each member row joined, by row id; a row of no group has no entry. */
  public runGroupKeyByRowId(): ReadonlyMap<string, string> {
    return this.#memberships.map();
  }

  /**
   * The runs the log has not seen end, by run id. The same set object until a run starts or ends,
   * so a consumer can key a memo on it.
   */
  public liveRunIds(): ReadonlySet<string> {
    this.#publishedLiveRunIds ??= new Set(this.#liveRunIds);
    return this.#publishedLiveRunIds;
  }

  #runOf(runId: string): RunAccumulator {
    let run = this.#runsByRunId.get(runId);
    if (run === undefined) {
      const facts = this.#runEntities[runId]?.runFacts;
      run = { runId, groups: [], newestGroup: undefined, facts };
      this.#runsByRunId.set(runId, run);
      this.#setLive(runId, !isRunEnded(facts));
    }
    return run;
  }

  // Whether a card from outside the group was drawn after the group's newest card. A group with no
  // card yet has no calls for anything to land between.
  #isBroken(group: GroupAccumulator): boolean {
    return group.lastCardCount !== undefined && group.lastCardCount < this.#cardCount;
  }

  // A stretch's key is its run and first row; where a group already holds that key, the first free
  // numbered suffix, so no two groups share one.
  #mintKey(runId: string, firstRowId: string): string {
    const mintedKey = `${runId}:${firstRowId}`;
    let key = mintedKey;
    for (let suffix = 2; this.#keys.has(key); suffix += 1) {
      key = `${mintedKey}~${String(suffix)}`;
    }
    this.#keys.add(key);
    return key;
  }

  /**
   * The group a notification joins: the one the newest card joined, unless the stretch it sat in
   * before lost the card that put it there, which only a release does. Then it joins the group that
   * holds that stretch's rows, or opens one for its run.
   */
  #notificationGroupOf(row: TranscriptEventRow): GroupAccumulator | undefined {
    const lastCardGroup = this.#lastCardGroup;
    const previousKey = this.#previous?.runGroupKeyByRowId.get(row.id);
    const newestCardId = lastCardGroup?.cardRowIds.at(-1);
    const newestCardKey =
      newestCardId === undefined ? undefined : this.#previous?.runGroupKeyByRowId.get(newestCardId);
    // A card new to this log, read back since, places the notification as the log stands.
    const isPlacedByNewestCard =
      newestCardId !== undefined &&
      (newestCardKey === previousKey || this.#previous?.rowsByKey.has(newestCardId) !== true);
    if (previousKey === undefined || isPlacedByNewestCard) {
      return lastCardGroup;
    }
    const held = this.#groupByPreviousKey.get(previousKey);
    const runId = this.#previous?.runGroupByHeaderKey.get(previousKey)?.runId;
    if (held !== undefined || runId === undefined) {
      return held;
    }
    return this.#openGroup(this.#runOf(runId), row);
  }

  #countOutsideCard(): void {
    this.#cardCount += 1;
    this.#lastCardGroup = undefined;
  }

  #openGroup(run: RunAccumulator, row: TranscriptEventRow): GroupAccumulator {
    const group: GroupAccumulator = {
      key: this.#mintKey(run.runId, row.id),
      run,
      firstRowId: row.id,
      rowIds: [],
      cardRowIds: [],
      drawnRowPositions: [],
      headerRowId: undefined,
      lastCardCount: undefined,
      releasedEarlier: undefined,
      releasedLater: undefined,
    };
    if (run.newestGroup !== undefined && headerStateOf(run.facts) !== undefined) {
      // The run's state moves to the new group's header.
      this.#touchedGroups.add(run.newestGroup);
    }
    run.newestGroup = group;
    run.groups.push(group);
    this.#groups.push(group);
    return group;
  }

  #join(
    group: GroupAccumulator,
    row: TranscriptEventRow,
    hasCard: boolean,
    isDrawn: boolean,
  ): void {
    if (isDrawn) {
      group.drawnRowPositions.push(group.rowIds.length);
    }
    group.rowIds.push(row.id);
    this.#memberships.push({ rowId: row.id, group });
    const previousKey = this.#previous?.runGroupKeyByRowId.get(row.id);
    if (previousKey !== undefined && !this.#groupByPreviousKey.has(previousKey)) {
      this.#groupByPreviousKey.set(previousKey, group);
    }
    if (hasCard) {
      group.cardRowIds.push(row.id);
      if (group.headerRowId === undefined) {
        group.headerRowId = row.id;
        this.#drawnGroups.push(group);
        // Published from its first card, after every group whose first card came before.
        this.#touchedGroups.delete(group);
      }
      this.#cardCount += 1;
      group.lastCardCount = this.#cardCount;
      this.#lastCardGroup = group;
    }
    this.#touchedGroups.add(group);
  }

  #takeFacts(run: RunAccumulator, facts: TranscriptRunFactsFold | undefined): void {
    const held = run.facts;
    if (facts === held) {
      return;
    }
    run.facts = facts;
    this.#setLive(run.runId, !isRunEnded(facts));
    if (
      facts?.actor !== held?.actor ||
      facts?.admittedProviderAccountId !== held?.admittedProviderAccountId
    ) {
      // Every header of the run names its actor and account, so each group is sealed again.
      for (const group of run.groups) {
        this.#touchedGroups.add(group);
      }
    } else if (run.newestGroup !== undefined && headerStateOf(facts) !== headerStateOf(held)) {
      this.#touchedGroups.add(run.newestGroup);
    }
  }

  #setLive(runId: string, isLive: boolean): void {
    if (this.#liveRunIds.has(runId) === isLive) {
      return;
    }
    if (isLive) {
      this.#liveRunIds.add(runId);
    } else {
      this.#liveRunIds.delete(runId);
    }
    this.#publishedLiveRunIds = undefined;
  }
}

/** The run groups of one loaded window, its rows folded in one pass. */
export function groupRowsByRun(
  rows: readonly TranscriptEventRow[],
  runEntities: RunEntitiesByRunId,
): readonly RunGroup[] {
  const runGroupIndex = new RunGroupIndex(runEntities);
  const classifier = new SystemMessageClassifier();
  for (const row of rows) {
    runGroupIndex.admit(row, classifier.classify(row) !== undefined);
  }
  return runGroupIndex.runGroups();
}

/** One run's facts, which every group of the run reads. Mutable only inside the fold. */
interface RunAccumulator {
  readonly runId: string;
  readonly groups: GroupAccumulator[];
  /** The group the run's next row joins unless a card from outside broke it. */
  newestGroup: GroupAccumulator | undefined;
  /** The run's facts its groups were last sealed with, `undefined` while the store holds none. */
  facts: TranscriptRunFactsFold | undefined;
}

/** A run group under construction. Mutable only inside the fold. */
interface GroupAccumulator {
  /** Minted at the group's first row; `adoptKeys` may replace it before the group is published. */
  key: string;
  readonly run: RunAccumulator;
  /** The row the group opened at, which its minted key is made from. */
  readonly firstRowId: string;
  readonly rowIds: string[];
  /**
   * The group's cards, in log order: the rows whose stretch is settled, which `adoptKeys` reads.
   */
  readonly cardRowIds: string[];
  /** Where its rows that draw something stand: its cards and the notifications that joined it. */
  readonly drawnRowPositions: number[];
  /** The row its header stands above; see `RunGroup.headerRowId`. `undefined` with no card. */
  headerRowId: string | undefined;
  /** The card count at the group's newest card, or `undefined` before its first. */
  lastCardCount: number | undefined;
  /** The drawn rows let go before the rows the log holds; see `RunGroup.releasedEarlier`. */
  releasedEarlier: ReleasedRunEntries | undefined;
  /** The drawn rows let go after the rows the log holds; see `RunGroup.releasedLater`. */
  releasedLater: ReleasedRunEntries | undefined;
}

/** One member row and the group it joined. */
interface Membership {
  readonly rowId: string;
  readonly group: GroupAccumulator;
}

/** The group sealed, or nothing while it has no card to stand a header above. */
function sealDrawnRunGroup(group: GroupAccumulator): readonly RunGroup[] {
  const headerRowId = group.headerRowId;
  if (headerRowId === undefined) {
    return [];
  }
  const run = group.run;
  return [
    {
      key: group.key,
      runId: run.runId,
      headerRowId,
      // Copies, since the accumulation goes on growing after the group is published.
      rowIds: group.rowIds.slice(),
      rowCount: group.rowIds.length,
      drawnRowPositions: group.drawnRowPositions.slice(),
      actorId: run.facts?.actor,
      runStateEventType: run.newestGroup === group ? headerStateOf(run.facts) : undefined,
      payingAccountId: run.facts?.admittedProviderAccountId,
      releasedEarlier: group.releasedEarlier,
      releasedLater: group.releasedLater,
    },
  ];
}

/**
 * Whether a row of `previous` at a sequence this log lacks was let go: the rows of `rows` beside
 * it, in sequence, are rows `previous` held too, and so is the nearer end's row past an end.
 */
function letGoReaderOf(
  rows: readonly TranscriptEventRow[],
  previousRowsByKey: ReadonlyMap<string, TranscriptEventRow>,
): (sequence: number) => boolean {
  return (sequence) => {
    let low = 0;
    let high = rows.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if ((rows[middle]?.sequence ?? 0) < sequence) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    const before = rows[low - 1];
    const after = rows[low];
    return (
      (before !== undefined || after !== undefined) &&
      (before === undefined || previousRowsByKey.has(before.id)) &&
      (after === undefined || previousRowsByKey.has(after.id))
    );
  };
}

/** Whether `entries` still count a row let go at `sequence`. */
function isAmong(
  entries: ReleasedRunEntries | undefined,
  sequence: number,
): entries is ReleasedRunEntries {
  return (
    entries !== undefined &&
    entries.count > 0 &&
    sequence >= entries.fromSequence &&
    sequence <= entries.toSequence
  );
}

/** `entries` with one more drawn row let go at the `side` end of the stretch. */
function withReleasedRow(
  entries: ReleasedRunEntries | undefined,
  row: TranscriptEventRow,
  side: "earlier" | "later",
): ReleasedRunEntries {
  if (entries === undefined) {
    return {
      count: 1,
      fromSequence: row.sequence,
      toSequence: row.sequence,
      outermostEvent: { sequence: row.sequence, cursor: row.cursor },
    };
  }
  const isOutermost =
    side === "earlier"
      ? row.sequence < entries.outermostEvent.sequence
      : row.sequence > entries.outermostEvent.sequence;
  return {
    count: entries.count + 1,
    fromSequence: Math.min(entries.fromSequence, row.sequence),
    toSequence: Math.max(entries.toSequence, row.sequence),
    outermostEvent: isOutermost
      ? { sequence: row.sequence, cursor: row.cursor }
      : entries.outermostEvent,
  };
}

// A run the store holds no facts for has not been seen to end.
function isRunEnded(facts: TranscriptRunFactsFold | undefined): boolean {
  return facts !== undefined && isTranscriptRunEnded(facts);
}

function headerStateOf(facts: TranscriptRunFactsFold | undefined): string | undefined {
  return facts === undefined ? undefined : transcriptRunHeaderStateOf(facts);
}

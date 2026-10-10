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
// reads the same as one whose rows are all held.

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
  /** The row the header stands above: the stretch's first card, its first drawn row. */
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
      const group = this.#lastCardGroup;
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

/** Partition one loaded window into run groups, for a caller that folds a log once. */
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
  /** The group's first card, or `undefined` while it has none and so draws nothing. */
  headerRowId: string | undefined;
  /** The card count at the group's newest card, or `undefined` before its first. */
  lastCardCount: number | undefined;
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
    },
  ];
}

// A run the store holds no facts for has not been seen to end.
function isRunEnded(facts: TranscriptRunFactsFold | undefined): boolean {
  return facts !== undefined && isTranscriptRunEnded(facts);
}

function headerStateOf(facts: TranscriptRunFactsFold | undefined): string | undefined {
  return facts === undefined ? undefined : transcriptRunHeaderStateOf(facts);
}

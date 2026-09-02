// Superseded bands — the rows a rewind put behind it, kept and dimmed.
//
// `seams.ts`' epoch rule ends on the half this module owns: superseded turns stay
// present but visibly past. Nothing is ever removed. A
// band is the group of rows one rollback rewound past, and the ledger dims a band
// rather than deleting one, so a person can still read what was rewound away.
//
// WHY THIS IS NOT IN `seams.ts`. A seam answers "is this ONE row a mark on the
// log, and what does it say", from that row's own type and payload. A band answers
// a different question over a different subject: given a WHOLE loaded window,
// which rows does a rollback boundary somewhere in it rank past a cutoff. The two
// share the word "rollback" and no table, no reader, and no failure mode — the
// seam vocabulary can grow by a kind without a line here changing.
//
// THE RULES ARE `Spec-013`'s rather than a reading of that rule: the marker is
// single-field and present exactly when superseded, EXCEEDS is the comparison so a
// row at the cutoff survives, marks are epoch-scoped because re-execution reuses
// ordinals, and a `legacy_stub` can never be ranked or marked because it
// structurally carries no position at all.

import { type TimelineRow } from "@ai-sidekicks/contracts";

/** One group of rows a single rollback rewound. */
export interface SupersededBand {
  readonly runId: string;
  readonly epoch: number;
  /** The rewind cutoff. Rows whose position EXCEEDS it are in the band. */
  readonly targetPosition: number;
  /** The band's rows, in log order. Folded as one group; never removed. */
  readonly rowIds: readonly string[];
}

/**
 * One row's rank against the rollback boundaries in its own run and epoch.
 *
 * A class because the answer is asked once per row per frame and computed once per
 * loaded window — the same memo shape `LedgerChapterIndex` uses, for the same
 * reason.
 *
 * IDEMPOTENCE IS STRUCTURAL. The derivation reads the window and produces a set;
 * running it twice over the same window produces the same set, because nothing is
 * accumulated across calls. `Spec-013`'s "applying the boundary to already-delivered
 * rows is idempotent" is therefore a property of the shape rather than a
 * discipline, and a row that arrived pre-marked is admitted through the same set.
 */
export class SupersededIndex {
  readonly #rows: readonly TimelineRow[];
  #bands: readonly SupersededBand[] | undefined;
  #supersededRowIds: ReadonlySet<string> | undefined;

  public constructor(rows: readonly TimelineRow[]) {
    this.#rows = rows;
  }

  /** Whether this row is past a rollback cutoff in its own run and epoch. */
  public isSuperseded(rowId: string): boolean {
    this.#supersededRowIds ??= new Set(this.bands().flatMap((band) => band.rowIds));
    return this.#supersededRowIds.has(rowId);
  }

  /** Every band, keyed by run and epoch, in first-row order. */
  public bands(): readonly SupersededBand[] {
    this.#bands ??= deriveSupersededBands(this.#rows);
    return this.#bands;
  }
}

/** A rankable row: the two arms that carry a position and an epoch. */
interface RankableRow {
  readonly id: string;
  readonly runId: string;
  readonly position: number;
  readonly epoch: number;
  readonly carriedTargetPosition: number | undefined;
}

/**
 * The two arms `Spec-013` allows a superseded marker on.
 *
 * `legacy_stub` is excluded structurally rather than filtered: the arm carries no
 * `position` and no `epoch` at all, "because they are unknowable, not because they
 * were omitted", so it cannot be ranked and can never be marked. `general` is
 * excluded for the same structural reason — it carries no run attribution.
 */
function rankableOf(row: TimelineRow): RankableRow | undefined {
  if (row.kind === "run" || row.kind === "rollback_boundary") {
    return {
      id: row.id,
      runId: row.runId,
      position: row.position,
      epoch: row.epoch,
      carriedTargetPosition: row.superseded?.targetPosition,
    };
  }
  return undefined;
}

/** `runId` and `epoch` as one map key. Marks are epoch-scoped (I-013-4). */
function epochKeyOf(runId: string, epoch: number): string {
  return `${runId} ${String(epoch)}`;
}

/**
 * Derive every superseded band over one loaded window.
 *
 * Two sources agree here rather than competing: a row that arrived PRE-MARKED
 * carries its own cutoff, and a boundary delivered later in the window supersedes
 * rows around it. Both feed the same per-row cutoff, and the lowest cutoff wins —
 * which is what `SupersededMarker`'s own definition says it is ("the FIRST accepted
 * rollback … that rewound the surviving history containing the row").
 */
export function deriveSupersededBands(rows: readonly TimelineRow[]): readonly SupersededBand[] {
  const cutoffsByEpoch = new Map<string, number[]>();
  const rankableRows: RankableRow[] = [];

  for (const row of rows) {
    const rankable = rankableOf(row);
    if (rankable === undefined) {
      continue;
    }
    rankableRows.push(rankable);
    if (row.kind === "rollback_boundary") {
      const key = epochKeyOf(rankable.runId, rankable.epoch);
      const cutoffs = cutoffsByEpoch.get(key) ?? [];
      cutoffs.push(row.payload.targetPosition);
      cutoffsByEpoch.set(key, cutoffs);
    }
  }

  const bandsByKey = new Map<
    string,
    { readonly band: SupersededBand; readonly rowIds: string[] }
  >();
  for (const row of rankableRows) {
    const cutoff = lowestApplicableCutoff(row, cutoffsByEpoch);
    if (cutoff === undefined) {
      continue;
    }
    const key = `${epochKeyOf(row.runId, row.epoch)} ${String(cutoff)}`;
    const existing = bandsByKey.get(key);
    if (existing === undefined) {
      const rowIds: string[] = [row.id];
      bandsByKey.set(key, {
        band: { runId: row.runId, epoch: row.epoch, targetPosition: cutoff, rowIds },
        rowIds,
      });
      continue;
    }
    existing.rowIds.push(row.id);
  }

  return [...bandsByKey.values()].map((entry) => entry.band);
}

/**
 * The cutoff that supersedes this row, or `undefined` when none does.
 *
 * EXCEEDS, not "at or above": `Spec-013 §Required Behavior` marks rows "whose
 * carried run position exceeds the carried rewind cutoff", so the row AT the
 * cutoff is the retained floor and survives. Getting this boundary wrong dims the
 * one turn a person rewound to, which is the turn they are looking at.
 */
function lowestApplicableCutoff(
  row: RankableRow,
  cutoffsByEpoch: ReadonlyMap<string, readonly number[]>,
): number | undefined {
  const candidates: number[] = [];
  if (row.carriedTargetPosition !== undefined && row.position > row.carriedTargetPosition) {
    candidates.push(row.carriedTargetPosition);
  }
  for (const cutoff of cutoffsByEpoch.get(epochKeyOf(row.runId, row.epoch)) ?? []) {
    if (row.position > cutoff) {
      candidates.push(cutoff);
    }
  }
  return candidates.length === 0 ? undefined : Math.min(...candidates);
}

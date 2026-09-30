// Superseded bands: the rows a rewind put behind it, kept and dimmed rather than removed.
// A band is the group of rows one rollback rewound past. Unlike a seam in
// `system-message-classifier.ts`, it is ranked over a whole loaded window, not one row.
// Marks are single-field and present exactly when superseded, a row at the cutoff survives,
// and marks are epoch-scoped because re-execution reuses ordinals.

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
 * A class so the derivation is computed once per loaded window and memoized; deriving is
 * idempotent, so a row that arrived pre-marked is admitted through the same set.
 */
export class SupersededIndex {
  readonly #rows: readonly TimelineRow[];
  #bands: readonly SupersededBand[] | undefined;
  #supersededRowIds: ReadonlySet<string> | undefined;
  #bandByHeaderKey: ReadonlyMap<string, SupersededBand> | undefined;
  #bandKeyByRowId: ReadonlyMap<string, string> | undefined;

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

  /**
   * Every band, keyed by the header key the feed dispatches a band header on: the feed's row
   * dispatch is a map read on `row.key`.
   */
  public bandByHeaderKey(): ReadonlyMap<string, SupersededBand> {
    this.#bandByHeaderKey ??= new Map(
      this.bands().map((band) => [supersededBandKey(band), band] as const),
    );
    return this.#bandByHeaderKey;
  }

  /** Which band a row belongs to, or nothing where no rollback ranked it past a cutoff. */
  public bandKeyByRowId(): ReadonlyMap<string, string> {
    this.#bandKeyByRowId ??= new Map(
      this.bands().flatMap((band) =>
        band.rowIds.map((rowId) => [rowId, supersededBandKey(band)] as const),
      ),
    );
    return this.#bandKeyByRowId;
  }
}

/**
 * One band's identity, as one string.
 * Prefixed because it shares a namespace with run group header keys (a bare run id) and row ids
 * in the one map the feed reads. Two rollbacks to different cutoffs in one epoch are two bands.
 */
export function supersededBandKey(band: SupersededBand): string {
  return `superseded ${band.runId} ${String(band.epoch)} ${String(band.targetPosition)}`;
}

/**
 * Derive every superseded band over one loaded window.
 * A pre-marked row carries its own cutoff and a later boundary supersedes rows around it;
 * both feed one per-row cutoff and the lowest wins, matching `SupersededMarker`.
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

interface RankableRow {
  readonly id: string;
  readonly runId: string;
  readonly position: number;
  readonly epoch: number;
  readonly carriedTargetPosition: number | undefined;
}

/**
 * The two arms a superseded marker is allowed on. `general` carries no run attribution, so it
 * cannot be ranked or marked.
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

function epochKeyOf(runId: string, epoch: number): string {
  return `${runId} ${String(epoch)}`;
}

/**
 * The cutoff that supersedes this row, or `undefined` when none does. A row whose position
 * exceeds the cutoff is superseded; the row at the cutoff is the retained floor, and dimming it
 * would dim the turn the person rewound to.
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

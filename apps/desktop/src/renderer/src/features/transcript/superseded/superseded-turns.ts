// Superseded turns: the rows a rewind put behind it, kept and dimmed rather than removed.
// One group holds the rows one rollback rewound past. Unlike a system message in
// `system-message-classifier.ts`, it is ranked over a whole loaded window, not one row.
// Marks are single-field and present exactly when superseded, a row at the cutoff survives,
// and marks are epoch-scoped because re-execution reuses ordinals.

import type { TranscriptEventRow } from "@ai-sidekicks/contracts/transcript/row";

/** One group of rows a single rollback rewound. */
export interface SupersededTurns {
  readonly runId: string;
  readonly epoch: number;
  /** The rewind cutoff. Rows whose position EXCEEDS it are in the group. */
  readonly targetPosition: number;
  /** The group's rows, in log order; never removed. */
  readonly rowIds: readonly string[];
}

/**
 * One row's rank against the rollback boundaries in its own run and epoch.
 * A class so the derivation is computed once per loaded window and memoized; deriving is
 * idempotent, so a row that arrived pre-marked is admitted through the same set.
 */
export class SupersededIndex {
  readonly #rows: readonly TranscriptEventRow[];
  #supersededRowIds: ReadonlySet<string> | undefined;

  public constructor(rows: readonly TranscriptEventRow[]) {
    this.#rows = rows;
  }

  /** Whether this row is past a rollback cutoff in its own run and epoch. */
  public isSuperseded(rowId: string): boolean {
    this.#supersededRowIds ??= new Set(
      deriveSupersededTurns(this.#rows).flatMap((turns) => turns.rowIds),
    );
    return this.#supersededRowIds.has(rowId);
  }
}

/**
 * Derive every superseded turns group over one loaded window.
 * A pre-marked row carries its own cutoff and a later boundary supersedes rows around it;
 * both feed one per-row cutoff and the lowest wins, matching `SupersededMarker`.
 */
export function deriveSupersededTurns(
  rows: readonly TranscriptEventRow[],
): readonly SupersededTurns[] {
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

  const turnsByKey = new Map<
    string,
    { readonly turns: SupersededTurns; readonly rowIds: string[] }
  >();
  for (const row of rankableRows) {
    const cutoff = lowestApplicableCutoff(row, cutoffsByEpoch);
    if (cutoff === undefined) {
      continue;
    }
    const key = `${epochKeyOf(row.runId, row.epoch)} ${String(cutoff)}`;
    const existing = turnsByKey.get(key);
    if (existing === undefined) {
      const rowIds: string[] = [row.id];
      turnsByKey.set(key, {
        turns: { runId: row.runId, epoch: row.epoch, targetPosition: cutoff, rowIds },
        rowIds,
      });
      continue;
    }
    existing.rowIds.push(row.id);
  }

  return [...turnsByKey.values()].map((entry) => entry.turns);
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
function rankableOf(row: TranscriptEventRow): RankableRow | undefined {
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

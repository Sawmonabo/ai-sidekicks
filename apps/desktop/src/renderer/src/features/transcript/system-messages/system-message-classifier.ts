// The epoch rule: which rows are seams, and what one row's seam says. The closed vocabulary
// it classifies into (kinds, wire types, labels, glyphs, the one caution) is in
// `system-message-kinds.ts`. Superseded turns are ranked separately in `superseded-bands.ts`.

import { type TimelineRow } from "@ai-sidekicks/contracts";

import {
  SYSTEM_MESSAGE_KINDS,
  SYSTEM_MESSAGE_BINDINGS,
  type SystemMessageKind,
} from "./system-message-kinds.js";

/**
 * One seam, decomposed into the parts the frame lays on a line.
 * Wire-sourced members are carried verbatim as `string` so an unknown enum member is shown
 * as it arrived, never dropped or guessed.
 */
export interface SystemMessageReading {
  readonly kind: SystemMessageKind;
  readonly rowId: string;
  readonly sequence: number;
  readonly timestamp: string;
  /** The run whose condition changed, or `undefined` on an unattributed seam. */
  readonly runId: string | undefined;
  readonly actorId: string | undefined;
  /** The event type this seam was read from, verbatim. */
  readonly wireType: string;
  /**
   * The rollback's confirmed rewind floor, or the compaction's run-scoped position;
   * `undefined` where the row carried none, rendered as an absence, never as zero.
   */
  readonly boundaryPosition: number | undefined;
  /** The epoch the seam belongs to, where the arm carries one. */
  readonly epoch: number | undefined;
  /** How the conversation crossed the switch, verbatim. */
  readonly continuity: string | undefined;
  /** What the switch declared lost, verbatim; empty is the claim that nothing was. */
  readonly declaredLosses: readonly string[];
  /** The failed switch's closed `reason`, verbatim. */
  readonly reason: string | undefined;
}

/**
 * The seam classifier. A class so the wire-type-to-kind table is built once per transcript
 * instead of per row, without module-level mutable state.
 */
export class SystemMessageClassifier {
  readonly #kindByWireType: ReadonlyMap<string, SystemMessageKind>;

  public constructor() {
    const kindByWireType = new Map<string, SystemMessageKind>();
    for (const kind of SYSTEM_MESSAGE_KINDS) {
      for (const wireType of SYSTEM_MESSAGE_BINDINGS[kind].wireTypes) {
        kindByWireType.set(wireType, kind);
      }
    }
    this.#kindByWireType = kindByWireType;
  }

  /** One row's seam, or `undefined` when the row is not a seam. */
  public classify(row: TimelineRow): SystemMessageReading | undefined {
    if (row.kind === "rollback_boundary") {
      return rollbackSeamOf(row);
    }
    const kind = this.#kindByWireType.get(row.type);
    if (kind === undefined) {
      return undefined;
    }
    const runId = row.kind === "general" ? undefined : row.runId;
    const epoch = row.kind === "run" ? row.epoch : undefined;
    return {
      kind,
      rowId: row.id,
      sequence: row.sequence,
      timestamp: row.timestamp,
      runId,
      actorId: row.actor,
      wireType: row.type,
      // `usage.context_compacted` has no payload variant or boundary member; the wire does
      // carry the `run` arm's run-scoped `position`, the comparand a rollback cutoff ranks
      // against. A compaction on any other arm has no position.
      boundaryPosition: kind === "compaction" && row.kind === "run" ? row.position : undefined,
      epoch,
      continuity: readString(row.payload, "continuity"),
      declaredLosses: readDeclaredLosses(row.payload),
      reason: readString(row.payload, "reason"),
    };
  }

  /** Every seam in one loaded window, in log order. */
  public seams(rows: readonly TimelineRow[]): readonly SystemMessageReading[] {
    const seams: SystemMessageReading[] = [];
    for (const row of rows) {
      const seam = this.classify(row);
      if (seam !== undefined) {
        seams.push(seam);
      }
    }
    return seams;
  }
}

function readString(payload: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * The losses a switch declares, each kept as the string the wire sent, so a newly added
 * kind of loss is still reported.
 */
function readDeclaredLosses(payload: Readonly<Record<string, unknown>>): readonly string[] {
  const value = payload["declaredLosses"];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

/**
 * The rollback boundary's typed payload, read through the arm's narrowing so the rewind
 * cutoff never reaches a consumer through a cast.
 */
function rollbackSeamOf(
  row: Extract<TimelineRow, { kind: "rollback_boundary" }>,
): SystemMessageReading {
  return {
    kind: "rollback",
    rowId: row.id,
    sequence: row.sequence,
    timestamp: row.timestamp,
    runId: row.runId,
    actorId: row.actor,
    wireType: row.type,
    boundaryPosition: row.payload.targetPosition,
    epoch: row.epoch,
    continuity: undefined,
    declaredLosses: [],
    reason: undefined,
  };
}

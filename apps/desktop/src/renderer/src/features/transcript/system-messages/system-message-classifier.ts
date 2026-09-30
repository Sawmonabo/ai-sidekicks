// The epoch rule — which rows are seams, and what one row's seam says.
//
// A seam is one line marking a change in the run's condition, and this module decides
// which rows earn one. The closed vocabulary it classifies into is
// `system-message-kinds.ts`': the kinds, the wire types each reads, the label, the glyph
// and the one caution. Splitting the two is what keeps a reader of the table away from
// the payload reads, and a reader of the payload reads away from the table.
//
// THE OTHER HALF OF THE DESIGN'S RULE — superseded turns stay present but visibly past
// — is `superseded-bands.ts`. It asks a different question of a different subject
// (a whole window, ranked against the rollback cutoffs inside it) and shares no
// table with the classifier below, so the two grow apart without colliding.

import { type TimelineRow } from "@ai-sidekicks/contracts";

import {
  SYSTEM_MESSAGE_KINDS,
  SYSTEM_MESSAGE_BINDINGS,
  type SystemMessageKind,
} from "./system-message-kinds.js";

/**
 * One seam, decomposed into the parts the frame lays on a line.
 *
 * Every wire-sourced member is carried VERBATIM and typed `string`, which is the
 * fail-closed projection rule — an unknown enum member renders as the explicit
 * unrecognized row or badge, never as a guess — expressed in the type: a closed union
 * here would have to decide what
 * to do with a value it did not know, and the only fail-closed answers are to drop
 * it or to guess.
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
   * The boundary position, for the two seams that carry one: the rollback's
   * confirmed rewind floor, read through the boundary arm's typed payload, and the
   * compaction's own run-scoped position. `undefined` where the row carried none —
   * rendered as an absence, never as zero.
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
 * The seam classifier.
 *
 * A class because it holds a derived table — wire type to seam kind — that is
 * wasteful to rebuild per row. A module-level table would be module-level mutable
 * state, which this tree does not keep; an instance built once per transcript is the
 * same table with an owner.
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
      // THE COMPACTION BOUNDARY IS THE ROW'S OWN POSITION, not a payload member.
      // `usage.context_compacted` registers no payload variant in
      // `@ai-sidekicks/contracts` and names no boundary member anywhere in it, so a
      // payload read here was permanently absent. What the wire DOES carry is the
      // run-scoped `position` the `run` arm requires — the projection-resolved
      // originating run position, and the comparand a rollback's cutoff is ranked
      // against. A compaction row on any other arm carries no position at all, and
      // that absence is rendered as one.
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
 * The losses a switch declares, verbatim.
 *
 * Every entry is kept as the string the wire sent — the vocabulary is closed on
 * the wire and widened by amendment, so a renderer that mapped unknown members
 * onto a fallback phrase would silently stop reporting the newest kind of loss.
 */
function readDeclaredLosses(payload: Readonly<Record<string, unknown>>): readonly string[] {
  const value = payload["declaredLosses"];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

/**
 * The rollback boundary's payload, which the contract types rather than leaves
 * open.
 *
 * Read through the arm's own narrowing so the rewind cutoff never reaches a
 * consumer through a cast — the property this narrowing exists to guarantee.
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

// The epoch rule — which rows are seams, and what one row's seam says.
//
// A seam is one line marking a change in the run's condition, and this module decides
// which rows earn one. The closed vocabulary it classifies into is
// `seam-vocabulary.ts`': the kinds, the wire types each reads, the label, the glyph
// and the one caution. Splitting the two is what keeps a reader of the table away from
// the payload reads, and a reader of the payload reads away from the table.
//
// THE CENSUS IS ASKED, NEVER HAND-COPIED. The index below reads the registered event
// census off the contract's own map, so `unregisteredWireTypes()` reports what the
// daemon cannot produce yet rather than a second list making a claim about the
// contract that the contract never checks. A row whose type is not in the census still
// classifies if one ever arrives — `TimelineRow.type` is free-form by contract — so
// the console is ready for the registration without pretending it has happened.
//
// THE OTHER HALF OF THE DESIGN'S RULE — superseded turns stay present but visibly past
// — is `superseded-bands.ts`. It asks a different question of a different subject
// (a whole window, ranked against the rollback cutoffs inside it) and shares no
// table with the classifier below, so the two grow apart without colliding.

import { SESSION_EVENT_CATEGORY_BY_TYPE, type TimelineRow } from "@ai-sidekicks/contracts";

import {
  LEDGER_SEAM_KINDS,
  SEAM_WIRE_BINDINGS,
  SWITCH_CONTINUITY_MEMO,
  type LedgerSeamKind,
  type SeamWireRegistration,
} from "./seam-vocabulary.js";

/**
 * One seam, decomposed into the parts the frame lays on a line.
 *
 * Every wire-sourced member is carried VERBATIM and typed `string`, which is
 * `Spec-023 §Rules every console surface obeys`' fail-closed projection ("an unknown
 * enum member renders as the explicit unrecognized row or badge, never as a guess")
 * expressed in the type: a closed union here would have to decide what
 * to do with a value it did not know, and the only fail-closed answers are to drop
 * it or to guess.
 */
export interface LedgerSeam {
  readonly kind: LedgerSeamKind;
  readonly rowId: string;
  readonly sequence: number;
  readonly timestamp: string;
  /** The run whose condition changed, or `undefined` on an unattributed seam. */
  readonly runId: string | undefined;
  readonly actorId: string | undefined;
  /** The event type this seam was read from, verbatim. */
  readonly wireType: string;
  readonly wireRegistration: SeamWireRegistration;
  /**
   * The boundary position, for the two seams that carry one: the rollback's
   * confirmed rewind floor, read through the boundary arm's typed payload, and the
   * compaction's own run-scoped position. `undefined` where the row carried none —
   * rendered as an absence, never as zero.
   */
  readonly boundaryPosition: number | undefined;
  /** The epoch the seam belongs to, where the arm carries one. */
  readonly epoch: number | undefined;
  /**
   * The switch's continuity value, verbatim. A loss clause is rendered ONLY
   * when this reads `'memo'`; `'in_place'` and `'replayed'` render the same line
   * without one, because nothing was lost.
   */
  readonly continuity: string | undefined;
  /** The declared losses, verbatim, for a `'memo'` switch. Empty otherwise. */
  readonly declaredLosses: readonly string[];
  /** The failed switch's closed `reason`, verbatim. */
  readonly reason: string | undefined;
  /** Which run state the block is waiting on, verbatim, for `run-blocked`. */
  readonly blockedOn: string | undefined;
}

function readString(payload: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * The declared losses a `'memo'` switch names, verbatim.
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
 * consumer through a cast — the property `Spec-013` I-013-5 exists to guarantee.
 */
function rollbackSeamOf(row: Extract<TimelineRow, { kind: "rollback_boundary" }>): LedgerSeam {
  return {
    kind: "rollback",
    rowId: row.id,
    sequence: row.sequence,
    timestamp: row.timestamp,
    runId: row.runId,
    actorId: row.actor,
    wireType: row.type,
    wireRegistration: "registered",
    boundaryPosition: row.payload.targetPosition,
    epoch: row.epoch,
    continuity: undefined,
    declaredLosses: [],
    reason: undefined,
    blockedOn: undefined,
  };
}

/**
 * The seam classifier and the registered-census reader.
 *
 * A class because it holds two derived tables — wire type to seam kind, and the
 * set of types the contract registers — and both are wasteful to rebuild per row.
 * Module-level tables would be module-level mutable state, which this tree does
 * not keep; an instance built once per surface is the same table with an owner.
 */
export class LedgerSeamIndex {
  readonly #kindByWireType: ReadonlyMap<string, LedgerSeamKind>;
  readonly #registeredWireTypes: ReadonlySet<string>;

  public constructor() {
    const kindByWireType = new Map<string, LedgerSeamKind>();
    for (const kind of LEDGER_SEAM_KINDS) {
      for (const wireType of SEAM_WIRE_BINDINGS[kind].wireTypes) {
        kindByWireType.set(wireType, kind);
      }
    }
    this.#kindByWireType = kindByWireType;
    // Asked of the contract rather than hand-copied. The census map is keyed by
    // the registered union, so its keys ARE the registered census — a second list
    // here would be a claim about the contract that the contract never checks.
    this.#registeredWireTypes = new Set<string>(SESSION_EVENT_CATEGORY_BY_TYPE.keys());
  }

  /** Whether a wire type is in the registered event census. */
  public isRegisteredWireType(wireType: string): boolean {
    return this.#registeredWireTypes.has(wireType);
  }

  /**
   * The seam wire types the contract does not register yet, in binding order.
   *
   * The surface renders this as an absence rather than as a silence: a seam
   * vocabulary the daemon cannot half produce is a fact about the wire, and rule 8
   * says an unasked question renders differently from a negative answer.
   */
  public unregisteredWireTypes(): readonly string[] {
    const missing: string[] = [];
    for (const kind of LEDGER_SEAM_KINDS) {
      for (const wireType of SEAM_WIRE_BINDINGS[kind].wireTypes) {
        if (!this.#registeredWireTypes.has(wireType)) {
          missing.push(wireType);
        }
      }
    }
    return missing;
  }

  /** Seam kinds none of whose wire types the contract registers. */
  public unregisteredSeamKinds(): readonly LedgerSeamKind[] {
    return LEDGER_SEAM_KINDS.filter((kind) =>
      SEAM_WIRE_BINDINGS[kind].wireTypes.every(
        (wireType) => !this.#registeredWireTypes.has(wireType),
      ),
    );
  }

  /** One row's seam, or `undefined` when the row is not a seam. */
  public classify(row: TimelineRow): LedgerSeam | undefined {
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
      wireRegistration: this.#registeredWireTypes.has(row.type) ? "registered" : "unregistered",
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
      declaredLosses:
        readString(row.payload, "continuity") === SWITCH_CONTINUITY_MEMO
          ? readDeclaredLosses(row.payload)
          : [],
      reason: readString(row.payload, "reason"),
      blockedOn: kind === "run-blocked" ? row.type : undefined,
    };
  }

  /** Every seam in one loaded window, in log order. */
  public seams(rows: readonly TimelineRow[]): readonly LedgerSeam[] {
    const seams: LedgerSeam[] = [];
    for (const row of rows) {
      const seam = this.classify(row);
      if (seam !== undefined) {
        seams.push(seam);
      }
    }
    return seams;
  }
}

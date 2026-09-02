// Seams and superseded bands — the log's epochs, rendered as geography.
//
// `Spec-023 §Console Design (Meridian)` §5.3: "Make the log's epochs geography:
// provider switches, compactions, and rollbacks render as labeled seams across the
// ledger, and superseded turns stay present but visibly past."
//
// A seam is ONE LINE. Never a message row, never a block — that is the whole
// visual claim, and it is why this module produces a value with named parts rather
// than prose: the parts are laid out on one line by the ledger frame, and a
// producer that composed a sentence here would have decided the layout.
//
// WIRE TRUTH, AND WHERE THIS DESIGN OUTRUNS IT
//
// Five of the eight seam kinds below name an event type that
// `@ai-sidekicks/contracts` does not register today. The registered census is
// `SESSION_EVENT_CATEGORY_BY_TYPE`, and it does not carry
// `agent.provider_switched`, `agent.provider_switch_failed`, `run.resumed`, or
// `run.unblocked`; `run.blocked` is not a type at all — the design's own
// parenthetical says the block indicator distinguishes `waiting_for_approval`
// from `waiting_for_input`, and those two ARE registered, so that kind binds to
// them.
//
// The response is neither to invent the types nor to drop the kinds. Each binding
// below carries the wire types it reads, membership in the registered census is
// ASKED of the contract rather than hand-copied, and `unregisteredWireTypes()`
// reports what is missing so a surface can render the absence (rule 8's
// `not-checked`: nobody asked, which is not the same as "no") instead of drawing a
// seam vocabulary that half the daemon cannot produce. A row whose type is not in
// the census still classifies if one ever arrives — `TimelineRow.type` is free-form
// by contract — so the console is ready for the registration without pretending it
// has happened.
//
// THE SUPERSEDED BAND is the other half, and its rules come from `Spec-013` rather
// than from a reading of §5.3: the marker is single-field and present exactly when
// superseded, EXCEEDS is the comparison so a row at the cutoff survives, marks are
// epoch-scoped because re-execution reuses ordinals, and a `legacy_stub` can never
// be ranked or marked because it structurally carries no position at all.

import { SESSION_EVENT_CATEGORY_BY_TYPE, type TimelineRow } from "@ai-sidekicks/contracts";

import { type GlyphName } from "../../tokens/index.js";

/**
 * Every seam the ledger draws. Closed; adding one is a deliberate edit here and a
 * reading of §5.3.
 *
 * The tuple is the declaration and `LedgerSeamKind` is derived from it, so the set
 * a gallery iterates and the set the classifier switches over cannot come apart.
 *
 * Eight, and §5.3 names them as two groups that render the same way: three epoch
 * seams (switch, compaction, rollback) plus the failed switch, and the four
 * remaining run-state subtype rows. They are one set here because a seam is a
 * one-line row marking a change in the run's condition, and a reader scanning the
 * rail does not care which paragraph of the design a mark came from.
 */
export const LEDGER_SEAM_KINDS = [
  "provider-switch",
  "provider-switch-failed",
  "compaction",
  "rollback",
  "run-paused",
  "run-resumed",
  "run-blocked",
  "run-unblocked",
] as const;

export type LedgerSeamKind = (typeof LEDGER_SEAM_KINDS)[number];

/**
 * Whether the wire type a seam reads is in the registered event census.
 *
 * Rendered, never inferred: a surface showing a seam vocabulary owes the operator
 * the difference between "this has not happened" and "the daemon cannot say this
 * yet".
 */
export type SeamWireRegistration = "registered" | "unregistered";

/** What one seam kind reads, and how it is drawn. */
export interface SeamWireBinding {
  readonly kind: LedgerSeamKind;
  /** The wire event types that produce this seam, verbatim. */
  readonly wireTypes: readonly string[];
  /**
   * The glyph the one-line row and the rail tick carry.
   *
   * Drawn from `tokens/glyphs.ts`'s closed family. Two readings here are
   * deliberate substitutions rather than the obvious pick, because the family
   * carries no rewind and no fold glyph and minting one is the token family's
   * edit, not this lane's: a rollback takes `clock` (history moved) and a
   * compaction takes `chevron-down` (the log folded).
   */
  readonly glyph: GlyphName;
  /**
   * Whether the seam is the pair's one caution.
   *
   * §5.3 is explicit that only the FAILED switch is a caution: `'in_place'` and
   * `'replayed'` render "without a loss clause and without a warning, because
   * nothing was lost". Amber and red are spent on attention and failure alone
   * (rule 3), so this is the single member that earns one.
   */
  readonly isCaution: boolean;
}

/**
 * The binding table. Closed and total over `LedgerSeamKind` by construction — a
 * ninth kind fails to compile here before it can reach a classifier that would
 * silently never match it.
 */
export const SEAM_WIRE_BINDINGS: Readonly<Record<LedgerSeamKind, SeamWireBinding>> = {
  "provider-switch": {
    kind: "provider-switch",
    wireTypes: ["agent.provider_switched"],
    glyph: "chevron-right",
    isCaution: false,
  },
  "provider-switch-failed": {
    kind: "provider-switch-failed",
    wireTypes: ["agent.provider_switch_failed"],
    glyph: "alert",
    isCaution: true,
  },
  compaction: {
    kind: "compaction",
    wireTypes: ["usage.context_compacted"],
    glyph: "chevron-down",
    isCaution: false,
  },
  rollback: {
    kind: "rollback",
    wireTypes: ["run.rolled_back"],
    glyph: "clock",
    isCaution: false,
  },
  "run-paused": {
    kind: "run-paused",
    wireTypes: ["run.paused"],
    glyph: "pause",
    isCaution: false,
  },
  "run-resumed": {
    kind: "run-resumed",
    wireTypes: ["run.resumed"],
    glyph: "play",
    isCaution: false,
  },
  "run-blocked": {
    kind: "run-blocked",
    // The design's own parenthetical: the block indicator distinguishes
    // `waiting_for_approval` from `waiting_for_input`, and both are registered.
    // `run.blocked` itself is not a wire type and is not read for.
    wireTypes: ["run.waiting_for_approval", "run.waiting_for_input"],
    glyph: "dot",
    isCaution: false,
  },
  "run-unblocked": {
    kind: "run-unblocked",
    wireTypes: ["run.unblocked"],
    glyph: "check",
    isCaution: false,
  },
};

/**
 * One seam, decomposed into the parts the frame lays on a line.
 *
 * Every wire-sourced member is carried VERBATIM and typed `string`, which is
 * §5.3's "never drops an unrecognized `reason` or `continuity` value; it renders
 * as itself" expressed in the type: a closed union here would have to decide what
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
   * confirmed rewind floor, and the compaction's boundary. `undefined` where the
   * payload named none — rendered as an absence, never as zero.
   */
  readonly boundaryPosition: number | undefined;
  /** The epoch the seam belongs to, where the arm carries one. */
  readonly epoch: number | undefined;
  /**
   * The switch's continuity value, verbatim. §5.3: a loss clause is rendered ONLY
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

/** The value `continuity` takes when the new provider works from a summary. */
export const SWITCH_CONTINUITY_MEMO = "memo";

function readString(payload: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" ? value : undefined;
}

function readNumber(payload: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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
      boundaryPosition:
        kind === "compaction" ? readNumber(row.payload, "boundaryPosition") : undefined,
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
 * accumulated across calls. §5.3's "Applying the boundary to already-delivered
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
  return `${runId} ${String(epoch)}`;
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
    const key = `${epochKeyOf(row.runId, row.epoch)} ${String(cutoff)}`;
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

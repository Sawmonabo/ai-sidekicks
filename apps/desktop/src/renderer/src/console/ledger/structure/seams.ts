// Seams — the log's epochs, rendered as geography.
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
// THE OTHER HALF OF §5.3 — "superseded turns stay present but visibly past" —
// is `superseded-bands.ts`. It asks a different question of a different subject
// (a whole window, ranked against the rollback cutoffs inside it) and shares no
// table with the classifier below, so the two grow apart without colliding.

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
  /**
   * What the one-line row calls this seam, in the console's own words.
   *
   * The console's, and deliberately not the wire's: the wire type is rendered
   * beside it verbatim and in mono, so this is the reader-facing half of a pair
   * rather than a paraphrase standing in for a value the daemon sent.
   */
  readonly label: string;
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
    label: "Provider switched",
    wireTypes: ["agent.provider_switched"],
    glyph: "chevron-right",
    isCaution: false,
  },
  "provider-switch-failed": {
    kind: "provider-switch-failed",
    label: "Provider switch failed",
    wireTypes: ["agent.provider_switch_failed"],
    glyph: "alert",
    isCaution: true,
  },
  compaction: {
    kind: "compaction",
    label: "Context compacted",
    wireTypes: ["usage.context_compacted"],
    glyph: "chevron-down",
    isCaution: false,
  },
  rollback: {
    kind: "rollback",
    label: "Rewound",
    wireTypes: ["run.rolled_back"],
    glyph: "clock",
    isCaution: false,
  },
  "run-paused": {
    kind: "run-paused",
    label: "Run paused",
    wireTypes: ["run.paused"],
    glyph: "pause",
    isCaution: false,
  },
  "run-resumed": {
    kind: "run-resumed",
    label: "Run resumed",
    wireTypes: ["run.resumed"],
    glyph: "play",
    isCaution: false,
  },
  "run-blocked": {
    kind: "run-blocked",
    label: "Run blocked",
    // The design's own parenthetical: the block indicator distinguishes
    // `waiting_for_approval` from `waiting_for_input`, and both are registered.
    // `run.blocked` itself is not a wire type and is not read for.
    wireTypes: ["run.waiting_for_approval", "run.waiting_for_input"],
    glyph: "dot",
    isCaution: false,
  },
  "run-unblocked": {
    kind: "run-unblocked",
    label: "Run unblocked",
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
   * confirmed rewind floor, read through the boundary arm's typed payload, and the
   * compaction's own run-scoped position. `undefined` where the row carried none —
   * rendered as an absence, never as zero.
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

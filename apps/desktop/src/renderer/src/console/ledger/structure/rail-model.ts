// The provenance rail's model — what the minimap knows, with no DOM in it.
//
// `Spec-023 §The four bars`, Richness, names "a provenance rail that draws the session's
// shape" among the console's signature surfaces. WHAT THAT RAIL IS, is this module's
// decision, because no committed document states it: the scrollbar is replaced by a
// scrubbable minimap of the session's story. The component next door paints it and
// handles the pointer; everything a paint or a keypress needs to DECIDE lives here,
// so the rail's rules are driven by the `console-unit` tier rather than measured
// through a canvas.
//
// THREE RULES THIS MODULE MAKES STRUCTURAL:
//
//   • **Clip honesty.** The rail draws only the loaded window and marks the
//     unloaded extent as a dotted segment. `RailClip` is a required member of the
//     model rather than an optional flag, so a rail cannot be built without
//     answering whether it is showing everything.
//   • **Two colours, spent once.** `Spec-023 §Meridian, the design language` rule 3:
//     "Amber means a person is needed. Red means something failed. Nothing else is
//     colored for attention." On the rail that reads as: only pending-human ticks are
//     amber and only failures are red, every other tick taking the actor's hue at low
//     chroma (rule 2's participant hue system). The tone is a property of the KIND,
//     fixed in the table below, so no call site can spend amber on a tick that needs
//     nobody.
//   • **No invented ticks.** The rail never invents ticks for rows
//     that are not loaded. Every tick here is produced from a row in the window it
//     was handed; the unloaded extent is drawn as a segment, never as marks.
//   • **One geometry.** A mark's place on the rail and the viewport thumb's place
//     on it are the same measurement over one ordering, stated once below as the
//     row-band model and derived nowhere else. Two derivations of "where on the
//     rail" is how a mark ends up outside the thumb that is supposed to be
//     pointing at it.

import type { TimelineRow } from "@ai-sidekicks/contracts";

import { type GlyphName } from "../../tokens/index.js";
import { RAIL_THUMB_MIN_EXTENT } from "./constants.js";
import { LedgerSeamIndex, SEAM_WIRE_BINDINGS, type LedgerSeamKind } from "./seams.js";

/**
 * Every kind of mark the rail draws. Closed, and this module's own enumeration.
 *
 * The tuple is the declaration and the union follows from it, so the legend, the
 * keyboard's "next tick of a kind" walk, and the painter all read one list.
 */
export const RAIL_TICK_KINDS = [
  "participant-message",
  "approval",
  "tool-error",
  "handoff",
  "park",
  "resume",
  "rollback-epoch",
  "compaction",
  "provider-switch",
  "artifact-publication",
] as const;

export type RailTickKind = (typeof RAIL_TICK_KINDS)[number];

/**
 * What colour a tick takes. Three values, and two of them are rationed.
 *
 * `actor` is not a colour — it is an instruction to take the actor's hue at low
 * chroma, which the painter resolves from the session's hue allocation. Naming it
 * here rather than resolving a colour string keeps rule 2's "the hue is never the
 * sole attribution channel" answerable by the surface that knows the wheel.
 */
export const RAIL_TICK_TONES = ["actor", "attention", "failure"] as const;

export type RailTickTone = (typeof RAIL_TICK_TONES)[number];

/** What one tick kind reads and how it is drawn. */
export interface RailTickBinding {
  readonly kind: RailTickKind;
  /** Wire event types that produce this tick directly, verbatim. */
  readonly wireTypes: readonly string[];
  /** Seam kinds that produce this tick. Read through `seams.ts`, never re-classified. */
  readonly seamKinds: readonly LedgerSeamKind[];
  readonly tone: RailTickTone;
  readonly glyph: GlyphName;
}

/**
 * The tick table. Total over `RailTickKind` by construction.
 *
 * The six seam-derived kinds name SEAM KINDS rather than repeating the seam
 * module's wire types: the seam vocabulary is one table, and a second copy of it
 * here would be the drift `apps/desktop/AGENTS.md` names — "two copies of one
 * regular expression or normalization: they drift, and the gate goes green".
 */
export const RAIL_TICK_BINDINGS: Readonly<Record<RailTickKind, RailTickBinding>> = {
  "participant-message": {
    kind: "participant-message",
    wireTypes: ["user.message"],
    seamKinds: [],
    tone: "actor",
    glyph: "member",
  },
  approval: {
    kind: "approval",
    // The one pending-human mark, and therefore the one amber one. The settled
    // arms (`approval.approved` / `.rejected`) are not ticks: the rail marks where
    // a person was NEEDED, and a decided approval needs nobody.
    wireTypes: ["approval.requested"],
    seamKinds: [],
    tone: "attention",
    glyph: "approval",
  },
  "tool-error": {
    kind: "tool-error",
    wireTypes: ["tool.error"],
    seamKinds: [],
    tone: "failure",
    glyph: "alert",
  },
  handoff: {
    kind: "handoff",
    // Work changing hands: an agent joining or leaving the session, and a child
    // run taking a piece of it. All four are in the registered event census.
    wireTypes: ["agent.attached", "agent.detached", "subagent.started", "subagent.completed"],
    seamKinds: [],
    tone: "actor",
    glyph: "agent",
  },
  park: { kind: "park", wireTypes: [], seamKinds: ["run-paused"], tone: "actor", glyph: "pause" },
  resume: {
    kind: "resume",
    wireTypes: [],
    seamKinds: ["run-resumed"],
    tone: "actor",
    glyph: "play",
  },
  "rollback-epoch": {
    kind: "rollback-epoch",
    wireTypes: [],
    seamKinds: ["rollback"],
    tone: "actor",
    // The rewind mark, which `tokens/glyphs.ts` draws for exactly this: an open
    // ring whose gap is the part of the conversation being given up. A clock
    // would say "this took time", which is the one thing a rollback is not about.
    glyph: "rewind",
  },
  compaction: {
    kind: "compaction",
    wireTypes: [],
    seamKinds: ["compaction"],
    tone: "actor",
    // The fold mark: two chevrons closing onto a rule. A bare `chevron-down`
    // points AWAY from the boundary and is the disclosure chevron everywhere else
    // in the console, so on the rail it would read as "expand me".
    glyph: "fold",
  },
  "provider-switch": {
    kind: "provider-switch",
    wireTypes: [],
    seamKinds: ["provider-switch", "provider-switch-failed"],
    tone: "actor",
    glyph: "chevron-right",
  },
  "artifact-publication": {
    kind: "artifact-publication",
    wireTypes: ["artifact.published"],
    seamKinds: [],
    tone: "actor",
    glyph: "artifact",
  },
};

/**
 * THE ROW-BAND MODEL — the rail's one geometry, stated here and derived nowhere
 * else.
 *
 * The retained viewport rows partition the rail into `n` equal BANDS, one per row,
 * in the order the feed renders them. Two readings come out of that partition and
 * they are the same measurement:
 *
 *   • A row's mark sits at the CENTRE of its band, `(rowIndex + 0.5) / n`.
 *   • The viewport's thumb SPANS the bands of the rows the box intersects, from
 *     `firstRowIndex / n` for `(lastRowIndex - firstRowIndex + 1) / n`.
 *
 * Which makes "a visible row's mark lies inside the thumb" arithmetic rather than
 * coincidence — `firstRowIndex ≤ i ≤ lastRowIndex` gives
 * `firstRowIndex / n ≤ (i + 0.5) / n < (lastRowIndex + 1) / n` — and it makes the
 * thumb end exactly at the rail's bottom, because the last row's band does.
 *
 * BOTH HALVES WERE ONCE DERIVED SEPARATELY AND NEITHER WAS SAFE. Marks were placed
 * by SEQUENCE distance, which is a different axis: filtering, sequence gaps, and
 * the synthetic chapter-header rows the feed inserts all make row order and
 * sequence order diverge, so a mark placed on one axis and a thumb placed on the
 * other could not be compared. And the thumb's top was taken against the last
 * INDEX while its height was taken against the row COUNT, which are two
 * denominators: at the tail of a hundred rows that reads 90.9% down with 10% of
 * height, and the thumb hung off the end of the rail.
 */
export interface RailViewportBand {
  /** The band's top, 0 at the rail's head and 1 at its foot. */
  readonly position: number;
  /** How much of the rail the band covers, as a fraction. */
  readonly extent: number;
}

/**
 * The band the rows `firstRowIndex` through `lastRowIndex` occupy.
 *
 * An unmeasured or empty window is the WHOLE rail rather than a band at its head:
 * a thumb covering everything says "this is all of it", which is the honest answer
 * for a box nothing has measured, and a thumb at the head would say the reader is
 * at the top of a window nobody has read.
 */
export function railViewportBand(
  firstRowIndex: number,
  lastRowIndex: number,
  retainedRowCount: number,
): RailViewportBand {
  if (retainedRowCount === 0) {
    return { position: 0, extent: 1 };
  }
  return clampRailViewportBand({
    position: firstRowIndex / retainedRowCount,
    extent: (lastRowIndex - firstRowIndex + 1) / retainedRowCount,
  });
}

/**
 * Bring an arbitrary band inside the rail, in ONE act.
 *
 * The extent settles first and the top is then clamped against `1 - extent`,
 * because those two numbers are not independent: clamping each into `[0, 1]` on
 * its own admits `0.909 + 0.1`, which is a thumb hanging over the rail's foot. The
 * order also means the minimum height is paid for out of the TOP rather than out
 * of the rail — a one-row thumb at the very bottom is nudged up to fit rather than
 * grown past the end.
 *
 * Exported because the component that draws the thumb is handed a band by its
 * caller and cannot assume the caller built it here; one clamp, in one module, is
 * what keeps the two sides of that seam from clamping differently.
 */
export function clampRailViewportBand(band: RailViewportBand): RailViewportBand {
  const extent = Math.min(1, Math.max(RAIL_THUMB_MIN_EXTENT, band.extent));
  return { position: Math.min(1 - extent, Math.max(0, band.position)), extent };
}

/** One mark on the rail. */
export interface RailTick {
  readonly kind: RailTickKind;
  readonly rowId: string;
  readonly sequence: number;
  readonly timestamp: string;
  /** The participant the tick takes its hue from, or `undefined` for an unattributed row. */
  readonly actorId: string | undefined;
  readonly tone: RailTickTone;
  readonly glyph: GlyphName;
  /**
   * The row's summary, wire-verbatim, for the hover preview card. Carried on the
   * tick rather than looked up at hover time so the read is immediate and the
   * grace applies only to the card OPENING: there is no debounce on the read.
   */
  readonly summary: string;
  /** Where along the rail this tick sits, 0 at the window's head and 1 at its tail. */
  readonly position: number;
}

/**
 * What the rail is not showing.
 *
 * The clip honesty above. `hasUnloadedExtent` is the dotted segment's condition, and
 * `earliestLoadedSequence` is what a "load earlier" affordance asks from.
 */
export interface RailClip {
  readonly hasUnloadedExtent: boolean;
  readonly earliestLoadedSequence: number | undefined;
  readonly latestLoadedSequence: number | undefined;
}

/** Everything the painter and the keyboard read. */
export interface RailModel {
  readonly ticks: readonly RailTick[];
  readonly clip: RailClip;
}

/** What the caller knows about the window it handed in. */
export interface RailWindowInput {
  readonly rows: readonly TimelineRow[];
  /**
   * Whether rows exist before the window's head.
   *
   * Asked of the caller rather than inferred from the row count: only the thing
   * holding the cursor knows whether the head of the window is the head of the
   * session, and a rail that guessed would draw a dotted segment on a complete log
   * or hide one on a truncated one.
   */
  readonly hasEarlierRows: boolean;
}

/**
 * The rail's derivation over one loaded window.
 *
 * A class for the reason the chapter index is one: the model is read by the
 * painter, by the keyboard walk, and by the preview, and it is built once per
 * window identity. It owns a `LedgerSeamIndex` rather than building seams a second
 * way — the seam vocabulary has exactly one classifier.
 */
export class ProvenanceRailModel {
  readonly #input: RailWindowInput;
  readonly #seamIndex: LedgerSeamIndex;
  readonly #kindByWireType: ReadonlyMap<string, RailTickKind>;
  readonly #kindBySeamKind: ReadonlyMap<LedgerSeamKind, RailTickKind>;
  #model: RailModel | undefined;

  public constructor(input: RailWindowInput, seamIndex: LedgerSeamIndex = new LedgerSeamIndex()) {
    this.#input = input;
    this.#seamIndex = seamIndex;
    const kindByWireType = new Map<string, RailTickKind>();
    const kindBySeamKind = new Map<LedgerSeamKind, RailTickKind>();
    for (const kind of RAIL_TICK_KINDS) {
      const binding = RAIL_TICK_BINDINGS[kind];
      for (const wireType of binding.wireTypes) {
        kindByWireType.set(wireType, kind);
      }
      for (const seamKind of binding.seamKinds) {
        kindBySeamKind.set(seamKind, kind);
      }
    }
    this.#kindByWireType = kindByWireType;
    this.#kindBySeamKind = kindBySeamKind;
  }

  /** The ticks and the clip. Computed once, on first read. */
  public model(): RailModel {
    this.#model ??= this.#derive();
    return this.#model;
  }

  /**
   * The next tick of a kind after a sequence, or the previous one before it.
   *
   * The rail's keyboard offer. Returns `undefined` at the ends rather than wrapping:
   * a rail that wrapped would take a person from the last failure back to the
   * first one with nothing on screen saying it had.
   */
  public tickOfKind(
    kind: RailTickKind,
    fromSequence: number,
    direction: "next" | "previous",
  ): RailTick | undefined {
    const ticks = this.model().ticks.filter((tick) => tick.kind === kind);
    if (direction === "next") {
      return ticks.find((tick) => tick.sequence > fromSequence);
    }
    return [...ticks].reverse().find((tick) => tick.sequence < fromSequence);
  }

  /** The tick nearest a rail position, for a click or a drag. */
  public tickNearest(position: number): RailTick | undefined {
    let nearest: RailTick | undefined;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const tick of this.model().ticks) {
      const distance = Math.abs(tick.position - position);
      if (distance < nearestDistance) {
        nearest = tick;
        nearestDistance = distance;
      }
    }
    return nearest;
  }

  /** Seam wire types the contract does not register, forwarded from the one classifier. */
  public unregisteredWireTypes(): readonly string[] {
    return this.#seamIndex.unregisteredWireTypes();
  }

  #derive(): RailModel {
    const { rows, hasEarlierRows } = this.#input;
    const first = rows[0];
    const last = rows[rows.length - 1];
    const clip: RailClip = {
      hasUnloadedExtent: hasEarlierRows,
      earliestLoadedSequence: first?.sequence,
      latestLoadedSequence: last?.sequence,
    };
    const span = first === undefined || last === undefined ? 0 : last.sequence - first.sequence;

    const ticks: RailTick[] = [];
    for (const row of rows) {
      const kind = this.#tickKindOf(row);
      if (kind === undefined) {
        continue;
      }
      const binding = RAIL_TICK_BINDINGS[kind];
      ticks.push({
        kind,
        rowId: row.id,
        sequence: row.sequence,
        timestamp: row.timestamp,
        actorId: row.actor,
        tone: binding.tone,
        glyph: binding.glyph,
        summary: row.summary,
        // A single-row window is one tick at the tail rather than a division by
        // zero: the head and the tail are the same instant, and the tail is where
        // the live marker sits.
        position: span === 0 || first === undefined ? 1 : (row.sequence - first.sequence) / span,
      });
    }
    return { ticks, clip };
  }

  /**
   * Which tick a row makes, if any.
   *
   * Seams are asked FIRST and through the seam index, so a row that is both a seam
   * and a directly-bound type takes its seam reading — there is one classifier for
   * the seam vocabulary and this is a consumer of it, not a second one.
   */
  #tickKindOf(row: TimelineRow): RailTickKind | undefined {
    const seam = this.#seamIndex.classify(row);
    if (seam !== undefined) {
      const fromSeam = this.#kindBySeamKind.get(seam.kind);
      if (fromSeam !== undefined) {
        return fromSeam;
      }
    }
    return this.#kindByWireType.get(row.type);
  }
}

/**
 * Which tick kinds the rail can never draw today, because no wire type behind them
 * is registered.
 *
 * The rail's own half of the seam module's honesty: a legend that listed ten kinds
 * while the daemon can emit eight would be a legend that lies about the session.
 */
export function railTickKindsWithoutRegisteredWire(
  seamIndex: LedgerSeamIndex,
): readonly RailTickKind[] {
  return RAIL_TICK_KINDS.filter((kind) => {
    const binding = RAIL_TICK_BINDINGS[kind];
    const directTypes = binding.wireTypes;
    const seamTypes = binding.seamKinds.flatMap(
      (seamKind) => SEAM_WIRE_BINDINGS[seamKind].wireTypes,
    );
    const everyType = [...directTypes, ...seamTypes];
    return (
      everyType.length > 0 &&
      everyType.every((wireType) => !seamIndex.isRegisteredWireType(wireType))
    );
  });
}

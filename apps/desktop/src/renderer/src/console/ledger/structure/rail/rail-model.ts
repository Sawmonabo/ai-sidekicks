// The provenance rail's model — what the minimap knows about ONE window, with no DOM
// in it.
//
// `Spec-023 §The four bars`, Richness, names "a provenance rail that draws the
// session's shape" among the console's signature surfaces. WHAT THAT RAIL IS, is this
// module's decision, because no committed document states it: the scrollbar is
// replaced by a scrubbable minimap of the session's story. The component next door
// paints it and handles the pointer; everything a paint or a keypress needs to DECIDE
// lives here, so the rail's rules are driven by the `console-unit` tier rather than
// measured through a canvas.
//
// WHAT A MARK MAY BE is `rail-ticks.ts`' closed table, and WHERE ON THE RAIL anything
// sits is `rail-bands.ts`' one geometry. This module derives a rail from a window and
// answers the walks over it.
//
// TWO RULES THIS MODULE MAKES STRUCTURAL:
//
//   • **Clip honesty.** The rail draws only the loaded window and marks the
//     unloaded extent as a dotted segment. `RailClip` is a required member of the
//     model rather than an optional flag, so a rail cannot be built without
//     answering whether it is showing everything.
//   • **No invented ticks.** The rail never invents ticks for rows that are not
//     loaded. Every tick here is produced from a row in the window it was handed;
//     the unloaded extent is drawn as a segment, never as marks.

import type { TimelineRow } from "@ai-sidekicks/contracts";

import { type GlyphName } from "../../../tokens/index.js";
import { type FindStepDirection } from "../narrowing/find-model.js";
import { railRowBandCentre } from "./rail-bands.js";
import {
  RAIL_TICK_BINDINGS,
  RAIL_TICK_KINDS,
  type RailTickKind,
  type RailTickTone,
} from "./rail-ticks.js";
import { LedgerSeamIndex, type LedgerSeamKind } from "../seams/index.js";

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
  /**
   * Where along the rail this tick sits — the centre of its row's band, per the
   * row-band model above. Never an axis of its own.
   */
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
   * Every retained viewport row key, in the order the feed renders them.
   *
   * THE ORDERING IS THE RAIL'S AXIS, and it is asked of the caller because only the
   * viewport knows it. It is not `rows` re-keyed: the feed's list also carries rows
   * that are not projected log rows — a folded chapter's synthetic header is one —
   * and each of those occupies a band on the rail whether or not it can take a
   * mark. Handing the rail the rows alone made every header shift the marks away
   * from the thumb the same header had already shifted.
   *
   * Absent, the rows ARE the ordering, which is the caller asserting the feed
   * renders these rows and nothing between them. True of a window with no folded
   * chapter in it; false the moment one appears, which is why the composing hook
   * always supplies the viewport's own list.
   */
  readonly retainedRowKeys?: readonly string[];
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
    direction: FindStepDirection,
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
    const retainedRowKeys = this.#input.retainedRowKeys ?? rows.map((row) => row.id);
    const bandIndexByRowId = new Map(retainedRowKeys.map((key, index) => [key, index]));

    const ticks: RailTick[] = [];
    for (const row of rows) {
      const kind = this.#tickKindOf(row);
      const bandIndex = bandIndexByRowId.get(row.id);
      // No band, no mark. A row the feed is not rendering has nowhere on the rail
      // to be, and placing it anyway is how a mark ends up pointing at a row
      // nobody can scroll to.
      if (kind === undefined || bandIndex === undefined) {
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
        position: railRowBandCentre(bandIndex, retainedRowKeys.length),
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

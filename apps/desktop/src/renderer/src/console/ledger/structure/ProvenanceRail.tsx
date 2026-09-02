// The provenance rail — the scrollbar replaced by a map of the session's story.
//
// `Spec-023 §Console Design (Meridian)` §5.4. The model next door decides what the
// marks ARE; this file decides how they are painted, aimed at, and walked.
//
// WHY A CANVAS AND NOT ELEMENTS. §5.4 fixes it ("Own build on a canvas layer with
// a ≥32px hit strip and a dead gutter, our values"), and the reason survives
// inspection: a session's loaded window is thousands of rows, and one element per
// tick is thousands of layout boxes on the console's most-repainted surface. One
// canvas is one box.
//
// WHICH MAKES ACCESSIBILITY A DELIBERATE SECOND LAYER, not an afterthought. A
// canvas is opaque to assistive technology, so the rail is a `slider` — the ARIA
// pattern for a scrubber — carrying its own label, its position, and a
// `aria-valuetext` naming the tick under the cursor. Arrow keys walk ticks,
// `Home` / `End` reach the ends, and every offer §5.4 names is reachable without a
// pointer. The canvas is decoration under a control, which is what
// `aria-hidden` on it says.
//
// THE FISHEYE AND THE PREVIEW are pointer affordances and cost nothing when there
// is no pointer: the fisheye is a paint-time transform over the pointer offset the
// component already tracks, and the preview card is one nullable node, opened
// after a grace measured on the injected clock and never on a wall-clock timer.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { RealClock, type ConsoleClock } from "../../core/index.js";
import { Glyph } from "../../primitives/index.js";
import { tokenReference } from "../../tokens/index.js";
import {
  RAIL_FISHEYE_MAX_SCALE,
  RAIL_FISHEYE_RADIUS_PX,
  RAIL_HIT_STRIP_WIDTH_PX,
  RAIL_INK_WIDTH_PX,
  RAIL_MAX_TICKS_PER_PIXEL,
  RAIL_PREVIEW_GRACE_MS,
} from "./constants.js";
import {
  RAIL_TICK_KINDS,
  type ProvenanceRailModel,
  type RailTick,
  type RailTickKind,
} from "./rail-model.js";

export interface ProvenanceRailProps {
  /** The derivation. Built once per loaded window by the caller's `useMemo`. */
  readonly model: ProvenanceRailModel;
  /** Where the reading position is, 0 at the window's head and 1 at its tail. */
  readonly viewportPosition: number;
  /** How much of the window the viewport covers, as a fraction. */
  readonly viewportExtent: number;
  /** True while the ledger is following the tail, which draws the live marker. */
  readonly isFollowing: boolean;
  /** Jump through the ledger's scroll chokepoint. The rail never scrolls anything itself. */
  readonly onJumpToRow: (rowId: string) => void;
  /** Ask the ledger for rows before the window's head. */
  readonly onLoadEarlier: () => void;
  /** The clock the preview grace is measured on. The fixture's frozen clock in a story. */
  readonly clock?: ConsoleClock;
}

/** The one preview card open at a time, or none. */
interface RailPreview {
  readonly tick: RailTick;
  readonly offsetFraction: number;
}

export function ProvenanceRail(props: ProvenanceRailProps): React.JSX.Element {
  const { model, onJumpToRow, onLoadEarlier } = props;
  const railModel = model.model();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [pointerFraction, setPointerFraction] = useState<number | undefined>(undefined);
  const [preview, setPreview] = useState<RailPreview | undefined>(undefined);
  const [focusedSequence, setFocusedSequence] = useState<number | undefined>(undefined);

  // One clock for the life of the component. `useState`'s lazy initialiser rather
  // than a render-body `new`: a fresh clock every pass would leak an armed grace
  // timeout on each one.
  const [fallbackClock] = useState(() => new RealClock());
  const clock = props.clock ?? fallbackClock;

  const painter = useMemo(() => new RailPainter(), []);
  const graceRef = useRef<PreviewGrace | undefined>(undefined);
  graceRef.current ??= new PreviewGrace(clock);
  const grace = graceRef.current;

  useEffect(() => {
    return () => {
      grace.dispose();
    };
  }, [grace]);

  useEffect(() => {
    painter.paint(canvasRef.current, railModel.ticks, pointerFraction);
  }, [painter, railModel, pointerFraction]);

  const focusedTick = useMemo(
    () =>
      focusedSequence === undefined
        ? undefined
        : railModel.ticks.find((tick) => tick.sequence === focusedSequence),
    [railModel, focusedSequence],
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const bounds = event.currentTarget.getBoundingClientRect();
      // A zero-height strip is what a DOM shim reports; dividing by it would put
      // `Infinity` into the paint transform.
      const fraction = bounds.height === 0 ? 0 : (event.clientY - bounds.top) / bounds.height;
      setPointerFraction(fraction);
      const tick = model.tickNearest(fraction);
      grace.open(tick, fraction, setPreview);
    },
    [model, grace],
  );

  const handlePointerLeave = useCallback(() => {
    setPointerFraction(undefined);
    grace.close(setPreview);
  }, [grace]);

  const handleClick = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const bounds = event.currentTarget.getBoundingClientRect();
      const fraction = bounds.height === 0 ? 0 : (event.clientY - bounds.top) / bounds.height;
      const tick = model.tickNearest(fraction);
      if (tick !== undefined) {
        setFocusedSequence(tick.sequence);
        onJumpToRow(tick.rowId);
      }
    },
    [model, onJumpToRow],
  );

  const walkTo = useCallback(
    (tick: RailTick | undefined) => {
      if (tick === undefined) {
        return;
      }
      setFocusedSequence(tick.sequence);
      onJumpToRow(tick.rowId);
    },
    [onJumpToRow],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const ticks = railModel.ticks;
      const from = focusedSequence ?? -1;
      const walkKind = kindWalkedBy(event.key);
      if (walkKind !== undefined) {
        // Shift plus a digit walks one KIND, which is §5.4's "next / previous tick
        // of a kind" — the plain arrows walk every tick, because that is what a
        // person reaches for first.
        event.preventDefault();
        walkTo(model.tickOfKind(walkKind, from, event.shiftKey ? "previous" : "next"));
        return;
      }
      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          walkTo(ticks.find((tick) => tick.sequence > from));
          return;
        case "ArrowUp": {
          event.preventDefault();
          walkTo([...ticks].reverse().find((tick) => tick.sequence < from || from < 0));
          return;
        }
        case "Home":
          event.preventDefault();
          walkTo(ticks[0]);
          return;
        case "End":
          event.preventDefault();
          walkTo(ticks[ticks.length - 1]);
          return;
        default:
          return;
      }
    },
    [railModel, focusedSequence, model, walkTo],
  );

  return (
    <div className="meridian-rail" style={railStripStyle()}>
      <div
        className="meridian-rail__strip"
        role="slider"
        tabIndex={0}
        aria-label="Session provenance rail"
        aria-orientation="vertical"
        aria-valuemin={0}
        aria-valuemax={Math.max(0, railModel.ticks.length - 1)}
        aria-valuenow={focusedTick === undefined ? 0 : railModel.ticks.indexOf(focusedTick)}
        aria-valuetext={valueTextFor(focusedTick, railModel.ticks.length)}
        onPointerMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
      >
        <canvas ref={canvasRef} className="meridian-rail__canvas" aria-hidden="true" />
        {railModel.clip.hasUnloadedExtent ? (
          <span className="meridian-rail__unloaded" aria-hidden="true" />
        ) : null}
        <span
          className="meridian-rail__thumb"
          aria-hidden="true"
          style={thumbStyle(props.viewportPosition, props.viewportExtent)}
        />
        {props.isFollowing ? <span className="meridian-rail__live" aria-hidden="true" /> : null}
      </div>
      {railModel.clip.hasUnloadedExtent ? (
        <button type="button" className="meridian-rail__load-earlier" onClick={onLoadEarlier}>
          Load earlier
        </button>
      ) : null}
      {preview === undefined ? null : (
        <div
          className="meridian-rail__preview"
          role="status"
          style={previewStyle(preview.offsetFraction)}
        >
          <Glyph name={preview.tick.glyph} size={RAIL_PREVIEW_GLYPH_SIZE} />
          <span className="meridian-rail__preview-summary">{preview.tick.summary}</span>
        </div>
      )}
    </div>
  );
}

const RAIL_PREVIEW_GLYPH_SIZE = 12;

/**
 * Which tick kind a keypress walks.
 *
 * Digits 1 through 9 name the first nine kinds in declaration order. The mapping
 * is derived from `RAIL_TICK_KINDS` rather than written out, so a kind added to
 * that tuple is walkable without a second table being edited.
 */
function kindWalkedBy(key: string): RailTickKind | undefined {
  const digit = Number.parseInt(key, 10);
  if (!Number.isInteger(digit) || digit < 1) {
    return undefined;
  }
  return RAIL_TICK_KINDS[digit - 1];
}

/** What a screen reader hears at the rail's current position. */
function valueTextFor(tick: RailTick | undefined, tickCount: number): string {
  if (tick === undefined) {
    return tickCount === 0 ? "No marks on the rail" : "No mark selected";
  }
  return `${tick.kind}: ${tick.summary}`;
}

/** The hit strip and the ink inside it, as `Spec-023` fixes both. */
function railStripStyle(): React.CSSProperties {
  return { width: `${String(RAIL_HIT_STRIP_WIDTH_PX)}px` };
}

function thumbStyle(position: number, extent: number): React.CSSProperties {
  return {
    top: `${String(Math.min(100, Math.max(0, position * 100)))}%`,
    height: `${String(Math.min(100, Math.max(1, extent * 100)))}%`,
  };
}

function previewStyle(offsetFraction: number): React.CSSProperties {
  return { top: `${String(Math.min(100, Math.max(0, offsetFraction * 100)))}%` };
}

/**
 * The grace before a preview card opens.
 *
 * A class holding the one armed handle, so a pointer crossing the rail arms and
 * cancels rather than opening a card per tick — and so the component's unmount has
 * exactly one thing to cancel. §5.4's "no debounce on the read" is why the tick is
 * captured at `open` time and not re-read when the timeout fires.
 */
class PreviewGrace {
  readonly #clock: ConsoleClock;
  #armedHandle: number | undefined;

  public constructor(clock: ConsoleClock) {
    this.#clock = clock;
  }

  public open(
    tick: RailTick | undefined,
    offsetFraction: number,
    show: (preview: RailPreview | undefined) => void,
  ): void {
    this.#cancel();
    if (tick === undefined) {
      show(undefined);
      return;
    }
    this.#armedHandle = this.#clock.scheduleTimeout(() => {
      this.#armedHandle = undefined;
      show({ tick, offsetFraction });
    }, RAIL_PREVIEW_GRACE_MS);
  }

  public close(show: (preview: RailPreview | undefined) => void): void {
    this.#cancel();
    show(undefined);
  }

  public dispose(): void {
    this.#cancel();
  }

  #cancel(): void {
    if (this.#armedHandle !== undefined) {
      this.#clock.cancel(this.#armedHandle);
      this.#armedHandle = undefined;
    }
  }
}

/**
 * The canvas painter.
 *
 * A class so the 2D context is resolved once per canvas rather than per paint, and
 * so a host with no canvas implementation — a DOM shim, a print preview — is a
 * no-op rather than a crash. The rail stays operable there: the slider, the
 * keyboard walk, the preview, and the "load earlier" affordance are all DOM.
 */
class RailPainter {
  #context: CanvasRenderingContext2D | undefined;
  #canvas: HTMLCanvasElement | undefined;

  public paint(
    canvas: HTMLCanvasElement | null,
    ticks: readonly RailTick[],
    pointerFraction: number | undefined,
  ): void {
    if (canvas === null) {
      return;
    }
    const context = this.#contextFor(canvas);
    if (context === undefined) {
      return;
    }
    const width = canvas.width;
    const height = canvas.height;
    context.clearRect(0, 0, width, height);
    // Marks folded into the column they would have overdrawn, never dropped:
    // `RAIL_MAX_TICKS_PER_PIXEL` is a PAINTING bound, so a window denser than the
    // rail is tall paints one mark per column instead of stacking hundreds of
    // identical `fillRect` calls on the same row of pixels. The model still holds
    // every tick, which is what the keyboard walk and the preview read.
    const paintedPerColumn = new Map<number, number>();
    for (const tick of ticks) {
      const y = tick.position * height;
      const column = Math.round(y);
      const alreadyPainted = paintedPerColumn.get(column) ?? 0;
      if (alreadyPainted >= RAIL_MAX_TICKS_PER_PIXEL) {
        continue;
      }
      paintedPerColumn.set(column, alreadyPainted + 1);
      const scale = fisheyeScale(
        y,
        pointerFraction === undefined ? undefined : pointerFraction * height,
      );
      context.fillStyle = TICK_TONE_FILL[tick.tone];
      context.fillRect(0, y - scale / 2, RAIL_INK_WIDTH_PX, Math.max(1, scale));
    }
  }

  #contextFor(canvas: HTMLCanvasElement): CanvasRenderingContext2D | undefined {
    if (this.#canvas !== canvas) {
      this.#canvas = canvas;
      // `?? undefined` because a DOM shim answers `null`, which is a real answer:
      // this host cannot paint, and the rail's DOM layer carries the surface.
      this.#context = canvas.getContext("2d") ?? undefined;
    }
    return this.#context;
  }
}

/**
 * The fisheye. One tick's drawn height, given how far it sits from the pointer.
 *
 * Linear falloff over `RAIL_FISHEYE_RADIUS_PX`: a smooth curve reads better in
 * isolation and worse in motion, because the magnified band's edge stops being
 * findable. With no pointer every tick is its base height.
 */
function fisheyeScale(tickY: number, pointerY: number | undefined): number {
  if (pointerY === undefined) {
    return RAIL_TICK_BASE_HEIGHT_PX;
  }
  const distance = Math.abs(tickY - pointerY);
  if (distance >= RAIL_FISHEYE_RADIUS_PX) {
    return RAIL_TICK_BASE_HEIGHT_PX;
  }
  const nearness = 1 - distance / RAIL_FISHEYE_RADIUS_PX;
  return RAIL_TICK_BASE_HEIGHT_PX * (1 + nearness * (RAIL_FISHEYE_MAX_SCALE - 1));
}

/** A tick's height at rest, in CSS pixels. Two pixels is one ledger line's worth of ink. */
const RAIL_TICK_BASE_HEIGHT_PX = 2;

/**
 * What each tone paints with.
 *
 * Token references through `tokenReference` rather than literal `var(...)`
 * strings, so the rail follows the scheme attribute like every other surface and
 * the token names are the palette's own rather than a second spelling of them.
 * `amber-mark` and `red-mark` are the two rationed marks rule 3 fixes; `actor`
 * takes the neutral muted token and is re-tinted by the caller's hue where the
 * session's allocation is known — the painter never invents a hue.
 */
const TICK_TONE_FILL: Readonly<Record<RailTick["tone"], string>> = {
  actor: tokenReference("text-muted"),
  attention: tokenReference("amber-mark"),
  failure: tokenReference("red-mark"),
};

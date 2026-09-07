// The provenance rail — the scrollbar replaced by a map of the session's story.
//
// `Spec-023 §The four bars`, Richness, names it; `rail-model.ts` says what it is. Three
// files, three answers: the
// model next door decides what the marks ARE, `rail-painter.ts` decides where
// their ink lands, and this file is the control around both — the hit strip, the
// pointer, and the keyboard walk.
//
// WHY A CANVAS AND NOT ELEMENTS. `rail-model.ts` fixes it — an own build on a canvas
// layer with a ≥32px hit strip and a dead gutter — and the reason survives
// inspection: a session's loaded window is thousands of rows, and one element per
// tick is thousands of layout boxes on the console's most-repainted surface. One
// canvas is one box.
//
// WHICH MAKES ACCESSIBILITY A DELIBERATE SECOND LAYER, not an afterthought. A
// canvas is opaque to assistive technology, so the rail is a `slider` — the ARIA
// pattern for a scrubber — carrying its own label, its position, and a
// `aria-valuetext` naming the tick under the cursor. Arrow keys walk ticks,
// `Home` / `End` reach the ends, and every offer the rail makes is reachable without a
// pointer. The canvas is decoration under a control, which is what
// `aria-hidden` on it says.
//
// THE CANVAS IS SIZED BY ITS OWN BOX, NOT BY ITS DEFAULT. `rail-surface.ts` watches
// the rendered box and the host's device pixel ratio and publishes a revision the
// paint effect depends on, so the backing store follows the strip through a window
// resize and a move to a second display — event-driven both times, because a rail
// that is static at rest must not hold a frame loop open to notice.
//
// THE FISHEYE AND THE PREVIEW are pointer affordances and cost nothing when there
// is no pointer: the fisheye is a paint-time transform over the pointer offset the
// component already tracks, and the preview card is one nullable node, opened
// after a grace measured on the injected clock and never on a wall-clock timer.
//
// THE SELECTION IS A MARK, NEVER A SEQUENCE — one rule, and every read obeys it.
// A press records which sequence was chosen, but the SELECTION is the tick that
// sequence resolves to in the model on screen now, and a sequence the model no
// longer holds selects nothing. The slider's value, its announced text, and the
// origin of every walk all read that one resolution, so the rail cannot announce
// one thing and walk from another.
//
// THE DRAG IS ONE GESTURE AND THE CLICK AFTER IT IS PART OF IT. Press, scrub and
// release live in `rail-scrub.ts`, which reports a mark only when the drag crosses
// onto a new one and consumes the click the browser synthesizes on release — so a
// scrub is one continuous movement through the ledger's single scroll writer rather
// than a write per pointer event, and a press does not jump twice.
//
// The rail deliberately does NOT slide the selection onto a neighbouring mark when
// the one a person chose is withheld by replay, dropped by a filter, or taken by
// the cap. It says the mark is gone, which is information, and the next press then
// walks from the rail's head exactly as a first press does. The recorded sequence
// is kept rather than cleared, so a model that admits that mark again — a replay
// scrubbed back forward — re-selects the person's OWN mark rather than a
// substitute.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { type ConsoleClock } from "../../../core/index.js";
import { Glyph } from "../../../primitives/index.js";
import { GLYPH_SIZE_ROW } from "../../../tokens/index.js";
import { RAIL_HIT_STRIP_WIDTH_PX } from "../structure-bounds.js";
import { clampRailViewportBand } from "./rail-bands.js";
import { railKeyboardWalk } from "./rail-keyboard-walk.js";
import { type ProvenanceRailModel, type RailTick } from "./rail-model.js";
import { RailPainter, type RailActorHueLookup } from "./rail-painter.js";
import { PreviewGrace, type RailPreview } from "./rail-preview.js";
import { RailScrub } from "./rail-scrub.js";
import { useRailSurfaceRevision } from "./rail-surface.js";

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
  /**
   * Ask the ledger for rows before the window's head.
   *
   * Optional, because no registered read pages a session's log backwards today: a
   * caller with nothing to call supplies nothing and no button is drawn. The
   * dotted segment does NOT depend on it — the clip is a fact about the window and
   * clip honesty requires it drawn whether or not anybody can act on it.
   */
  readonly onLoadEarlier?: () => void;
  /**
   * The session's hue allocation, for the marks that take the actor's hue.
   *
   * Optional because the rail is mountable over a window that holds no allocation,
   * and every actor tick then takes the neutral tone rather than a colour this
   * component invented. The lookup itself is the store's — `assignmentFor` reads
   * without allocating, so asking about a participant the wheel has not admitted
   * cannot mint one.
   */
  readonly hueForActor?: RailActorHueLookup;
  /**
   * The clock the preview grace is measured on — the window's, from
   * `useConsoleClock`, and the fixture's frozen clock in a story.
   *
   * REQUIRED, with no fallback. A rail that minted its own `RealClock` when none
   * arrived ran a second time base inside a window whose every other surface was on
   * the scenario's frozen one, and armed a grace no fixture advance could reach —
   * silently, because a card that never opens looks like a pointer that never
   * settled. There is one clock per window and this is how the rail is handed it.
   */
  readonly clock: ConsoleClock;
}

export function ProvenanceRail(props: ProvenanceRailProps): React.JSX.Element {
  const { model, onJumpToRow, onLoadEarlier } = props;
  const railModel = model.model();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [pointerFraction, setPointerFraction] = useState<number | undefined>(undefined);
  const [preview, setPreview] = useState<RailPreview | undefined>(undefined);
  const [focusedSequence, setFocusedSequence] = useState<number | undefined>(undefined);

  const clock = props.clock;

  const painter = useMemo(() => new RailPainter(), []);
  // The canvas's backing store follows its RENDERED box, and the box changes with
  // the window, the deck, and the display the window sits on. The revision is what
  // carries those two events into the paint effect below; the measurement itself is
  // the painter's, off the canvas it was handed, so there is only ever one.
  const surfaceRevision = useRailSurfaceRevision(canvasRef);
  // ONE GRACE FOR THE LIFE OF THE MOUNT, and the clock it captures is a forwarder
  // rather than a bridge. `useConsoleClock` answers with one stable object per
  // window that forwards every arm and cancel to whichever bridge is current, so a
  // reference taken at construction stays live across a reconnect or a scenario
  // switch. Never assume the console clock is fixed to a bridge: the rule is that
  // the OBJECT is stable and the bridge behind it is not, which is what makes
  // capturing it once correct and a local forwarding wrapper a second answer to a
  // question already settled one layer down.
  const graceRef = useRef<PreviewGrace | undefined>(undefined);
  graceRef.current ??= new PreviewGrace(clock);
  const grace = graceRef.current;

  useEffect(() => {
    return () => {
      grace.dispose();
    };
  }, [grace]);

  // ONE GESTURE PER MOUNT, on the grace's terms: a drag is state that must not
  // render, and a ref is how this component already holds such state.
  const scrubRef = useRef<RailScrub | undefined>(undefined);
  scrubRef.current ??= new RailScrub();
  const scrub = scrubRef.current;

  const hueForActor = props.hueForActor;
  useEffect(() => {
    painter.paint(canvasRef.current, {
      ticks: railModel.ticks,
      pointerFraction,
      ...(hueForActor === undefined ? {} : { actorHue: hueForActor }),
    });
  }, [painter, railModel, pointerFraction, surfaceRevision, hueForActor]);

  const focusedTick = useMemo(
    () =>
      focusedSequence === undefined
        ? undefined
        : railModel.ticks.find((tick) => tick.sequence === focusedSequence),
    [railModel, focusedSequence],
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

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const fraction = strippedFraction(event);
      setPointerFraction(fraction);
      const tick = model.tickNearest(fraction);
      grace.open(tick, fraction, setPreview);
      // The scrub reports a mark only when the drag crosses onto a new one, so a
      // held pointer moving through a mark's neighbourhood queues one write and not
      // one per pointer event.
      walkTo(scrub.crossedTo(tick));
    },
    [model, grace, scrub, walkTo],
  );

  const handlePointerLeave = useCallback(() => {
    setPointerFraction(undefined);
    grace.close(setPreview);
  }, [grace]);

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      // The PRIMARY button only. A secondary or middle press opens a context menu or
      // an auxiliary act on every platform, and adopting one would scrub the ledger
      // out from under the menu the person is about to read.
      if (event.button !== 0 || !scrub.begin(event.pointerId)) {
        return;
      }
      // CAPTURE, so the gesture survives the pointer leaving the 56px strip. Without
      // it a scrub ends the moment the hand drifts sideways, which is most of them.
      // Guarded because a DOM shim implements the pointer-capture pair as a throw.
      event.currentTarget.setPointerCapture?.(event.pointerId);
      walkTo(scrub.crossedTo(model.tickNearest(strippedFraction(event))));
    },
    [model, scrub, walkTo],
  );

  const handlePointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      scrub.end(event.pointerId);
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    },
    [scrub],
  );

  const handlePointerCancel = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      scrub.cancel(event.pointerId);
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    },
    [scrub],
  );

  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      // The click a completed press synthesizes is that gesture's second delivery of
      // one mark, so it is consumed. A click with no press before it — synthetic, or
      // an assistive tool's — still jumps.
      if (scrub.takeSynthesizedClick()) {
        return;
      }
      walkTo(model.tickNearest(strippedFraction(event)));
    },
    [model, scrub, walkTo],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      // The RESOLVED tick's sequence, never the recorded one — see this file's
      // header — handed to the walk next door, which owns the key table.
      const walk = railKeyboardWalk(
        { key: event.key, code: event.code, shiftKey: event.shiftKey },
        railModel.ticks,
        model,
        focusedTick?.sequence,
      );
      if (!walk.claimed) {
        return;
      }
      // Claimed and moved nowhere is still claimed: the page must not scroll under
      // a walk that has reached the end of the rail.
      event.preventDefault();
      walkTo(walk.tick);
    },
    [railModel, focusedTick, model, walkTo],
  );

  return (
    <div className="meridian-provenance-rail" style={railStripStyle()}>
      <div
        className="meridian-provenance-rail__strip"
        role="slider"
        tabIndex={0}
        aria-label="Session provenance rail"
        aria-orientation="vertical"
        aria-valuemin={0}
        aria-valuemax={Math.max(0, railModel.ticks.length - 1)}
        // The RESOLVED tick's place, and the range's floor when nothing is selected —
        // `aria-valuenow` is required of a slider and cannot be absent, so the
        // `aria-valuetext` beside it is what actually says whether a mark is selected.
        aria-valuenow={focusedTick === undefined ? 0 : railModel.ticks.indexOf(focusedTick)}
        aria-valuetext={valueTextFor(focusedTick, railModel.ticks.length)}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onPointerLeave={handlePointerLeave}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
      >
        <canvas ref={canvasRef} className="meridian-provenance-rail__canvas" aria-hidden="true" />
        {railModel.clip.hasUnloadedExtent ? (
          <span className="meridian-provenance-rail__unloaded" aria-hidden="true" />
        ) : null}
        <span
          className="meridian-provenance-rail__thumb"
          aria-hidden="true"
          style={thumbStyle(props.viewportPosition, props.viewportExtent)}
        />
        {props.isFollowing ? (
          <span className="meridian-provenance-rail__live" aria-hidden="true" />
        ) : null}
      </div>
      {railModel.clip.hasUnloadedExtent && onLoadEarlier !== undefined ? (
        <button
          type="button"
          className="meridian-provenance-rail__load-earlier"
          onClick={onLoadEarlier}
        >
          Load earlier
        </button>
      ) : null}
      {preview === undefined ? null : (
        <div
          className="meridian-provenance-rail__preview"
          role="status"
          style={previewStyle(preview.offsetFraction)}
        >
          <Glyph name={preview.tick.glyph} size={GLYPH_SIZE_ROW} />
          <span className="meridian-provenance-rail__preview-summary">{preview.tick.summary}</span>
        </div>
      )}
    </div>
  );
}

/**
 * Where a pointer sits on the strip, as a fraction of its height.
 *
 * One reader for the four handlers that need it. A zero-height strip is what a DOM
 * shim reports; dividing by it would put `Infinity` into the paint transform.
 */
function strippedFraction(event: React.MouseEvent<HTMLDivElement>): number {
  const bounds = event.currentTarget.getBoundingClientRect();
  return bounds.height === 0 ? 0 : (event.clientY - bounds.top) / bounds.height;
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

/**
 * The viewport thumb, clamped ONCE.
 *
 * The top and the height are not independent — a top clamped into `[0, 1]` beside a
 * height clamped into `[0, 1]` admits `0.909 + 0.1`, a thumb hanging over the
 * rail's foot — so the pair goes through `clampRailViewportBand`, which settles the
 * height and then takes the top against `1 - extent`. The props are clamped rather
 * than trusted because a band arriving from a caller is not necessarily one the
 * rail model built.
 */
function thumbStyle(position: number, extent: number): React.CSSProperties {
  const band = clampRailViewportBand({ position, extent });
  return { top: railPercent(band.position), height: railPercent(band.extent) };
}

function previewStyle(offsetFraction: number): React.CSSProperties {
  return { top: railPercent(Math.min(1, Math.max(0, offsetFraction))) };
}

/**
 * A fraction of the rail as a CSS percentage.
 *
 * Rounded to `RAIL_PERCENT_FRACTION_DIGITS` rather than printed raw: binary doubles
 * make `0.9 * 100` read `90.00000000000001`, and a top and a height that should sum
 * to exactly the rail's length would instead sum to a hair over it and to a string
 * nobody reviewing a computed style can read. Back through `Number` so the rounding
 * does not also pad — a whole percentage stays `100%` rather than becoming
 * `100.0000%`.
 */
function railPercent(fraction: number): string {
  return `${String(Number((fraction * 100).toFixed(RAIL_PERCENT_FRACTION_DIGITS)))}%`;
}

/**
 * Decimal places a rail percentage keeps. Four is under a thousandth of a 600px
 * rail — below the device pixel on any display — and short enough to read.
 */
const RAIL_PERCENT_FRACTION_DIGITS = 4;

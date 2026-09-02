// The rail's painter — where the ink lands, as geometry with no React in it.
//
// `Spec-023 §Console Design (Meridian)` §5.4 fixes the surface ("Own build on a
// canvas layer with a ≥32px hit strip and a dead gutter, our values"), and the
// component next door owns that strip, its pointer, and its keyboard walk. What
// gets DRAWN on the canvas is decided here.
//
// WHY IT IS ITS OWN MODULE, and not a private class inside the component. Nothing
// below touches React or the DOM beyond the canvas handle it is passed, so the
// fisheye's falloff, the per-column paint bound, and the tone table are drivable
// by the `console-unit` tier against a stub context rather than through a rendered
// component and a canvas the test environment may not implement — the same reason
// `rail-model.ts` sits beside the component instead of inside it. Keeping the two
// apart also keeps them honest: a file that both paints and handles pointers can
// let a paint-time decision drift into an interaction-time one without anybody
// noticing which of the two owns it.
//
// A HOST THAT CANNOT PAINT IS NOT A FAILURE. `getContext("2d")` answers `null` on
// a DOM shim and in a print preview, and that is a real answer rather than an
// error: the rail's slider, its keyboard walk, its preview card, and its "load
// earlier" affordance are all DOM, so the surface stays fully operable with no ink
// on it at all.
//
// THE BACKING STORE IS SIZED HERE, EVERY PAINT. A canvas nobody sizes carries the
// 300x150 default bitmap while CSS stretches it over the rail's full height, so
// every mark is scaled by that ratio and resampled — a two-pixel tick drawn five
// pixels tall and blurred, and a fisheye radius measured in the wrong pixels. So
// the store is sized from the RENDERED box times the device pixel ratio, the
// context is scaled by that ratio exactly once, and every measurement below is
// then in CSS pixels — the same units `constants.ts` states the ink width and the
// fisheye radius in. `rail-surface.ts` is what tells the component that the box or
// the ratio moved; nothing here polls, and there is no frame loop at rest.

import { tokenReference } from "../../tokens/index.js";
import {
  RAIL_FISHEYE_MAX_SCALE,
  RAIL_FISHEYE_RADIUS_PX,
  RAIL_INK_WIDTH_PX,
  RAIL_MAX_TICKS_PER_PIXEL,
} from "./constants.js";
import { hostDevicePixelRatio } from "./rail-surface.js";
import { type RailTick } from "./rail-model.js";

/**
 * The canvas painter.
 *
 * A class so the 2D context is resolved once per canvas rather than per paint, and
 * so a host with no canvas implementation — a DOM shim, a print preview — is a
 * no-op rather than a crash. The rail stays operable there: the slider, the
 * keyboard walk, the preview, and the "load earlier" affordance are all DOM.
 */
export class RailPainter {
  #context: CanvasRenderingContext2D | undefined;
  #canvas: HTMLCanvasElement | undefined;
  readonly #readDevicePixelRatio: () => number;

  /**
   * @param options.readDevicePixelRatio - how the painter learns the host's pixel
   *   density. Injected so the unit tier can drive a two-times display, and shared
   *   with the surface watch by default so the store cannot be sized for one ratio
   *   while the watch listens for another.
   */
  public constructor(options: { readonly readDevicePixelRatio?: () => number } = {}) {
    this.#readDevicePixelRatio = options.readDevicePixelRatio ?? hostDevicePixelRatio;
  }

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
    const surface = this.#synchroniseBackingStore(canvas, context);
    if (surface === undefined) {
      // Nothing has been laid out yet — a rail inside a collapsed pane, or a host
      // whose rects are all zero. Painting into a store with no extent would put
      // every tick at y=0; leaving the canvas alone means the first real layout
      // repaints it through the surface watch.
      return;
    }
    const { width, height } = surface;
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

  /**
   * Match the backing store to the rendered box, and return that box in CSS pixels.
   *
   * `undefined` where the element has no rendered extent. Assigning `width` or
   * `height` RESETS the whole context — transform included — so the transform is
   * set after the sizing rather than once at construction, and `setTransform`
   * rather than `scale` because `scale` compounds and a second paint would then
   * draw at the square of the ratio.
   */
  #synchroniseBackingStore(
    canvas: HTMLCanvasElement,
    context: CanvasRenderingContext2D,
  ): { readonly width: number; readonly height: number } | undefined {
    const rendered = canvas.getBoundingClientRect();
    if (rendered.width <= 0 || rendered.height <= 0) {
      return undefined;
    }
    const ratio = this.#readDevicePixelRatio();
    const backingWidth = Math.max(1, Math.round(rendered.width * ratio));
    const backingHeight = Math.max(1, Math.round(rendered.height * ratio));
    if (canvas.width !== backingWidth) {
      canvas.width = backingWidth;
    }
    if (canvas.height !== backingHeight) {
      canvas.height = backingHeight;
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    return { width: rendered.width, height: rendered.height };
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

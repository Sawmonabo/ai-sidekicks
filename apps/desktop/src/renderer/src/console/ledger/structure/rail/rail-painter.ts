// The rail's painter — where the ink lands, as geometry with no React in it.
//
// `rail-model.ts` fixes the surface — an own build on a canvas layer with a ≥32px hit
// strip and a dead gutter — and the
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
// A TICK'S COLOUR IS A VALUE, NEVER A CUSTOM-PROPERTY REFERENCE. A canvas parses
// CSS colours and nothing else: `var(--meridian-text-muted)` is not a colour, so
// assigning one leaves `fillStyle` at whatever it was and the rail paints in the
// context's default ink. So every fill here is resolved to a real colour before it
// is assigned — the cascade's own computed value where a sheet is installed, and
// the palette's value where none is (a DOM shim, a print preview), which is the
// same table the sheet is GENERATED from and so cannot drift from it.
//
// AND AN ACTOR TICK TAKES ITS ACTOR'S HUE. `rail-model.ts`'s second rule: only failures
// are red, and every other tick takes the actor's hue at low
// chroma. The hue is the session's own allocation, handed in by the caller that
// holds it — the painter looks nothing up and invents nothing, so a tick whose
// participant the wheel has never admitted takes the neutral tone rather than
// somebody else's colour.
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

import { RAIL_FISHEYE_MAX_SCALE, RAIL_MAX_TICKS_PER_PIXEL } from "../../../core/index.js";
import {
  SCHEME_COLOR_TOKENS,
  formatOklch,
  tokenVariableName,
  type ParticipantHueAssignment,
} from "../../../tokens/index.js";
import { RAIL_FISHEYE_RADIUS_PX, RAIL_INK_WIDTH_PX } from "../structure-bounds.js";
import { hostDevicePixelRatio } from "./rail-surface.js";
import { type RailTick } from "./rail-model.js";
import { type RailTickTone } from "./rail-ticks.js";

/**
 * Where an actor tick's colour comes from.
 *
 * The session's hue allocation, read through the caller that owns it —
 * `ParticipantHueAllocator.assignmentFor` is exactly this shape, and its read is
 * side-effect free, which is what makes an unknown participant an absence here
 * rather than a newly minted identity.
 */
export type RailActorHueLookup = (participantId: string) => ParticipantHueAssignment | undefined;

/** Everything one paint is decided from. */
export interface RailPaintInput {
  readonly ticks: readonly RailTick[];
  /** Where the pointer sits over the strip, or `undefined` when there is none. */
  readonly pointerFraction: number | undefined;
  /**
   * The session's hue allocation. Absent where the caller holds none, and every
   * actor tick then takes the neutral tone — an absence, not a default colour.
   */
  readonly actorHue?: RailActorHueLookup;
}

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

  public paint(canvas: HTMLCanvasElement | null, input: RailPaintInput): void {
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
    // One cascade read per paint rather than one per tick: the three tone values
    // are the same for every mark in the pass, and a read per tick would force a
    // style recalculation for each of them on the console's busiest surface.
    const toneFills = resolveToneFills(canvas);
    // Marks folded into the column they would have overdrawn, never dropped:
    // `RAIL_MAX_TICKS_PER_PIXEL` is a PAINTING bound, so a window denser than the
    // rail is tall paints one mark per column instead of stacking hundreds of
    // identical `fillRect` calls on the same row of pixels. The model still holds
    // every tick, which is what the keyboard walk and the preview read.
    const paintedPerColumn = new Map<number, number>();
    for (const tick of input.ticks) {
      const y = tick.position * height;
      const column = Math.round(y);
      const alreadyPainted = paintedPerColumn.get(column) ?? 0;
      if (alreadyPainted >= RAIL_MAX_TICKS_PER_PIXEL) {
        continue;
      }
      paintedPerColumn.set(column, alreadyPainted + 1);
      const scale = fisheyeScale(
        y,
        input.pointerFraction === undefined ? undefined : input.pointerFraction * height,
      );
      const fill = fillForTick(tick, toneFills, input.actorHue);
      if (fill === undefined) {
        // A tone whose token the palette no longer defines. The mark is left
        // unpainted rather than drawn in invented ink — the slider, the keyboard
        // walk, and the preview still carry it, which is the layer that answers.
        continue;
      }
      context.fillStyle = fill;
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
 * Which token each tone paints with.
 *
 * `amber-mark` and `red-mark` are the two rationed marks rule 3 fixes; `actor`
 * names the neutral muted token, which is what an actor tick takes when the
 * session's allocation does not know its participant. The names are the palette's
 * own rather than a second spelling of them.
 */
const TICK_TONE_TOKEN_NAMES: Readonly<Record<RailTickTone, string>> = {
  actor: "text-muted",
  attention: "amber-mark",
  failure: "red-mark",
};

/**
 * How much of a participant's chroma an actor tick keeps.
 *
 * The actor's hue at low chroma: the rail is a map read at a glance, and
 * a column of fully saturated marks beside the two rationed ones would make hue
 * compete with the attention channel rule 3 reserves. Lightness and hue angle are
 * untouched, so the mark stays the participant's colour rather than becoming a
 * different one.
 */
const RAIL_ACTOR_TICK_CHROMA_SCALE = 0.45;

/** What one tick paints with, or `undefined` where no colour could be resolved. */
function fillForTick(
  tick: RailTick,
  toneFills: Readonly<Record<RailTickTone, string | undefined>>,
  actorHue: RailActorHueLookup | undefined,
): string | undefined {
  if (tick.tone !== "actor" || tick.actorId === undefined || actorHue === undefined) {
    return toneFills[tick.tone];
  }
  const assignment = actorHue(tick.actorId);
  if (assignment === undefined) {
    // A participant the wheel has never admitted. The neutral tone is the honest
    // answer: minting a hue here would give one person two colours across the
    // console, since the cast bar reads the same allocation.
    return toneFills.actor;
  }
  return formatOklch({
    ...assignment.color,
    chroma: assignment.color.chroma * RAIL_ACTOR_TICK_CHROMA_SCALE,
  });
}

/**
 * The three tone colours, resolved against this canvas.
 *
 * The cascade first, because it is what the rest of the console paints with and it
 * answers for whichever scheme is live — including the `system` preference, which
 * sets no attribute at all and is resolved by the sheet's own media query. The
 * palette's value stands in where no sheet is installed; it is the table the sheet
 * is generated from, so the stand-in cannot disagree with what a browser would
 * have computed for the light scheme.
 */
function resolveToneFills(
  canvas: HTMLCanvasElement,
): Readonly<Record<RailTickTone, string | undefined>> {
  const computed = computedStyleOf(canvas);
  const resolve = (tokenName: string): string | undefined => {
    const declared = computed?.getPropertyValue(tokenVariableName(tokenName)).trim();
    if (declared !== undefined && declared.length > 0) {
      return declared;
    }
    const pair = SCHEME_COLOR_TOKENS.get(tokenName);
    return pair === undefined ? undefined : formatOklch(pair.light);
  };
  return {
    actor: resolve(TICK_TONE_TOKEN_NAMES.actor),
    attention: resolve(TICK_TONE_TOKEN_NAMES.attention),
    failure: resolve(TICK_TONE_TOKEN_NAMES.failure),
  };
}

/** The host's computed style for an element, where the host computes styles at all. */
function computedStyleOf(element: HTMLCanvasElement): CSSStyleDeclaration | undefined {
  const styleHost = globalThis as {
    readonly getComputedStyle?: (target: Element) => CSSStyleDeclaration;
  };
  return styleHost.getComputedStyle?.(element);
}

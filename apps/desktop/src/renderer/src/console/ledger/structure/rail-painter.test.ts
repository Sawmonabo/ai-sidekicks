// The painter, driven against a canvas the unit tier can hold.
//
// Nothing here renders: the painter takes a canvas handle and a 2D context and
// nothing else, which is what lets these cases assert the geometry a browser tier
// would have to measure. The stub records every drawing call, so the assertions are
// about what was DRAWN rather than about what was returned.

import { describe, expect, it } from "vitest";

import { RailPainter } from "./rail-painter.js";
import { type RailTick } from "./rail-model.js";

/** One drawing call, in the order the painter made it. */
interface RecordedFill {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly fillStyle: string;
}

interface RecordedTransform {
  readonly horizontalScale: number;
  readonly verticalScale: number;
}

/** A canvas the painter can size, and a context that records what lands on it. */
interface StubCanvas {
  readonly canvas: HTMLCanvasElement;
  readonly fills: readonly RecordedFill[];
  readonly clears: readonly RecordedFill[];
  readonly transforms: readonly RecordedTransform[];
}

function stubCanvas(box: { readonly width: number; readonly height: number }): StubCanvas {
  const fills: RecordedFill[] = [];
  const clears: RecordedFill[] = [];
  const transforms: RecordedTransform[] = [];
  const context = {
    fillStyle: "",
    clearRect: (x: number, y: number, width: number, height: number): void => {
      clears.push({ x, y, width, height, fillStyle: String(context.fillStyle) });
    },
    fillRect: (x: number, y: number, width: number, height: number): void => {
      fills.push({ x, y, width, height, fillStyle: String(context.fillStyle) });
    },
    setTransform: (
      horizontalScale: number,
      _b: number,
      _c: number,
      verticalScale: number,
    ): void => {
      transforms.push({ horizontalScale, verticalScale });
    },
  };
  const canvas = {
    width: 300,
    height: 150,
    getBoundingClientRect: () => ({ width: box.width, height: box.height }) as DOMRect,
    getContext: () => context as unknown as CanvasRenderingContext2D,
  };
  return {
    canvas: canvas as unknown as HTMLCanvasElement,
    fills,
    clears,
    transforms,
  };
}

function tickAt(position: number, tone: RailTick["tone"] = "actor"): RailTick {
  return {
    kind: "participant-message",
    rowId: `row-${String(position)}`,
    sequence: Math.round(position * 100),
    timestamp: "2026-09-02T10:00:00.000Z",
    actorId: "participant-1",
    tone,
    glyph: "member",
    summary: "a line somebody wrote",
    position,
  };
}

describe("rail painter — the backing store follows the rendered box", () => {
  it("sizes the bitmap from the box rather than leaving the default", () => {
    // 300x150 is the canvas default, and the rail's own box is nothing like it:
    // a 32px strip down a tall pane. Left alone, every mark is drawn into that
    // default and then stretched by CSS.
    const surface = stubCanvas({ width: 32, height: 800 });
    new RailPainter({ readDevicePixelRatio: () => 1 }).paint(
      surface.canvas,
      [tickAt(0.5)],
      undefined,
    );
    expect(surface.canvas.width).toBe(32);
    expect(surface.canvas.height).toBe(800);
  });

  it("multiplies the store by the device pixel ratio and scales the context once", () => {
    const surface = stubCanvas({ width: 32, height: 800 });
    new RailPainter({ readDevicePixelRatio: () => 2 }).paint(
      surface.canvas,
      [tickAt(0.5)],
      undefined,
    );
    expect(surface.canvas.width).toBe(64);
    expect(surface.canvas.height).toBe(1600);
    expect(surface.transforms).toStrictEqual([{ horizontalScale: 2, verticalScale: 2 }]);
  });

  it("keeps every measurement in CSS pixels, so a tick lands where its row is", () => {
    // The mark at the window's midpoint belongs at half the RENDERED height. Read
    // off the default bitmap it would land at 75 — a fifth of the way down a strip
    // it is supposed to bisect.
    const surface = stubCanvas({ width: 32, height: 800 });
    new RailPainter({ readDevicePixelRatio: () => 2 }).paint(
      surface.canvas,
      [tickAt(0.5)],
      undefined,
    );
    expect(surface.fills).toHaveLength(1);
    expect(surface.fills[0]?.y).toBeCloseTo(399, 0);
    expect(surface.clears).toStrictEqual([{ x: 0, y: 0, width: 32, height: 800, fillStyle: "" }]);
  });

  it("repaints to the new size when the box grows", () => {
    // The second paint is what a resize produces, and the store has to follow it
    // rather than keeping the extent the first paint sized it to.
    const surface = stubCanvas({ width: 32, height: 400 });
    const painter = new RailPainter({ readDevicePixelRatio: () => 1 });
    painter.paint(surface.canvas, [tickAt(1)], undefined);
    expect(surface.canvas.height).toBe(400);
    const grown = stubCanvas({ width: 32, height: 900 });
    painter.paint(grown.canvas, [tickAt(1)], undefined);
    expect(grown.canvas.height).toBe(900);
    expect(grown.fills[0]?.y).toBeCloseTo(899, 0);
  });

  it("negative control: a box with no extent paints nothing and leaves the store alone", () => {
    // What a DOM shim and a collapsed pane both report. Painting into a zero box
    // would stack every tick at the top of a bitmap nobody can see.
    const surface = stubCanvas({ width: 0, height: 0 });
    new RailPainter({ readDevicePixelRatio: () => 3 }).paint(
      surface.canvas,
      [tickAt(0.5)],
      undefined,
    );
    expect(surface.fills).toStrictEqual([]);
    expect(surface.clears).toStrictEqual([]);
    expect(surface.canvas.width).toBe(300);
    expect(surface.canvas.height).toBe(150);
  });
});

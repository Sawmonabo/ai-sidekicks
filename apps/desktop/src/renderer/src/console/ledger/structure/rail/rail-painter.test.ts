// The painter, driven against a canvas the unit tier can hold.
//
// Nothing here renders: the painter takes a canvas handle and a 2D context and
// nothing else, which is what lets these cases assert the geometry a browser tier
// would have to measure. The stub records every drawing call, so the assertions are
// about what was DRAWN rather than about what was returned.

import { describe, expect, it } from "vitest";

import { ParticipantHueAllocator, formatOklch } from "../../../tokens/index.js";
import { RailPainter, type RailActorHueLookup } from "./rail-painter.js";
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
  // A REAL element with two members replaced, rather than an object literal shaped
  // like one: the painter resolves its tone colours through the host's computed
  // style, which only answers for something the document actually holds.
  const canvas = document.createElement("canvas");
  Object.defineProperty(canvas, "getBoundingClientRect", {
    value: () => ({ width: box.width, height: box.height }) as DOMRect,
  });
  Object.defineProperty(canvas, "getContext", {
    value: () => context as unknown as CanvasRenderingContext2D,
  });
  return { canvas, fills, clears, transforms };
}

function tickAt(
  position: number,
  tone: RailTick["tone"] = "actor",
  actorId: string | undefined = "participant-1",
): RailTick {
  return {
    kind: "participant-message",
    rowId: `row-${String(position)}`,
    sequence: Math.round(position * 100),
    timestamp: "2026-09-02T10:00:00.000Z",
    actorId,
    tone,
    glyph: "member",
    summary: "a line somebody wrote",
    position,
  };
}

/** The session's own wheel, admitted in join order exactly as the cast bar does it. */
function sessionHues(...participantIds: readonly string[]): RailActorHueLookup {
  const allocator = new ParticipantHueAllocator();
  for (const participantId of participantIds) {
    allocator.admit(participantId);
  }
  return (participantId: string) => allocator.assignmentFor(participantId);
}

describe("rail painter — the backing store follows the rendered box", () => {
  it("sizes the bitmap from the box rather than leaving the default", () => {
    // 300x150 is the canvas default, and the rail's own box is nothing like it:
    // a 32px strip down a tall pane. Left alone, every mark is drawn into that
    // default and then stretched by CSS.
    const surface = stubCanvas({ width: 32, height: 800 });
    new RailPainter({ readDevicePixelRatio: () => 1 }).paint(surface.canvas, {
      ticks: [tickAt(0.5)],
      pointerFraction: undefined,
    });
    expect(surface.canvas.width).toBe(32);
    expect(surface.canvas.height).toBe(800);
  });

  it("multiplies the store by the device pixel ratio and scales the context once", () => {
    const surface = stubCanvas({ width: 32, height: 800 });
    new RailPainter({ readDevicePixelRatio: () => 2 }).paint(surface.canvas, {
      ticks: [tickAt(0.5)],
      pointerFraction: undefined,
    });
    expect(surface.canvas.width).toBe(64);
    expect(surface.canvas.height).toBe(1600);
    expect(surface.transforms).toStrictEqual([{ horizontalScale: 2, verticalScale: 2 }]);
  });

  it("keeps every measurement in CSS pixels, so a tick lands where its row is", () => {
    // The mark at the window's midpoint belongs at half the RENDERED height. Read
    // off the default bitmap it would land at 75 — a fifth of the way down a strip
    // it is supposed to bisect.
    const surface = stubCanvas({ width: 32, height: 800 });
    new RailPainter({ readDevicePixelRatio: () => 2 }).paint(surface.canvas, {
      ticks: [tickAt(0.5)],
      pointerFraction: undefined,
    });
    expect(surface.fills).toHaveLength(1);
    expect(surface.fills[0]?.y).toBeCloseTo(399, 0);
    expect(surface.clears).toStrictEqual([{ x: 0, y: 0, width: 32, height: 800, fillStyle: "" }]);
  });

  it("repaints to the new size when the box grows", () => {
    // The second paint is what a resize produces, and the store has to follow it
    // rather than keeping the extent the first paint sized it to.
    const surface = stubCanvas({ width: 32, height: 400 });
    const painter = new RailPainter({ readDevicePixelRatio: () => 1 });
    painter.paint(surface.canvas, { ticks: [tickAt(1)], pointerFraction: undefined });
    expect(surface.canvas.height).toBe(400);
    const grown = stubCanvas({ width: 32, height: 900 });
    painter.paint(grown.canvas, { ticks: [tickAt(1)], pointerFraction: undefined });
    expect(grown.canvas.height).toBe(900);
    expect(grown.fills[0]?.y).toBeCloseTo(899, 0);
  });

  it("negative control: a box with no extent paints nothing and leaves the store alone", () => {
    // What a DOM shim and a collapsed pane both report. Painting into a zero box
    // would stack every tick at the top of a bitmap nobody can see.
    const surface = stubCanvas({ width: 0, height: 0 });
    new RailPainter({ readDevicePixelRatio: () => 3 }).paint(surface.canvas, {
      ticks: [tickAt(0.5)],
      pointerFraction: undefined,
    });
    expect(surface.fills).toStrictEqual([]);
    expect(surface.clears).toStrictEqual([]);
    expect(surface.canvas.width).toBe(300);
    expect(surface.canvas.height).toBe(150);
  });
});

describe("rail painter — an actor tick carries its actor's hue", () => {
  /** Every fill the painter laid down, in paint order. */
  function fillsFor(
    ticks: readonly RailTick[],
    actorHue: RailActorHueLookup | undefined,
  ): readonly string[] {
    const surface = stubCanvas({ width: 32, height: 800 });
    new RailPainter({ readDevicePixelRatio: () => 1 }).paint(surface.canvas, {
      ticks,
      pointerFraction: undefined,
      ...(actorHue === undefined ? {} : { actorHue }),
    });
    return surface.fills.map((fill) => fill.fillStyle);
  }

  it("gives two participants two different marks", () => {
    // The rail's whole attribution claim: two people writing into one session are
    // told apart on the minimap without reading a single row.
    const fills = fillsFor(
      [tickAt(0.2, "actor", "participant-a"), tickAt(0.8, "actor", "participant-b")],
      sessionHues("participant-a", "participant-b"),
    );
    expect(fills).toHaveLength(2);
    expect(new Set(fills).size).toBe(2);
  });

  it("paints the wheel's own assignment, at reduced chroma and the same hue", () => {
    // The assignment is the store's — the same one the cast bar rings with — so a
    // person's mark and their chip cannot name two different colours.
    const allocator = new ParticipantHueAllocator();
    const assignment = allocator.admit("participant-a");
    const [fill] = fillsFor([tickAt(0.2, "actor", "participant-a")], (participantId) =>
      allocator.assignmentFor(participantId),
    );
    // Read back rather than compared against a second copy of the scale factor: the
    // claim is that lightness and hue survive and chroma comes down, which is what
    // "the actor's hue at low chroma" says. A literal here would be the constant
    // written twice.
    const painted = /^oklch\((?<lightness>[\d.]+) (?<chroma>[\d.]+) (?<hue>[\d.]+)\)$/.exec(
      fill ?? "",
    );
    expect(painted?.groups?.["lightness"]).toBe(assignment.color.lightness.toFixed(3));
    expect(painted?.groups?.["hue"]).toBe(assignment.color.hueDegrees.toFixed(1));
    expect(Number(painted?.groups?.["chroma"])).toBeGreaterThan(0);
    expect(Number(painted?.groups?.["chroma"])).toBeLessThan(assignment.color.chroma);
    expect(fill).not.toBe(formatOklch(assignment.color));
  });

  it("leaves a participant the wheel has never admitted on the neutral tone", () => {
    // Minting a hue here would give one person two colours across the console.
    const knownFills = fillsFor(
      [tickAt(0.2, "actor", "participant-a")],
      sessionHues("participant-a"),
    );
    const unknownFills = fillsFor(
      [tickAt(0.2, "actor", "participant-nobody-admitted")],
      sessionHues("participant-a"),
    );
    expect(unknownFills).not.toStrictEqual(knownFills);
    expect(unknownFills).toStrictEqual(
      fillsFor([tickAt(0.2, "actor", "participant-a")], undefined),
    );
  });

  it("keeps the two rationed marks off the hue channel", () => {
    // Rule 3: amber is pending-human and red is failure, whoever raised them.
    const fills = fillsFor(
      [tickAt(0.2, "attention", "participant-a"), tickAt(0.8, "failure", "participant-a")],
      sessionHues("participant-a"),
    );
    expect(new Set(fills).size).toBe(2);
    for (const fill of fills) {
      expect(fill).not.toBe(
        fillsFor([tickAt(0.2, "actor", "participant-a")], sessionHues("participant-a"))[0],
      );
    }
  });

  it("negative control: every fill is a colour a canvas can parse", () => {
    // A custom-property reference is not a colour: assigning one leaves the
    // previous fill in place, so the rail would paint every mark in the context's
    // default ink while every table here still read correct.
    const fills = fillsFor(
      [
        tickAt(0.2, "actor", "participant-a"),
        tickAt(0.5, "attention", "participant-a"),
        tickAt(0.8, "failure", undefined),
      ],
      sessionHues("participant-a"),
    );
    expect(fills).toHaveLength(3);
    for (const fill of fills) {
      expect(fill.startsWith("var(")).toBe(false);
      expect(fill.length).toBeGreaterThan(0);
    }
  });
});

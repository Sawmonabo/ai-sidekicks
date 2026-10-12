// The terminal's grid as the emulator paints it, read back from its own canvas in device pixels:
// block and box glyphs stacked in one column meet the row above with no seam at every text size,
// and the runs the DOM renderer draws as one span are set with shaping off. The browser tier runs
// this file again on a screen of two device pixels per CSS pixel.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import "#renderer/features/terminal/emulator/components/XtermMountPoint.css";
import { applyAppearance, installMeridianTokens } from "#renderer/app/token-installation.js";
import { TerminalRendererPool } from "#renderer/features/terminal/emulator/renderer-pool.js";
import { XtermTerminalAdapter } from "#renderer/features/terminal/emulator/xterm/adapter.js";
import { DEFAULT_APPEARANCE_RECORD, TEXT_SIZES } from "#shared/appearance.js";
import { nextFrame } from "../../helpers/animation-frame.js";

/**
 * Two full blocks stacked in the first column and two light verticals in the second, then one
 * full block alone in the third, whose height is one cell's. The screen is cleared first, so each
 * text size paints the same cells, and the cursor is hidden, so its outline marks no cell.
 */
const STACKED_GLYPHS = "\u001b[?25l\u001b[2J\u001b[H█│█\r\n█│";

/** The column of cells the stacked full blocks, the stacked verticals and the lone block sit in. */
const STACKED_BLOCK_COLUMN = 0;
const STACKED_VERTICAL_COLUMN = 1;
const LONE_BLOCK_COLUMN = 2;

/** The run of cells the DOM renderer draws as one span, where shaping could join characters. */
const SHAPED_RUN = "-> != fi";

/** The box the emulator is laid out in, in CSS pixels. */
const MOUNT_BOX_CSS = "inline-size: 400px; block-size: 200px;";

const liveAdapters: XtermTerminalAdapter[] = [];

beforeEach(() => {
  installMeridianTokens(document);
});

afterEach(() => {
  for (const adapter of liveAdapters.splice(0)) {
    adapter.dispose();
  }
  document.querySelector("[data-grid-host]")?.remove();
  applyAppearance(document, DEFAULT_APPEARANCE_RECORD);
});

describe("browser — the terminal's grid", () => {
  it("meets the row above with no seam at every text size", async () => {
    const { adapter } = mountEmulator(new TerminalRendererPool());
    // The setup: the grid is drawn from the library's glyph atlas, the renderer a person sees.
    expect(adapter.rendererMode).toBe("webgl");

    for (const textSize of TEXT_SIZES) {
      applyAppearance(document, { ...DEFAULT_APPEARANCE_RECORD, textSize });
      adapter.followMountTypeface();
      // The new cell resizes the canvas, which clears it, after the frame's own callbacks.
      await nextFrame();
      await nextFrame();
      const canvas = await paintedCanvasAfter(adapter, STACKED_GLYPHS);
      // The setup: the grid is painted at the screen's density, one canvas pixel a device pixel.
      expect(canvas.width).toBe(canvas.cssWidth * window.devicePixelRatio);
      const columns = columnCount(canvas);
      const loneBlock = inkRunsDown(canvas, centerOf(LONE_BLOCK_COLUMN, canvas, columns));
      // The control: one cell's block is one run from the grid's top edge.
      expect(loneBlock, `one block at text size ${String(textSize)}`).toHaveLength(1);
      const [cell] = loneBlock;
      expect(cell?.start).toBe(0);
      const cellHeight = cell?.length ?? Number.NaN;

      // Two cells abutting make one run exactly two cells tall: a seam splits it, and an overlap
      // or a fractional row shortens it.
      for (const [glyph, column] of [
        ["full block", STACKED_BLOCK_COLUMN],
        ["light vertical", STACKED_VERTICAL_COLUMN],
      ] as const) {
        const runs = inkRunsDown(canvas, inkiestColumnIn(column, canvas, columns));
        expect(runs, `two of ${glyph} at text size ${String(textSize)}`).toEqual([
          { start: 0, length: 2 * cellHeight },
        ]);
      }
    }
  });

  it("draws a run of cells with ligatures and contextual alternates off", async () => {
    // The DOM renderer, the one that draws a run of cells as one span the browser shapes.
    const { adapter, mountElement } = mountEmulator(new TerminalRendererPool(0));
    expect(adapter.rendererMode).toBe("dom");
    await writeText(adapter, SHAPED_RUN);
    // The rows are drawn on the frame after the write.
    await nextFrame();

    const run = [...mountElement.querySelectorAll<HTMLElement>(".xterm-rows span")].find((span) =>
      span.textContent.includes("!="),
    );
    if (run === undefined) {
      throw new Error("the DOM renderer drew no span holding the run");
    }
    expect(getComputedStyle(run).fontVariantLigatures).toBe("none");
  });
});

/** An unbroken run of ink down a column of device pixels, from the grid's top edge. */
interface InkRun {
  readonly start: number;
  readonly length: number;
}

/** An emulator attached to a mount element the stylesheet sets the face and type step on. */
function mountEmulator(pool: TerminalRendererPool): {
  adapter: XtermTerminalAdapter;
  mountElement: HTMLElement;
} {
  const host = document.createElement("div");
  host.setAttribute("data-grid-host", "");
  host.style.cssText = MOUNT_BOX_CSS;
  const mountElement = document.createElement("div");
  mountElement.className = "meridian-terminal-mount-point__mount-element";
  host.append(mountElement);
  document.body.append(host);
  const adapter = new XtermTerminalAdapter({ terminalId: "grid", pool });
  liveAdapters.push(adapter);
  adapter.attach(mountElement);
  return { adapter, mountElement };
}

async function writeText(adapter: XtermTerminalAdapter, text: string): Promise<void> {
  await new Promise<void>((resolve) => {
    adapter.write(text, resolve);
  });
}

/**
 * The emulator's WebGL canvas once `text` is painted, its pixels read in the frame that paints
 * them: the library schedules its paint on the frame before this read, and the drawing buffer is
 * not kept past the frame.
 */
async function paintedCanvasAfter(
  adapter: XtermTerminalAdapter,
  text: string,
): Promise<PaintedCanvas> {
  await writeText(adapter, text);
  return new Promise((resolve, reject) => {
    requestAnimationFrame(() => {
      const canvases = document.querySelectorAll<HTMLCanvasElement>("[data-grid-host] canvas");
      for (const canvas of canvases) {
        const context = canvas.getContext("webgl2");
        if (context !== null) {
          const pixels = new Uint8Array(canvas.width * canvas.height * 4);
          context.readPixels(
            0,
            0,
            canvas.width,
            canvas.height,
            context.RGBA,
            context.UNSIGNED_BYTE,
            pixels,
          );
          resolve({
            width: canvas.width,
            height: canvas.height,
            cssWidth: canvas.offsetWidth,
            pixels,
            ...colorsOf(pixels, canvas.width, canvas.height),
          });
          return;
        }
      }
      reject(new Error("the emulator drew no WebGL canvas"));
    });
  });
}

/** A canvas's pixels, bottom row first as WebGL reads them, four channels each. */
interface PaintedCanvas {
  readonly width: number;
  readonly height: number;
  /** The canvas's laid-out width in CSS pixels, before any transform above it. */
  readonly cssWidth: number;
  readonly ground: readonly number[];
  readonly text: readonly number[];
  readonly pixels: Uint8Array;
}

/** How many cells wide the grid is: the canvas spans a whole number of cells. */
function columnCount(canvas: PaintedCanvas): number {
  // The top row starts with a full block and then a vertical's ground, so a cell's width is where
  // the first block's ink ends.
  const topRow = canvas.height - 1;
  let cellWidth = 0;
  while (cellWidth < canvas.width && isInk(canvas, cellWidth, topRow)) {
    cellWidth += 1;
  }
  return Math.round(canvas.width / cellWidth);
}

/** The device pixel column through the middle of `column`. */
function centerOf(column: number, canvas: PaintedCanvas, columns: number): number {
  const cellWidth = canvas.width / columns;
  return Math.floor(column * cellWidth + cellWidth / 2);
}

/** The device pixel column of `column` holding the most ink: a vertical's stroke. */
function inkiestColumnIn(column: number, canvas: PaintedCanvas, columns: number): number {
  const cellWidth = canvas.width / columns;
  let inkiest = Math.floor(column * cellWidth);
  let mostInk = -1;
  for (let x = Math.floor(column * cellWidth); x < Math.floor((column + 1) * cellWidth); x += 1) {
    const ink = inkRunsDown(canvas, x).reduce((sum, run) => sum + run.length, 0);
    if (ink > mostInk) {
      mostInk = ink;
      inkiest = x;
    }
  }
  return inkiest;
}

/** Each unbroken run of ink down device pixel column `x`, from the grid's top edge. */
function inkRunsDown(canvas: PaintedCanvas, x: number): InkRun[] {
  const runs: InkRun[] = [];
  let start: number | undefined;
  for (let y = 0; y <= canvas.height; y += 1) {
    const isInkHere = y < canvas.height && isInk(canvas, x, canvas.height - 1 - y);
    if (isInkHere && start === undefined) {
      start = y;
    } else if (!isInkHere && start !== undefined) {
      runs.push({ start, length: y - start });
      start = undefined;
    }
  }
  return runs;
}

/** Whether a pixel is nearer the canvas's text color than its ground. */
function isInk(canvas: PaintedCanvas, x: number, bottomUpY: number): boolean {
  const pixel = channelsAt(canvas.pixels, canvas.width, x, bottomUpY);
  return distance(pixel, canvas.text) < distance(pixel, canvas.ground);
}

/**
 * The ground and the text color of a grid: the far corner, which nothing is written to, and the
 * pixel furthest from it.
 */
function colorsOf(
  pixels: Uint8Array,
  width: number,
  height: number,
): { ground: readonly number[]; text: readonly number[] } {
  const ground = channelsAt(pixels, width, width - 1, 0);
  let text = ground;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = channelsAt(pixels, width, x, y);
      if (distance(pixel, ground) > distance(text, ground)) {
        text = pixel;
      }
    }
  }
  return { ground, text };
}

function channelsAt(
  pixels: Uint8Array,
  width: number,
  x: number,
  bottomUpY: number,
): readonly number[] {
  const offset = (bottomUpY * width + x) * 4;
  return [...pixels.subarray(offset, offset + 3)];
}

function distance(first: readonly number[], second: readonly number[]): number {
  return first.reduce((sum, channel, index) => sum + Math.abs(channel - (second[index] ?? 0)), 0);
}

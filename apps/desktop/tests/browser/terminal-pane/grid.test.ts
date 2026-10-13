// The terminal's grid as each renderer paints it, read back in device pixels, the WebGL grid from
// its own canvas and the DOM grid from a screenshot of it: block and box glyphs stacked in one
// column meet the row above with no seam at every text size, a dim box glyph the DOM renderer
// draws inks each stroke once, and the runs the DOM renderer draws as one span are set with
// shaping off. The browser tier runs this file again on a screen of two device pixels per CSS
// pixel.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";

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

/**
 * A dim full block, whose color is the dim ink, then dim glyphs whose shapes meet or cross: box
 * joints, T junctions, a cross, rounded corners, a quadrant block, a diagonal cross, and the
 * Powerline right triangle, chevron and stroked semicircle, each drawn in layers one above another.
 */
const DIM_GLYPHS = "█┌┬┐├┼┤└┴┘╭╮▙╳\uE0B0\uE0B1\uE0B5";

/** The dim glyphs made of straight strokes, each read along its inkiest row and column. */
const DIM_STRAIGHT_GLYPHS = "┌┬┐├┼┤└┴┘▙";

/**
 * How far a pixel's ink may stray from the dim ink, as a share of it: a pixel two translucent
 * layers cover holds half as much ink again.
 */
const INK_TOLERANCE = 0.1;

/** The run of cells the DOM renderer draws as one span, where shaping could join characters. */
const SHAPED_RUN = "-> != fi";

/** The box the emulator is laid out in, in CSS pixels. */
const MOUNT_BOX_CSS = "inline-size: 400px; block-size: 200px;";

/**
 * A window small enough for the tier's runner to draw the page at full scale, so a screenshot's
 * pixels are the screen's own; at the tier's own size the runner shrinks the page to fit.
 */
const SCREENSHOT_WINDOW = { width: 640, height: 360 };

const tierViewport = { width: window.innerWidth, height: window.innerHeight };

const liveAdapters: XtermTerminalAdapter[] = [];

beforeEach(() => {
  installMeridianTokens(document);
});

afterEach(async () => {
  for (const adapter of liveAdapters.splice(0)) {
    adapter.dispose();
  }
  document.querySelector("[data-grid-host]")?.remove();
  applyAppearance(document, DEFAULT_APPEARANCE_RECORD);
  await page.viewport(tierViewport.width, tierViewport.height);
});

describe("browser — the terminal's grid", () => {
  it.each([
    // The library's glyph atlas, the renderer a person sees.
    {
      renderer: "webgl",
      createPool: () => new TerminalRendererPool(),
      readGrid: paintedCanvasAfter,
    },
    // The renderer a terminal falls back to once the page's WebGL contexts are spent.
    {
      renderer: "dom",
      createPool: () => new TerminalRendererPool(0),
      readGrid: paintedScreenAfter,
    },
  ] as const)(
    "meets the row above with no seam at every text size, drawn by $renderer",
    async ({ renderer, createPool, readGrid }) => {
      const { adapter, mountElement } = mountEmulator(createPool());
      expect(adapter.rendererMode).toBe(renderer);

      for (const textSize of TEXT_SIZES) {
        applyAppearance(document, { ...DEFAULT_APPEARANCE_RECORD, textSize });
        adapter.followMountTypeface();
        // The new cell resizes the grid, and a WebGL canvas with it, which clears it, after the
        // frame's own callbacks.
        await nextFrame();
        await nextFrame();
        const canvas = await readGrid(adapter, mountElement, STACKED_GLYPHS);
        // The setup: the grid is read at the screen's density, one pixel read a device pixel.
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
    },
  );

  it("inks each stroke of a dim box glyph once at every text size, drawn by dom", async () => {
    const { adapter, mountElement } = mountEmulator(new TerminalRendererPool(0));
    expect(adapter.rendererMode).toBe("dom");

    for (const textSize of TEXT_SIZES) {
      applyAppearance(document, { ...DEFAULT_APPEARANCE_RECORD, textSize });
      adapter.followMountTypeface();
      await nextFrame();
      const canvas = await paintedScreenAfter(
        adapter,
        mountElement,
        `\u001b[?25l\u001b[2J\u001b[H\u001b[2m${DIM_GLYPHS}\u001b[0m`,
      );
      const [block, ...glyphs] = [...DIM_GLYPHS].map((glyph) => ({
        glyph,
        ...cellPixelsOf(glyph, mountElement),
      }));
      if (block === undefined) {
        throw new Error("the dim row holds no full block");
      }
      const dimInk = channelsAt(
        canvas.pixels,
        canvas.width,
        middleOf(block.xs),
        canvas.height - 1 - middleOf(block.ys),
      );

      for (const { glyph, xs, ys } of glyphs) {
        const inkAt = (x: number, y: number): number => inkShare(canvas, dimInk, x, y);
        const where = `${glyph} at text size ${String(textSize)}`;
        // No pixel holds more ink than the dim color: two layers over one pixel would.
        expect(Math.max(...xs.flatMap((x) => ys.map((y) => inkAt(x, y)))), where).toBeLessThan(
          1 + INK_TOLERANCE,
        );
        if (DIM_STRAIGHT_GLYPHS.includes(glyph)) {
          const row = inkiest(ys, (y) => xs.map((x) => inkAt(x, y)));
          const column = inkiest(xs, (x) => ys.map((y) => inkAt(x, y)));
          // Along each stroke the ink is one unbroken run at the dim color: a joint drawn twice
          // is darker and a gap splits the run.
          for (const stroke of [row, column]) {
            expect(strokeLevels(stroke), where).toEqual({ runs: 1, isEven: true });
          }
        }
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
  mountElement: HTMLElement,
  text: string,
): Promise<PaintedCanvas> {
  await writeText(adapter, text);
  return new Promise((resolve, reject) => {
    requestAnimationFrame(() => {
      const canvases = mountElement.querySelectorAll<HTMLCanvasElement>("canvas");
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

/**
 * The DOM renderer's grid once `text` is painted, as the browser composited it: a screenshot of the
 * grid's element in device pixels, its rows turned bottom first as WebGL reads them.
 */
async function paintedScreenAfter(
  adapter: XtermTerminalAdapter,
  mountElement: HTMLElement,
  text: string,
): Promise<PaintedCanvas> {
  await page.viewport(SCREENSHOT_WINDOW.width, SCREENSHOT_WINDOW.height);
  await writeText(adapter, text);
  // The rows are drawn on the frame after the write.
  await nextFrame();
  await nextFrame();
  const screen = mountElement.querySelector<HTMLElement>(".xterm-screen");
  if (screen === null) {
    throw new Error("the emulator drew no grid element");
  }
  const png = await page.screenshot({ element: screen, save: false });
  const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob());
  const context = new OffscreenCanvas(image.width, image.height).getContext("2d");
  if (context === null) {
    throw new Error("the page gave no 2D context to read the screenshot with");
  }
  context.drawImage(image, 0, 0);
  const topDown = context.getImageData(0, 0, image.width, image.height).data;
  const rowLength = image.width * 4;
  const pixels = new Uint8Array(topDown.length);
  for (let y = 0; y < image.height; y += 1) {
    const sourceStart = (image.height - 1 - y) * rowLength;
    pixels.set(topDown.subarray(sourceStart, sourceStart + rowLength), y * rowLength);
  }
  return {
    width: image.width,
    height: image.height,
    cssWidth: screen.offsetWidth,
    pixels,
    ...colorsOf(pixels, image.width, image.height),
  };
}

/** A grid's pixels, bottom row first as WebGL reads them, four channels each. */
interface PaintedCanvas {
  readonly width: number;
  readonly height: number;
  /** The grid's laid-out width in CSS pixels, before any transform above it. */
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

/**
 * The device pixel columns and rows of the grid screenshot lying wholly inside the cell the DOM
 * renderer drew `glyph` in, from the span it drew the cell as.
 */
function cellPixelsOf(glyph: string, mountElement: HTMLElement): { xs: number[]; ys: number[] } {
  const screen = mountElement.querySelector(".xterm-screen");
  const span = [...mountElement.querySelectorAll(".xterm-rows span")].find(
    (candidate) => candidate.textContent === glyph,
  );
  if (screen === null || span === undefined) {
    throw new Error(`the DOM renderer drew no span holding ${glyph}`);
  }
  const origin = screen.getBoundingClientRect();
  const cell = span.getBoundingClientRect();
  const ratio = window.devicePixelRatio;
  return {
    xs: range(
      Math.ceil((cell.left - origin.left) * ratio),
      Math.floor((cell.right - origin.left) * ratio),
    ),
    ys: range(
      Math.ceil((cell.top - origin.top) * ratio),
      Math.floor((cell.bottom - origin.top) * ratio),
    ),
  };
}

function middleOf(values: readonly number[]): number {
  return values[Math.floor(values.length / 2)] ?? Number.NaN;
}

/** The integers from `start` up to, not including, `end`. */
function range(start: number, end: number): number[] {
  return Array.from({ length: Math.max(end - start, 0) }, (_, offset) => start + offset);
}

/** A pixel's ink as a share of `ink`'s: how far it is from the ground, against how far `ink` is. */
function inkShare(
  canvas: PaintedCanvas,
  ink: readonly number[],
  x: number,
  topDownY: number,
): number {
  const pixel = channelsAt(canvas.pixels, canvas.width, x, canvas.height - 1 - topDownY);
  return distance(pixel, canvas.ground) / distance(ink, canvas.ground);
}

/** The ink shares along whichever of `lines` holds the most ink, `read` giving each one's. */
function inkiest(lines: readonly number[], read: (line: number) => number[]): number[] {
  return lines
    .map(read)
    .reduce<number[]>((most, shares) => (sum(shares) > sum(most) ? shares : most), []);
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/**
 * The runs of inked pixels along a stroke, those holding over half the dim ink, and whether each
 * holds the dim ink to within the tolerance.
 */
function strokeLevels(shares: readonly number[]): { runs: number; isEven: boolean } {
  const inked = shares.map((share) => share > 0.5);
  const runs = inked.filter((isInked, index) => isInked && !inked[index - 1]).length;
  const isEven = shares
    .filter((_, index) => inked[index])
    .every((share) => Math.abs(share - 1) <= INK_TOLERANCE);
  return { runs, isEven };
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

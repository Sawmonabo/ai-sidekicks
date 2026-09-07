// The pixels of a PNG this tier wrote, read back inside the page that captured it.
//
// WHY A TIER THAT COMPARES IMAGES NEEDS ONE. `toMatchScreenshot` answers one question —
// does this capture equal the committed reference — and every claim it can make is
// relative to an image somebody already approved. That is exactly the wrong instrument
// for proving the CAPTURE MECHANISM works: the tall-capture defect produced references
// that were stable, green against themselves, and blank below the window's edge. A
// claim about what is in an image has to read the image.
//
// AND WHY THIS IS NOT A DECODER. The tier runs in Chromium. `createImageBitmap` is that
// browser's own PNG decoder, and a canvas is its own pixel buffer, so a hand-written
// inflate-and-unfilter here would be a second implementation of something the runtime
// already has — which `apps/desktop/AGENTS.md` §Shared code rejects in terms ("check the
// `node:` standard library"; in a page the platform is the library). What is written
// here is the two things the platform does NOT give: the bytes, which come back over
// Vitest's own `readFile` command because the file is on the runner and the reader is in
// a page, and the colour-management pins that keep a decode byte-exact.
//
// COLOUR CONVERSION IS TURNED OFF, ON PURPOSE. A 2D canvas will happily convert a
// decoded image into its own colour space, and a capture read back through a conversion
// is a capture nobody can assert an exact colour against. `colorSpaceConversion: "none"`
// and `premultiplyAlpha: "none"` on the decode, and an explicit `srgb` context, are what
// make `rowColours` report the bytes the file holds rather than a rendering of them.
//
// Not a test file — no `include` glob reaches it.

import { server } from "vitest/browser";

/** One decoded capture, addressable by row. */
export class CapturedPng {
  readonly #width: number;
  readonly #height: number;
  readonly #pixels: Uint8ClampedArray;

  private constructor(width: number, height: number, pixels: Uint8ClampedArray) {
    this.#width = width;
    this.#height = height;
    this.#pixels = pixels;
  }

  /**
   * Read one PNG off the runner's filesystem and decode it here.
   *
   * The path is absolute and comes from whoever wrote the file — the matcher reports
   * it — rather than being rebuilt from configuration, so a reader can never assert
   * against a file some other run left behind under a path it guessed.
   */
  public static async read(absolutePath: string): Promise<CapturedPng> {
    const base64 = await server.commands.readFile(absolutePath, "base64");
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }), {
      colorSpaceConversion: "none",
      premultiplyAlpha: "none",
    });
    try {
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext("2d", { colorSpace: "srgb", willReadFrequently: true });
      if (context === null) {
        throw new Error(`cannot decode ${absolutePath}: this page has no 2D canvas context`);
      }
      context.drawImage(bitmap, 0, 0);
      const image = context.getImageData(0, 0, bitmap.width, bitmap.height, { colorSpace: "srgb" });
      return new CapturedPng(bitmap.width, bitmap.height, image.data);
    } finally {
      bitmap.close();
    }
  }

  /** The image's width in device pixels, which is its reference's width. */
  public get width(): number {
    return this.#width;
  }

  /** The image's height in device pixels, which is its reference's height. */
  public get height(): number {
    return this.#height;
  }

  /**
   * Every distinct colour on one row, as `#rrggbb`, sorted.
   *
   * A SET rather than a sample, because the claims worth making about a capture are
   * about a whole band: "this row is one colour and it is this one" fails loudly on a
   * row that is half right, which a spot check at one x does not. Hex rather than a
   * tuple so a failure prints something a reader recognises, and alpha is dropped
   * because a capture of an opaque surface has none to report.
   */
  public rowColours(row: number): readonly string[] {
    if (row < 0 || row >= this.#height) {
      throw new Error(`row ${String(row)} is outside a ${String(this.#height)}px image`);
    }
    const colours = new Set<string>();
    const rowStart = row * this.#width * 4;
    for (let column = 0; column < this.#width; column += 1) {
      const pixel = rowStart + column * 4;
      colours.add(
        `#${[this.#pixels[pixel], this.#pixels[pixel + 1], this.#pixels[pixel + 2]]
          .map((channel) => (channel ?? 0).toString(16).padStart(2, "0"))
          .join("")}`,
      );
    }
    return [...colours].sort();
  }
}

// The pixels of a capture this tier took, decoded inside the page that took it.
//
// WHY A CAPTURE AID NEEDS ONE. The tier compares nothing, so nothing it writes can
// say whether the capture mechanism works. The tall-capture defect made that concrete:
// every image the tier held was stable, self-consistent, and blank below the window's
// edge, because a Playwright element screenshot is a clip in page coordinates and
// nothing composites an iframe's overflow. A claim about what is in an image has to
// read the image.
//
// AND WHY THIS IS NOT A DECODER. The tier runs in Chromium. `createImageBitmap` is that
// browser's own PNG decoder, and a canvas is its own pixel buffer, so a hand-written
// inflate-and-unfilter here would be a second implementation of something the runtime
// already has — which `apps/desktop/AGENTS.md` §Shared code rejects in terms ("check the
// `node:` standard library"; in a page the platform is the library). What is written
// here is the one thing the platform does not give: the colour-management pins that
// keep a decode byte-exact.
//
// COLOUR CONVERSION IS TURNED OFF, ON PURPOSE. A 2D canvas will happily convert a
// decoded image into its own colour space, and a capture read back through a conversion
// is a capture nobody can assert an exact colour against. `colorSpaceConversion: "none"`
// and `premultiplyAlpha: "none"` on the decode, and an explicit `srgb` context, are what
// make `rowColours` report the bytes the capture holds rather than a rendering of them.
//
// Not a test file — no `include` glob reaches it.

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
   * Decode one PNG this page just captured.
   *
   * The bytes come from the capture itself rather than from a file read back off a
   * path, which is what lets a probe assert on exactly the image it took: a path
   * rebuilt from configuration could name a file some earlier run left behind.
   */
  public static async decode(base64: string): Promise<CapturedPng> {
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
        throw new Error("cannot decode the capture: this page has no 2D canvas context");
      }
      context.drawImage(bitmap, 0, 0);
      const image = context.getImageData(0, 0, bitmap.width, bitmap.height, { colorSpace: "srgb" });
      return new CapturedPng(bitmap.width, bitmap.height, image.data);
    } finally {
      bitmap.close();
    }
  }

  /** The captured image's width in device pixels. */
  public get width(): number {
    return this.#width;
  }

  /** The captured image's height in device pixels. */
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

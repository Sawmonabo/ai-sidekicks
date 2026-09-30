// The pixels of a capture this tier took, decoded inside the page that took it. Not a test file.
// The tier compares nothing, so nothing it writes says whether the capture mechanism works: an
// image can be stable, self-consistent and blank below the window's edge, because a Playwright
// element screenshot is a clip in page coordinates and nothing composites an iframe's overflow. A
// claim about what is in an image has to read the image.
//
// It is not a decoder: `createImageBitmap` is the browser's own PNG decoder and a canvas its own
// pixel buffer. This adds only the color-management pins that keep a decode byte-exact; a 2D
// canvas would otherwise convert into its own color space. `colorSpaceConversion: "none"`,
// `premultiplyAlpha: "none"` and an explicit `srgb` context make `rowColors` report the bytes the
// capture holds.

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
   * Decodes one PNG this page just captured. The bytes come from the capture itself, not a path
   * rebuilt from configuration, which could name a file an earlier run left behind.
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
   * Every distinct color on one row, as `#rrggbb`, sorted. A set rather than a sample, because
   * the claims worth making are about a whole band and fail loudly on a row that is half right.
   * Alpha is dropped since a capture of an opaque element has none to report.
   */
  public rowColors(row: number): readonly string[] {
    if (row < 0 || row >= this.#height) {
      throw new Error(`row ${String(row)} is outside a ${String(this.#height)}px image`);
    }
    const colors = new Set<string>();
    const rowStart = row * this.#width * 4;
    for (let column = 0; column < this.#width; column += 1) {
      const pixel = rowStart + column * 4;
      colors.add(
        `#${[this.#pixels[pixel], this.#pixels[pixel + 1], this.#pixels[pixel + 2]]
          .map((channel) => (channel ?? 0).toString(16).padStart(2, "0"))
          .join("")}`,
      );
    }
    return [...colors].sort();
  }
}

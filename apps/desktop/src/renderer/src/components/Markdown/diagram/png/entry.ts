// The PNG encoder worker: lays the tiles the page drew of one picture side by side into a strip of
// rows, then writes the strip's rows into a PNG, so the encode, which grows with the picture's
// pixels, never runs on the page's thread, and only one strip's pixels are held at a time. The
// page ends it once it answers.

import type { PngEncodeReply, PngEncodeRequest } from "./messages.js";
import { PngStream } from "./stream.js";

/** The parts of a dedicated worker's global scope this script uses; the DOM types lack them. */
interface PngEncoderScope {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<PngEncodeRequest>) => void,
  ): void;
  postMessage(reply: PngEncodeReply, transfer?: Transferable[]): void;
}

// The script runs only as a dedicated worker, whose global scope is this shape.
const workerScope = globalThis as unknown as PngEncoderScope;

/**
 * One picture's encoding: its PNG so far, the strip its tiles are laid into, how many of the
 * strip's columns they fill, and the canvas each tile's pixels are read from.
 */
class PictureEncoder {
  #encoding:
    | {
        readonly png: PngStream;
        readonly width: number;
        readonly canvas: OffscreenCanvas;
        readonly context: OffscreenCanvasRenderingContext2D;
        strip: { readonly scanlines: Uint8Array<ArrayBuffer>; readonly rows: number } | undefined;
        filledColumns: number;
      }
    | undefined;

  /**
   * What `request` comes to. Rejects for a tile or end with no start before it, a tile unlike its
   * strip's height or past the picture's width, and an end before the last strip is filled.
   */
  public async handle(request: PngEncodeRequest): Promise<PngEncodeReply> {
    if (request.kind === "start") {
      const canvas = new OffscreenCanvas(1, 1);
      // Every tile is read back, so its pixels are kept where a read is cheap.
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (context === null) {
        throw new Error("This worker cannot read a picture's pixels.");
      }
      this.#encoding = {
        png: new PngStream(request.width, request.height),
        width: request.width,
        canvas,
        context,
        strip: undefined,
        filledColumns: 0,
      };
      return { status: "taken" };
    }
    const encoding = this.#encoding;
    if (encoding === undefined) {
      throw new Error("A picture's tile came before its start.");
    }
    if (request.kind === "end") {
      this.#encoding = undefined;
      if (encoding.strip !== undefined) {
        throw new Error("A picture ended before its last strip's tiles filled it.");
      }
      const png = await encoding.png.finish();
      return { status: "encoded", png: png.buffer };
    }
    const { bitmap, firstColumn, firstRow, columns, rows } = request;
    const rowBytes = 1 + encoding.width * 4;
    // A new strip's bytes are all zero, which opens each row on its filter type: none.
    const strip = encoding.strip ?? { scanlines: new Uint8Array(rows * rowBytes), rows };
    if (rows !== strip.rows || encoding.filledColumns + columns > encoding.width) {
      throw new Error("A picture's tile does not fit its strip.");
    }
    const { canvas, context } = encoding;
    if (canvas.width !== columns || canvas.height !== rows) {
      canvas.width = columns;
      canvas.height = rows;
    }
    // Every tile is opaque and covers the canvas, so each one hides the last.
    context.drawImage(bitmap, -firstColumn, -firstRow);
    bitmap.close();
    const pixels = context.getImageData(0, 0, columns, rows).data;
    for (let row = 0; row < rows; row += 1) {
      strip.scanlines.set(
        pixels.subarray(row * columns * 4, (row + 1) * columns * 4),
        row * rowBytes + 1 + encoding.filledColumns * 4,
      );
    }
    encoding.filledColumns += columns;
    if (encoding.filledColumns < encoding.width) {
      encoding.strip = strip;
      return { status: "taken" };
    }
    encoding.strip = undefined;
    encoding.filledColumns = 0;
    await encoding.png.writeRows(strip.scanlines, rows);
    return { status: "taken" };
  }
}

const encoder = new PictureEncoder();
// The page waits for each answer before it sends again, so one message is handled at a time.
workerScope.addEventListener("message", (event) => {
  encoder.handle(event.data).then(
    (reply) => {
      workerScope.postMessage(reply, reply.status === "encoded" ? [reply.png] : []);
    },
    (error: unknown) => {
      workerScope.postMessage({ status: "failed", reason: String(error) });
    },
  );
});

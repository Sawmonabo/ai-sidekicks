// The PNG encoder worker: reads the pixels of each strip the page drew of one picture and writes
// its rows into a PNG as they come, so the encode, which grows with the picture's pixels, never
// runs on the page's thread, and only one strip's pixels are held at a time. The page ends it once
// it answers.

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

/** One picture's encoding: its PNG so far, and the canvas each strip's pixels are read from. */
class PictureEncoder {
  #encoding:
    | {
        readonly png: PngStream;
        readonly canvas: OffscreenCanvas;
        readonly context: OffscreenCanvasRenderingContext2D;
      }
    | undefined;

  /** What `request` comes to; rejects for a strip or end with no start before it. */
  public async handle(request: PngEncodeRequest): Promise<PngEncodeReply> {
    if (request.kind === "start") {
      const canvas = new OffscreenCanvas(request.width, 1);
      // Every strip is read back, so its pixels are kept where a read is cheap.
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (context === null) {
        throw new Error("This worker cannot read a picture's pixels.");
      }
      this.#encoding = {
        png: new PngStream(request.width, request.height),
        canvas,
        context,
      };
      return { status: "taken" };
    }
    const encoding = this.#encoding;
    if (encoding === undefined) {
      throw new Error("A picture's strip came before its start.");
    }
    if (request.kind === "strip") {
      const { bitmap, firstRow, rows } = request;
      const { canvas, context } = encoding;
      if (canvas.height !== rows) {
        canvas.height = rows;
      }
      // Every strip is opaque and covers the canvas, so each one hides the last.
      context.drawImage(bitmap, 0, -firstRow);
      bitmap.close();
      await encoding.png.writeRows(context.getImageData(0, 0, canvas.width, rows).data, rows);
      return { status: "taken" };
    }
    this.#encoding = undefined;
    const png = await encoding.png.finish();
    return { status: "encoded", png: png.buffer };
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

// A drawn diagram as PNG bytes, for `Copy as picture`. The page draws the picture at its copy size
// on its own ground, since a transparent picture pastes onto whatever ground the target has, a
// strip of rows at a time, so no canvas passes the browser's size limit and no task of the page's
// grows with the picture; a worker started for the one copy writes each strip's rows into the PNG
// as they come, holding one strip at a time. It is ended once it answers.

import type { WorkerPort } from "#renderer/lib/worker-port.js";
import { pictureBlobOf } from "../pictures.js";
import type { DrawnDiagram } from "../worker/messages.js";
import type { PngEncodeReply, PngEncodeRequest } from "./messages.js";

/**
 * Encode `picture` as a PNG, at the window's pixel density and never under twice its natural
 * size, so it stays sharp where it is pasted and scaled. Rejects when the picture cannot be
 * decoded, drawn or encoded, which the copy reports as failed.
 */
export async function encodeDiagramPng(
  picture: DrawnDiagram,
  ownerWindow: Window,
): Promise<Uint8Array<ArrayBuffer>> {
  const image = ownerWindow.document.createElement("img");
  const pictureUrl = URL.createObjectURL(pictureBlobOf(picture));
  image.src = pictureUrl;
  try {
    await image.decode();
  } finally {
    URL.revokeObjectURL(pictureUrl);
  }
  const scale = Math.max(ownerWindow.devicePixelRatio, MINIMUM_COPY_SCALE);
  const width = Math.ceil(picture.width * scale);
  const height = Math.ceil(picture.height * scale);
  const stripRows = Math.max(1, Math.floor(STRIP_PIXELS / width) - 2 * STRIP_MARGIN_ROWS);
  const strip = new OffscreenCanvas(width, 1);
  const context = strip.getContext("2d");
  if (context === null) {
    throw new Error("This window cannot draw a picture to copy.");
  }
  // Loaded from the renderer's own origin as a module.
  const encoder: WorkerPort<PngEncodeRequest, PngEncodeReply> = new Worker(
    new URL("./entry.ts", import.meta.url),
    { type: "module", name: "png" },
  );
  try {
    await answerOf(encoder, { kind: "start", width, height });
    for (let top = 0; top < height; top += stripRows) {
      const rows = Math.min(stripRows, height - top);
      const above = Math.min(STRIP_MARGIN_ROWS, top);
      const below = Math.min(STRIP_MARGIN_ROWS, height - top - rows);
      if (strip.height !== above + rows + below) {
        strip.height = above + rows + below;
      }
      context.fillStyle = picture.groundColor;
      context.fillRect(0, 0, width, strip.height);
      // The whole picture drawn shifted up past the rows above the strip's margin, so each strip's
      // pixels are the whole drawing's; the canvas keeps only the strip and its margins.
      context.drawImage(image, 0, above - top, width, height);
      const bitmap = strip.transferToImageBitmap();
      await answerOf(encoder, { kind: "strip", bitmap, firstRow: above, rows }, [bitmap]);
    }
    const reply = await answerOf(encoder, { kind: "end" });
    if (reply.status !== "encoded") {
      throw new Error("The picture's encoder ended without its PNG.");
    }
    return new Uint8Array(reply.png);
  } finally {
    encoder.terminate();
  }
}

/** The least a copied picture is scaled by, so a paste from a low-density screen stays sharp. */
const MINIMUM_COPY_SCALE = 2;

/**
 * The rows drawn above and below each strip and left out of it. A shape the canvas's edge cuts is
 * drawn unlike the same shape whole, its edges a little apart; drawn this far past the strip, a
 * label's lines lie whole on the canvas wherever the strip cuts them.
 */
const STRIP_MARGIN_ROWS = 64;

/**
 * The most pixels one strip holds with its margins. Measured on a loaded machine, a strip of a
 * 120-node flowchart this size took at most 2.3 ms to draw and 5.3 ms to hand to the worker.
 */
const STRIP_PIXELS = 4_194_304;

/**
 * What `encoder` answers `request`, moving `transfer` to it; one request is asked at a time.
 * Rejects when it fails, stops or sends what cannot be read.
 */
async function answerOf(
  encoder: WorkerPort<PngEncodeRequest, PngEncodeReply>,
  request: PngEncodeRequest,
  transfer: Transferable[] = [],
): Promise<Exclude<PngEncodeReply, { status: "failed" }>> {
  const reply = await new Promise<PngEncodeReply>((resolve, reject) => {
    encoder.onmessage = (event) => {
      resolve(event.data);
    };
    encoder.onerror = (event) => {
      reject(new Error(`The picture's encoder stopped: ${event.message}`));
    };
    encoder.onmessageerror = () => {
      reject(new Error("The picture's encoder sent bytes that could not be read."));
    };
    encoder.postMessage(request, transfer);
  });
  if (reply.status === "failed") {
    throw new Error(`The picture could not be encoded as a PNG: ${reply.reason}`);
  }
  return reply;
}

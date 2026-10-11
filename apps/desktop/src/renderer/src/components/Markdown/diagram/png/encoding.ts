// A drawn diagram as PNG bytes, for `Copy as picture`. The page draws the picture at its copy size
// on its own ground, since a transparent picture pastes onto whatever ground the target has, a tile
// at a time: strips of rows from the top, each cut into columns from the left, so no canvas passes
// the browser's size limits and no task of the page's grows with the picture. A worker started for
// the one copy lays each strip's tiles side by side and writes its rows into the PNG as they come,
// holding one strip at a time. It is ended once it answers.

import type { WorkerPort } from "#renderer/lib/worker-port.js";
import { pictureBlobOf } from "../pictures.js";
import type { DrawnDiagram } from "../worker/messages.js";
import type { PngEncodeReply, PngEncodeRequest } from "./messages.js";

/**
 * Encode `picture` as a PNG, at the window's pixel density and never under twice its natural
 * size, so it stays sharp where it is pasted and scaled, drawn in tiles of at most `tileColumns`
 * columns. Rejects when the picture cannot be decoded, drawn or encoded, which the copy reports as
 * failed.
 */
export async function encodeDiagramPng(
  picture: DrawnDiagram,
  ownerWindow: Window,
  tileColumns: number = TILE_COLUMNS,
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
  // Never fewer rows than a margin, so a very wide picture's strips are not mostly margins drawn
  // and left out.
  const stripRows = Math.max(TILE_MARGIN, Math.floor(STRIP_PIXELS / width) - 2 * TILE_MARGIN);
  const tile = new OffscreenCanvas(1, 1);
  const context = tile.getContext("2d");
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
      const above = Math.min(TILE_MARGIN, top);
      const below = Math.min(TILE_MARGIN, height - top - rows);
      for (let left = 0; left < width; left += tileColumns) {
        const columns = Math.min(tileColumns, width - left);
        const before = Math.min(TILE_MARGIN, left);
        const after = Math.min(TILE_MARGIN, width - left - columns);
        if (tile.width !== before + columns + after || tile.height !== above + rows + below) {
          tile.width = before + columns + after;
          tile.height = above + rows + below;
        }
        context.fillStyle = picture.groundColor;
        context.fillRect(0, 0, tile.width, tile.height);
        // The whole picture drawn shifted up and left past the tile's margins, so each tile's
        // pixels are the whole drawing's; the canvas keeps only the tile and its margins.
        context.drawImage(image, before - left, above - top, width, height);
        const bitmap = tile.transferToImageBitmap();
        await answerOf(
          encoder,
          { kind: "tile", bitmap, firstColumn: before, firstRow: above, columns, rows },
          [bitmap],
        );
      }
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
 * The pixels drawn on each side of a tile and left out of it. A curve the canvas's edge cuts is
 * drawn in pieces, its edge pixels shaded a little apart from the whole curve's; drawn this far
 * past the tile, a curve that ends within the margin lies whole on the canvas. A longer one a cut
 * crosses still differs by a shade along its edge.
 */
const TILE_MARGIN = 64;

/**
 * The most pixels one strip holds with its margins above and below, and so about the most a tile
 * draws and the worker holds, unless a picture is so wide that a margin's rows hold more. Measured
 * on a loaded machine, a strip of a 120-node flowchart this size took at most 2.3 ms to draw and
 * 5.3 ms to hand to the worker.
 */
const STRIP_PIXELS = 4_194_304;

/**
 * The most columns one tile keeps: with its margins, inside the 32,767 pixels the browser lets a
 * canvas's side reach.
 */
const TILE_COLUMNS = 16_384;

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

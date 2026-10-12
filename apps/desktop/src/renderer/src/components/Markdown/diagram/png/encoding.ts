// A drawn diagram as PNG bytes, for `Copy as picture`, at its copy size on its own ground, since a
// transparent picture pastes onto whatever ground the target has. A picture one canvas holds is
// rastered whole off the page's thread, so no canvas edge cuts its shapes; the page draws a larger
// one a tile at a time on its ground: strips of rows from the top, each cut into columns from the
// left where it is wider than a canvas. A worker started for the one copy lays each strip's tiles
// side by side on the ground a band of rows at a time and writes them into the PNG as they come.
// It is ended once it answers.

import type { WorkerPort } from "#renderer/lib/worker-port.js";
import { pictureBlobOf } from "../pictures.js";
import type { DrawnDiagram } from "../worker/messages.js";
import { STRIP_PIXELS, type PngEncodeReply, type PngEncodeRequest } from "./messages.js";

/**
 * Encode `picture` as a PNG, at the window's pixel density and never under twice its natural
 * size, so it stays sharp where it is pasted and scaled; rastered whole when a canvas within
 * `canvasLimits` holds it, and drawn in tiles otherwise. Rejects when the picture cannot be
 * decoded, drawn or encoded, which the copy reports as failed.
 */
export async function encodeDiagramPng(
  picture: DrawnDiagram,
  ownerWindow: Window,
  canvasLimits: { readonly side: number; readonly area: number } = CANVAS_LIMITS,
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
  const isWhole =
    width <= canvasLimits.side &&
    height <= canvasLimits.side &&
    width * height <= canvasLimits.area;
  // One tile the picture's size has no margins; a cut picture's strips never have fewer rows than a
  // margin, so a very wide picture's strips are not mostly margins drawn and left out.
  const tileColumns = isWhole ? width : Math.min(TILE_COLUMNS, canvasLimits.side - 2 * TILE_MARGIN);
  const stripRows = isWhole
    ? height
    : Math.max(TILE_MARGIN, Math.floor(STRIP_PIXELS / width) - 2 * TILE_MARGIN);
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
    await answerOf(encoder, {
      kind: "start",
      width,
      height,
      groundColor: picture.groundColor,
    });
    for (let top = 0; top < height; top += stripRows) {
      const rows = Math.min(stripRows, height - top);
      const above = Math.min(TILE_MARGIN, top);
      const below = Math.min(TILE_MARGIN, height - top - rows);
      for (let left = 0; left < width; left += tileColumns) {
        const columns = Math.min(tileColumns, width - left);
        const before = Math.min(TILE_MARGIN, left);
        const after = Math.min(TILE_MARGIN, width - left - columns);
        let bitmap: ImageBitmap;
        if (isWhole) {
          // Rastered off the page's thread, on no ground; the worker lays it on the ground.
          bitmap = await createImageBitmap(image, { resizeWidth: width, resizeHeight: height });
        } else {
          if (tile.width !== before + columns + after || tile.height !== above + rows + below) {
            tile.width = before + columns + after;
            tile.height = above + rows + below;
          }
          context.fillStyle = picture.groundColor;
          context.fillRect(0, 0, tile.width, tile.height);
          // The whole picture drawn shifted up and left past the tile's margins, so each tile's
          // pixels are the whole drawing's; the canvas keeps only the tile and its margins.
          context.drawImage(image, before - left, above - top, width, height);
          bitmap = tile.transferToImageBitmap();
        }
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

/** The largest canvas Chromium draws: 32,767 pixels a side and 268,435,456 pixels in all. */
const CANVAS_LIMITS = { side: 32_767, area: 268_435_456 } as const;

/** The most columns one tile of a picture wider than a canvas keeps. */
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

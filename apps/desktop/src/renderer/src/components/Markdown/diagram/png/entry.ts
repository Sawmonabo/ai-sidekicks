// The PNG encoder worker: takes the tiles the page drew of one picture until they fill a strip of
// rows, then lays them side by side on the ground a band of rows at a time and writes each band
// into a PNG, so the encode, which grows with the picture's pixels, never runs on the page's
// thread, and only one strip's tiles and one band's pixels are held at a time. The page ends it
// once it answers.

import { STRIP_PIXELS, type PngEncodeReply, type PngEncodeRequest } from "./messages.js";
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

/** A tile the page drew, with where its own pixels start inside the bitmap. */
type Tile = Extract<PngEncodeRequest, { kind: "tile" }>;

/**
 * One picture's encoding: its PNG so far, the tiles of the strip they are filling, how many of the
 * strip's columns they fill, and the canvas each tile's pixels are read from.
 */
interface PictureEncoding {
  readonly png: PngStream;
  readonly width: number;
  readonly groundColor: string;
  readonly canvas: OffscreenCanvas;
  readonly context: OffscreenCanvasRenderingContext2D;
  tiles: Tile[];
  filledColumns: number;
}

/** Encodes one picture at a time from the page's requests. */
class PictureEncoder {
  #encoding: PictureEncoding | undefined;

  /**
   * What `request` comes to. Rejects for a tile or end with no start before it, a tile unlike its
   * strip's height or past the picture's width, and an end before the last strip is filled.
   */
  public async handle(request: PngEncodeRequest): Promise<PngEncodeReply> {
    if (request.kind === "start") {
      const canvas = new OffscreenCanvas(1, 1);
      // Every band is read back, so its pixels are kept where a read is cheap.
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (context === null) {
        throw new Error("This worker cannot read a picture's pixels.");
      }
      this.#encoding = {
        png: new PngStream(request.width, request.height),
        width: request.width,
        groundColor: request.groundColor,
        canvas,
        context,
        tiles: [],
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
      if (encoding.tiles.length > 0) {
        throw new Error("A picture ended before its last strip's tiles filled it.");
      }
      const png = await encoding.png.finish();
      return { status: "encoded", png: png.buffer };
    }
    const stripRows = encoding.tiles[0]?.rows ?? request.rows;
    if (request.rows !== stripRows || encoding.filledColumns + request.columns > encoding.width) {
      request.bitmap.close();
      throw new Error("A picture's tile does not fit its strip.");
    }
    encoding.tiles.push(request);
    encoding.filledColumns += request.columns;
    if (encoding.filledColumns < encoding.width) {
      return { status: "taken" };
    }
    const tiles = encoding.tiles;
    encoding.tiles = [];
    encoding.filledColumns = 0;
    try {
      await writeStrip(encoding, tiles, stripRows);
    } finally {
      for (const tile of tiles) {
        tile.bitmap.close();
      }
    }
    return { status: "taken" };
  }
}

/**
 * Writes the strip `tiles` fill, left to right and `rows` high, into `encoding`'s PNG a band of
 * rows at a time, each band read from every tile in turn.
 */
async function writeStrip(
  encoding: PictureEncoding,
  tiles: readonly Tile[],
  rows: number,
): Promise<void> {
  const { png, width, groundColor, canvas, context } = encoding;
  const rowBytes = 1 + width * 4;
  const bandRows = Math.max(1, Math.floor(STRIP_PIXELS / width));
  for (let top = 0; top < rows; top += bandRows) {
    const band = Math.min(bandRows, rows - top);
    // All zero, which opens each row on its filter type: none.
    const scanlines = new Uint8Array(band * rowBytes);
    let firstColumn = 0;
    for (const tile of tiles) {
      if (canvas.width !== tile.columns || canvas.height !== band) {
        canvas.width = tile.columns;
        canvas.height = band;
      }
      // A whole picture's raster has no ground; a tile the page drew on it covers this one.
      context.fillStyle = groundColor;
      context.fillRect(0, 0, tile.columns, band);
      context.drawImage(tile.bitmap, -tile.firstColumn, -(tile.firstRow + top));
      const pixels = context.getImageData(0, 0, tile.columns, band).data;
      for (let row = 0; row < band; row += 1) {
        scanlines.set(
          pixels.subarray(row * tile.columns * 4, (row + 1) * tile.columns * 4),
          row * rowBytes + 1 + firstColumn * 4,
        );
      }
      firstColumn += tile.columns;
    }
    await png.writeRows(scanlines, band);
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

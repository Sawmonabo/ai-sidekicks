// A drawn diagram as PNG bytes, for `Copy as picture`: the picture decoded as an image and painted
// on its own ground, since a transparent picture pastes onto whatever ground the target has.

import { pictureBlobOf } from "./pictures.js";
import type { DrawnDiagram } from "./worker/messages.js";

/**
 * Encode `picture` as a PNG, at the window's pixel density and never under twice its natural
 * size, so it stays sharp where it is pasted and scaled. Rejects when the picture cannot be decoded
 * or encoded, which the copy reports as failed.
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
  const canvas = ownerWindow.document.createElement("canvas");
  canvas.width = Math.ceil(picture.width * scale);
  canvas.height = Math.ceil(picture.height * scale);
  const context = canvas.getContext("2d");
  if (context === null) {
    throw new Error("This window cannot paint a picture to copy.");
  }
  context.fillStyle = picture.groundColor;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const png = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob === null) {
        reject(new Error("The picture could not be encoded as a PNG."));
      } else {
        resolve(blob);
      }
    }, "image/png");
  });
  return new Uint8Array(await png.arrayBuffer());
}

/** The least a copied picture is scaled by, so a paste from a low-density screen stays sharp. */
const MINIMUM_COPY_SCALE = 2;

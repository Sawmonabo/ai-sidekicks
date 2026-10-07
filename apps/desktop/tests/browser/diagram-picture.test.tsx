// A diagram drawn by the real library in Chromium, since happy-dom has no layout, no image decoding
// and no canvas: the place held for the picture, a picture an image can show, the kept picture a
// remount lands at, and the PNG `Copy as picture` writes.

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { userEvent } from "vitest/browser";

import { applyAppearance, installMeridianTokens } from "#renderer/app/token-installation.js";
import {
  DiagramBlock,
  type DiagramCopy,
} from "#renderer/components/Markdown/diagram/DiagramBlock.js";
import { TYPEFACE_FACES } from "#renderer/styles/typeface.js";
import { DEFAULT_APPEARANCE_RECORD } from "#shared/appearance.js";
import type { ClipboardContent } from "#shared/preload-api.js";

/** A short, wide diagram, drawn lower than the place held for it, with a label set on two lines. */
const SHORT_SOURCE = "flowchart LR\n  write[Write<br/>once] --> route\n  route --> store\n";

/** A tall diagram, drawn higher than the place held for it. */
const TALL_SOURCE =
  "flowchart TD\n  write --> route\n  route --> partition\n  partition --> index\n";

/** The eight bytes every PNG file opens with. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

afterEach(() => {
  cleanup();
});

/** Each copy's label, as a button that hands what it built to `onCopied`. */
function copyButtons(onCopied: (content: ClipboardContent) => void) {
  return (copy: DiagramCopy): React.ReactNode => (
    <button
      type="button"
      onClick={() => {
        void Promise.resolve(copy.content()).then(onCopied);
      }}
    >
      {copy.label}
    </button>
  );
}

function frameHeightIn(container: HTMLElement): number {
  return (
    container.querySelector(".meridian-diagram__frame") ?? expect.fail("the frame is drawn")
  ).getBoundingClientRect().height;
}

async function decodedPictureIn(container: HTMLElement): Promise<HTMLImageElement> {
  return waitFor(
    () => {
      const picture = container.querySelector("img");
      if (picture === null || !picture.complete || picture.naturalWidth === 0) {
        throw new Error("The picture has not been drawn and decoded yet.");
      }
      return picture;
    },
    { timeout: 10_000 },
  );
}

it("holds its place, draws an image, remounts at its height and copies a PNG", async () => {
  installMeridianTokens(document);
  applyAppearance(document, DEFAULT_APPEARANCE_RECORD);
  const copied: ClipboardContent[] = [];

  const short = render(
    <DiagramBlock
      source={SHORT_SOURCE}
      isSettled
      renderCopy={copyButtons((content) => copied.push(content))}
    />,
  );
  const heldHeight = frameHeightIn(short.container);
  const shortPicture = await decodedPictureIn(short.container);
  // The place held before the picture existed is the place it landed in.
  expect(frameHeightIn(short.container)).toBe(heldHeight);
  // Drawn at its natural size, not stretched to the column.
  expect(shortPicture.getBoundingClientRect().width).toBe(shortPicture.naturalWidth);
  // Labels are set in faces the image document can draw, so they fit the boxes measured for them.
  const markup = decodeURIComponent(shortPicture.src);
  for (const face of TYPEFACE_FACES) {
    expect(markup).not.toContain(face.family);
  }

  await userEvent.click(short.getByRole("button", { name: "Copy as picture" }));
  await waitFor(() => {
    expect(copied).toHaveLength(1);
  });
  const [content] = copied;
  const png = content !== undefined && "png" in content ? content.png : expect.fail("a PNG copy");
  expect([...png.slice(0, PNG_SIGNATURE.length)]).toStrictEqual(PNG_SIGNATURE);
  const bitmap = await createImageBitmap(new Blob([png], { type: "image/png" }));
  expect(bitmap.width).toBe(shortPicture.naturalWidth * Math.max(window.devicePixelRatio, 2));

  const tall = render(<DiagramBlock source={TALL_SOURCE} isSettled renderCopy={undefined} />);
  await decodedPictureIn(tall.container);
  const drawnHeight = frameHeightIn(tall.container);
  expect(drawnHeight).toBeGreaterThan(heldHeight);
  tall.unmount();

  const remounted = render(<DiagramBlock source={TALL_SOURCE} isSettled renderCopy={undefined} />);
  // Measured before the picture decodes: the kept size lays the frame out at its final height.
  expect(frameHeightIn(remounted.container)).toBe(drawnHeight);
});

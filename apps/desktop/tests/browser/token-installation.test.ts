// A window's faces are in before its rows draw: installing the token sheet loads every face, so
// the first run of a cut nothing has drawn yet, an italic, is laid out at that face on its first
// frame. Drawn in the fallback first, it sits on a line whose upright text is already in its
// face, and the line grows by the two faces' different heights until the italic lands.

import { expect, it, onTestFinished } from "vitest";

import { installMeridianTokens } from "#renderer/app/token-installation.js";

/** A width that wraps the run over several lines, so a face's glyph widths move its breaks. */
const REPLY_WIDTH_PX = 480;
/** Upright words, and an italic run among them on every line. */
const UPRIGHT_WORDS = "Plain words around the run. ";
const ITALIC_WORDS = "An italic run on the same line. ";
/** How many times the pair repeats, so the reply wraps over several lines. */
const LINE_PAIR_COUNT = 12;

/** A frame's own document, as the console opens a window on a blank one; removed afterwards. */
function openWindowDocument(): Document {
  const frame = document.createElement("iframe");
  frame.style.cssText = "position: fixed; inset: 0; width: 100vw; height: 100vh; border: 0;";
  document.body.append(frame);
  onTestFinished(() => {
    frame.remove();
  });
  return frame.contentDocument ?? expect.fail("the frame has no document");
}

/** Resolves after `count` of the document's frames have run. */
async function framesOf(windowDocument: Document, count: number): Promise<void> {
  const view = windowDocument.defaultView ?? expect.fail("the document has no window");
  for (let frame = 0; frame < count; frame += 1) {
    await new Promise((resolve) => view.requestAnimationFrame(resolve));
  }
}

it("lays a window's first italic run out at its face on its first frame", async () => {
  const windowDocument = openWindowDocument();
  installMeridianTokens(windowDocument);
  // The window draws its own upright text before a session's rows, as the console's chrome does.
  const chrome = windowDocument.createElement("p");
  chrome.style.fontFamily = "var(--meridian-font-sans)";
  chrome.textContent = UPRIGHT_WORDS;
  windowDocument.body.append(chrome);
  await windowDocument.fonts.ready;
  await framesOf(windowDocument, 2);

  const reply = windowDocument.createElement("p");
  reply.style.cssText = `width: ${String(REPLY_WIDTH_PX)}px; font-family: var(--meridian-font-sans);`;
  for (let pair = 0; pair < LINE_PAIR_COUNT; pair += 1) {
    const italic = windowDocument.createElement("em");
    italic.textContent = ITALIC_WORDS;
    reply.append(UPRIGHT_WORDS, italic);
  }
  windowDocument.body.append(reply);
  const firstFrameHeightPx = reply.getBoundingClientRect().height;

  await windowDocument.fonts.ready;
  await framesOf(windowDocument, 2);
  // The control: the run is drawn in the italic face, not a fallback that never loads.
  expect(windowDocument.fonts.check(`italic 1em "IBM Plex Sans"`)).toBe(true);
  expect(reply.getBoundingClientRect().height).toBe(firstFrameHeightPx);
});

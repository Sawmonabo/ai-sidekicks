// A diagram drawn by merman in its worker in Chromium, since happy-dom has no worker, no layout, no
// image decoding and no canvas: the place held for the picture, a picture an image can show, the
// kept picture a remount lands at, the PNG `Copy as picture` writes, the reason a refused diagram
// shows, a drawing that ran out of time, labels sized from the page's widths, a page that never
// measures them and one that grants no idle time, a link that goes nowhere, a diagram that cannot
// loosen its security, the layout a diagram asks for, and one worker for every window.

import { initMerman, type HostTextMeasurer } from "@mermanjs/web-render";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import { applyAppearance, installMeridianTokens } from "#renderer/app/token-installation.js";
import type { BlockCopyOffer } from "#renderer/components/Markdown/block-copy-offer.js";
import { DiagramBlock } from "#renderer/components/Markdown/diagram/DiagramBlock.js";
import { watchDiagramPalette } from "#renderer/components/Markdown/diagram/palette.js";
import {
  DiagramPictures,
  DiagramPicturesContext,
} from "#renderer/components/Markdown/diagram/pictures.js";
import { startDiagramWorker } from "#renderer/components/Markdown/diagram/worker/connection.js";
import {
  drawDiagram,
  drawMeasuredDiagram,
} from "#renderer/components/Markdown/diagram/worker/drawing.js";
import {
  DRAWING_DEADLINE_MS,
  type DiagramOutcome,
} from "#renderer/components/Markdown/diagram/worker/messages.js";
import { LabelWidths } from "#renderer/components/Markdown/diagram/worker/text-measurer.js";
import { OwnerWindowProvider } from "#renderer/components/OwnerWindow/OwnerWindowProvider.js";
import { TYPEFACE_FACES } from "#renderer/styles/typeface.js";
import { DEFAULT_APPEARANCE_RECORD } from "#shared/appearance.js";
import type { ClipboardContent } from "#shared/preload-api.js";

/** A short, wide diagram, drawn lower than the place held for it, with a label set on two lines. */
const SHORT_SOURCE = "flowchart LR\n  write[Write<br/>once] --> route\n  route --> store\n";

/** A tall diagram, drawn higher than the place held for it. */
const TALL_SOURCE =
  "flowchart TD\n  write --> route\n  route --> partition\n  partition --> index\n";

/** A mindmap, whose shown picture sets its labels as HTML. */
const MINDMAP_SOURCE = "mindmap\n  root((Release))\n    Build\n    Test\n      Unit\n    Ship\n";

/** A flowchart whose nodes link to script, by both of the grammar's link forms. */
const SCRIPT_LINK_SOURCE =
  'flowchart LR\n  open[Open] --> run[Run]\n  click open "javascript:alert(1)"\n' +
  '  click run href "javascript:alert(2)" "Run it"\n';

/** The same links, under front matter that asks for the loose security level. */
const LOOSE_SECURITY_SOURCE = `---\nconfig:\n  securityLevel: loose\n---\n${SCRIPT_LINK_SOURCE}`;

/** A flowchart with a node left open, which the parser refuses. */
const REFUSED_SOURCE = "flowchart TD\n  A --> B\n  B --> [Fix it\n";

/** A class diagram of one class, whose box is as wide as its name. */
const ONE_LABEL_SOURCE = "classDiagram\n  class SessionStore\n";

/** A flowchart whose layout differs between dagre and ELK. */
const LAYOUT_BODY = "flowchart TD\n  A --> B\n  B --> C\n  A --> C\n  C --> D\n  B --> D\n";

/** The eight bytes every PNG file opens with. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A share of memory far larger than these cases draw, so nothing is evicted mid-case. */
const TEST_CACHE_BYTE_CAP = 64 * 1024 * 1024;

/** Leaves the renderer's caches alone: no case here shows enough pictures to empty them for. */
const keepUnusedMemory = (): void => undefined;

beforeEach(() => {
  installMeridianTokens(document);
  applyAppearance(document, DEFAULT_APPEARANCE_RECORD);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Each copy's label, as a button that hands what it built to `onCopied`. */
function copyButtons(onCopied: (content: ClipboardContent) => void) {
  return (offer: BlockCopyOffer): React.ReactNode => (
    <button
      type="button"
      onClick={() => {
        void Promise.resolve(offer.content()).then(onCopied);
      }}
    >
      {offer.label}
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

function markupOf(outcome: DiagramOutcome): string {
  return outcome.kind === "drawn"
    ? outcome.markup
    : expect.fail(`the diagram is drawn, not refused: ${outcome.reason}`);
}

/** The shown picture of `source`, drawn through the queue every block uses. */
async function drawnPicture(pictures: DiagramPictures, source: string): Promise<string> {
  const palette = watchDiagramPalette(window).read();
  const outcome = await new Promise<DiagramOutcome>((resolve) => {
    pictures.request(source, palette, () => 0, resolve);
  });
  return markupOf(outcome);
}

/** Script a picture could run or a place it could send the reader, wherever it is written. */
function expectInert(markup: string): void {
  expect(markup).not.toMatch(/javascript:/iu);
  expect(markup).not.toMatch(/<script/iu);
  expect(markup).not.toMatch(/\son[a-z]+\s*=/iu);
  expect(markup).not.toMatch(/href\s*=/iu);
}

it("holds its place, draws an image, remounts at its height and copies a PNG", async () => {
  const pictures = new DiagramPictures(TEST_CACHE_BYTE_CAP, startDiagramWorker, keepUnusedMemory);
  const copied: ClipboardContent[] = [];
  const short = render(
    <DiagramPicturesContext.Provider value={pictures}>
      <DiagramBlock
        source={SHORT_SOURCE}
        isSettled
        renderCopy={copyButtons((content) => copied.push(content))}
      />
    </DiagramPicturesContext.Provider>,
  );
  const heldHeight = frameHeightIn(short.container);
  const shortPicture = await decodedPictureIn(short.container);
  // The place held before the picture existed is the place it landed in.
  expect(frameHeightIn(short.container)).toBe(heldHeight);
  // Drawn at its natural size, not stretched to the column.
  expect(shortPicture.getBoundingClientRect().width).toBe(shortPicture.naturalWidth);
  // Labels are set in faces the image document can draw, so they fit the boxes measured for them.
  const kept = pictures.read(SHORT_SOURCE, watchDiagramPalette(window).read());
  const markup = kept === undefined ? expect.fail("the picture is kept") : markupOf(kept);
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

  const tall = render(
    <DiagramPicturesContext.Provider value={pictures}>
      <DiagramBlock source={TALL_SOURCE} isSettled renderCopy={undefined} />
    </DiagramPicturesContext.Provider>,
  );
  await decodedPictureIn(tall.container);
  const drawnHeight = frameHeightIn(tall.container);
  expect(drawnHeight).toBeGreaterThan(heldHeight);
  tall.unmount();

  const remounted = render(
    <DiagramPicturesContext.Provider value={pictures}>
      <DiagramBlock source={TALL_SOURCE} isSettled renderCopy={undefined} />
    </DiagramPicturesContext.Provider>,
  );
  // Measured before the picture decodes: the kept size lays the frame out at its final height.
  expect(frameHeightIn(remounted.container)).toBe(drawnHeight);
});

it("copies a mindmap as a picture with no HTML labels, which would taint the canvas", async () => {
  const pictures = new DiagramPictures(TEST_CACHE_BYTE_CAP, startDiagramWorker, keepUnusedMemory);
  const palette = watchDiagramPalette(window).read();
  // The shown picture sets the mindmap's labels as HTML; the copy's carries none.
  expect(await drawnPicture(pictures, MINDMAP_SOURCE)).toContain("<foreignObject");
  expect(markupOf(await pictures.drawCopy(MINDMAP_SOURCE, palette))).not.toContain("foreignObject");

  const copied: ClipboardContent[] = [];
  const block = render(
    <DiagramPicturesContext.Provider value={pictures}>
      <DiagramBlock
        source={MINDMAP_SOURCE}
        isSettled
        renderCopy={copyButtons((content) => copied.push(content))}
      />
    </DiagramPicturesContext.Provider>,
  );
  await decodedPictureIn(block.container);
  await userEvent.click(block.getByRole("button", { name: "Copy as picture" }));
  await waitFor(
    () => {
      expect(copied).toHaveLength(1);
    },
    { timeout: 10_000 },
  );
  const [content] = copied;
  const png = content !== undefined && "png" in content ? content.png : expect.fail("a PNG copy");
  expect([...png.slice(0, PNG_SIGNATURE.length)]).toStrictEqual(PNG_SIGNATURE);
});

it("shows the parser's reason above the source of a diagram it refuses", async () => {
  const block = render(
    <DiagramPicturesContext.Provider
      value={new DiagramPictures(TEST_CACHE_BYTE_CAP, startDiagramWorker, keepUnusedMemory)}
    >
      <DiagramBlock source={REFUSED_SOURCE} isSettled renderCopy={undefined} />
    </DiagramPicturesContext.Provider>,
  );
  const line = await block.findByText(/^Could not draw this diagram · /u, {}, { timeout: 10_000 });
  // The parser's own reason, not a failure of the library or its worker.
  expect(line.textContent).toMatch(/^Could not draw this diagram · Diagram parse error/u);
  expect(block.container.querySelector("code")?.textContent).toBe(REFUSED_SOURCE);
  expect(block.container.querySelector("img")).toBeNull();
});

it("draws a link to script as inert text, and a diagram cannot loosen its security", async () => {
  const pictures = new DiagramPictures(TEST_CACHE_BYTE_CAP, startDiagramWorker, keepUnusedMemory);
  expectInert(await drawnPicture(pictures, SCRIPT_LINK_SOURCE));
  expectInert(await drawnPicture(pictures, LOOSE_SECURITY_SOURCE));
  expectInert(
    await drawnPicture(pictures, `%%{init: {"securityLevel": "loose"}}%%\n${SCRIPT_LINK_SOURCE}`),
  );
});

it("keeps a diagram in the screen's colors and type whatever its init or front matter asks", async () => {
  const pictures = new DiagramPictures(TEST_CACHE_BYTE_CAP, startDiagramWorker, keepUnusedMemory);
  const restyle = {
    theme: "dark",
    themeVariables: { primaryColor: "#ff00ff", lineColor: "#00ff00" },
    fontFamily: "Papyrus",
    fontSize: 31,
  };
  const plain = await drawnPicture(pictures, TALL_SOURCE);
  const throughInit = await drawnPicture(
    pictures,
    `%%{init: ${JSON.stringify(restyle)}}%%\n${TALL_SOURCE}`,
  );
  const throughFrontMatter = await drawnPicture(
    pictures,
    `---\nconfig:\n  theme: dark\n  themeVariables:\n    primaryColor: "#ff00ff"\n` +
      `  fontFamily: Papyrus\n  fontSize: 31\n---\n${TALL_SOURCE}`,
  );
  expect(throughInit).not.toMatch(/#ff00ff|#00ff00|Papyrus/iu);
  expect(throughInit).toBe(plain);
  expect(throughFrontMatter).toBe(plain);
});

it("reports a drawing that runs past merman's deadline as timed out, not as a refusal", async () => {
  await initMerman();
  let isFirstMeasure = true;
  let spins = 0;
  // The first label takes longer than the whole deadline to measure.
  const slowTextMeasurer: HostTextMeasurer = () => {
    if (isFirstMeasure) {
      isFirstMeasure = false;
      const until = performance.now() + DRAWING_DEADLINE_MS + 100;
      while (performance.now() < until) {
        spins += 1;
      }
    }
    return { handled: false };
  };
  const palette = watchDiagramPalette(window).read();
  expect(drawDiagram(LAYOUT_BODY, palette, "shown", slowTextMeasurer)).toStrictEqual({
    status: "timed-out",
  });
  expect(spins).toBeGreaterThan(0);
});

it("sizes a drawing's second pass from the widths the page measured", async () => {
  await initMerman();
  const palette = watchDiagramPalette(window).read();
  const labelWidths = new LabelWidths();
  const own = drawDiagram(ONE_LABEL_SOURCE, palette, "shown", () => ({ handled: false }));
  const ownOutcome = own.status === "settled" ? own.outcome : expect.fail(own.status);
  // The page measures the label far wider than merman's own rules make it, inside a line's width.
  const pageWidth = 300;
  const drawing = await drawMeasuredDiagram(
    ONE_LABEL_SOURCE,
    palette,
    "shown",
    labelWidths,
    (labels) => {
      labelWidths.fill(
        labels.map(({ face, texts }) => ({
          face,
          texts,
          lineHeight: 20,
          widths: texts.map(() => pageWidth),
        })),
      );
      return Promise.resolve(true);
    },
  );
  const outcome = drawing.status === "settled" ? drawing.outcome : expect.fail(drawing.status);
  const widthOf = (drawn: DiagramOutcome) => (drawn.kind === "drawn" ? drawn.width : 0);
  // The box grows by the page's width over merman's, about a hundred pixels or more.
  expect(widthOf(outcome)).toBeGreaterThan(widthOf(ownOutcome) + 100);
});

it("draws with merman's own widths and keeps nothing when the page never measures", async () => {
  // The page is never idle, so it never measures the labels the worker asks for.
  vi.stubGlobal("requestIdleCallback", () => 0);
  const pictures = new DiagramPictures(TEST_CACHE_BYTE_CAP, startDiagramWorker, keepUnusedMemory);
  const palette = watchDiagramPalette(window).read();
  const outcome = await new Promise<DiagramOutcome>((resolve) => {
    pictures.request(ONE_LABEL_SOURCE, palette, () => 0, resolve);
  });
  expect(outcome.kind).toBe("drawn");
  expect(pictures.read(ONE_LABEL_SOURCE, palette)).toBeUndefined();
});

it("measures the labels and keeps the picture when the page grants no idle time", async () => {
  // The page is never idle: a callback runs only once its wait for idle time runs out.
  vi.stubGlobal(
    "requestIdleCallback",
    (callback: IdleRequestCallback, options?: IdleRequestOptions) =>
      setTimeout(
        () => {
          callback({ didTimeout: true, timeRemaining: () => 0 });
        },
        options?.timeout ?? 2 ** 31 - 1,
      ),
  );
  const pictures = new DiagramPictures(TEST_CACHE_BYTE_CAP, startDiagramWorker, keepUnusedMemory);
  const palette = watchDiagramPalette(window).read();
  await drawnPicture(pictures, ONE_LABEL_SOURCE);
  expect(pictures.read(ONE_LABEL_SOURCE, palette)?.kind).toBe("drawn");
});

it("lays a flowchart out with dagre, and with ELK when the diagram asks for it", async () => {
  const pictures = new DiagramPictures(TEST_CACHE_BYTE_CAP, startDiagramWorker, keepUnusedMemory);
  const unset = await drawnPicture(pictures, LAYOUT_BODY);
  const dagre = await drawnPicture(pictures, `---\nconfig:\n  layout: dagre\n---\n${LAYOUT_BODY}`);
  const elk = await drawnPicture(pictures, `---\nconfig:\n  layout: elk\n---\n${LAYOUT_BODY}`);
  expect(unset).toBe(dagre);
  expect(elk).not.toBe(dagre);
});

it("draws every window's diagrams in one worker", async () => {
  const startedWorkers: Worker[] = [];
  const NativeWorker = globalThis.Worker;
  vi.stubGlobal(
    "Worker",
    class extends NativeWorker {
      public constructor(scriptUrl: string | URL, options?: WorkerOptions) {
        super(scriptUrl, options);
        startedWorkers.push(this);
      }
    },
  );
  const secondWindow = document.body.appendChild(document.createElement("iframe"));
  const secondDocument = secondWindow.contentDocument ?? expect.fail("the frame has a document");
  installMeridianTokens(secondDocument);
  applyAppearance(secondDocument, DEFAULT_APPEARANCE_RECORD);
  const pictures = new DiagramPictures(TEST_CACHE_BYTE_CAP, startDiagramWorker, keepUnusedMemory);

  const first = render(
    <DiagramPicturesContext.Provider value={pictures}>
      <DiagramBlock
        source={"flowchart LR\n  first --> window\n"}
        isSettled
        renderCopy={undefined}
      />
    </DiagramPicturesContext.Provider>,
  );
  const second = render(
    <DiagramPicturesContext.Provider value={pictures}>
      <OwnerWindowProvider window={secondWindow.contentWindow ?? expect.fail("a second window")}>
        <DiagramBlock
          source={"flowchart LR\n  second --> window\n"}
          isSettled
          renderCopy={undefined}
        />
      </OwnerWindowProvider>
    </DiagramPicturesContext.Provider>,
    { container: secondDocument.body.appendChild(secondDocument.createElement("div")) },
  );

  await decodedPictureIn(first.container);
  await decodedPictureIn(second.container);
  expect(startedWorkers).toHaveLength(1);
  secondWindow.remove();
});

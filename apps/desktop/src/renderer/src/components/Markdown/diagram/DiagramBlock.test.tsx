// The diagram worker stands in for itself here, since happy-dom runs no worker; the real drawing
// is the browser tier's. Each case gets its own pictures, so nothing one case drew is kept for
// another.

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";

import { RESOLVED_SCHEME_ATTRIBUTE } from "#shared/appearance.js";
import { DiagramBlock } from "./DiagramBlock.js";
import { DiagramPictures, DiagramPicturesContext } from "./pictures.js";
import {
  drawnOutcome,
  FakeDiagramWorkers,
  type FakeDiagramWorker,
} from "./worker/connection.test-support.js";
import type { DiagramOutcome } from "./worker/messages.js";

/** A share far larger than these cases draw. */
const CACHE_BYTE_CAP = 16 * 1024 * 1024;

/** Leaves the renderer's caches alone: no case here shows enough pictures to empty them for. */
const keepUnusedMemory = (): void => undefined;

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute(RESOLVED_SCHEME_ATTRIBUTE);
  document.documentElement.style.removeProperty("font-size");
  document.documentElement.style.removeProperty("--meridian-transcript-width");
});

function renderBlock(pictures: DiagramPictures, source: string) {
  return render(
    <DiagramPicturesContext.Provider value={pictures}>
      <DiagramBlock source={source} isSettled renderCopy={undefined} />
    </DiagramPicturesContext.Provider>,
  );
}

/** Lets the queue choose its next drawing, which it does once the turn's asks have arrived. */
async function settleQueue(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

/** Answers the worker's latest drawing and lets the block draw what it heard. */
async function answer(worker: FakeDiagramWorker, outcome: DiagramOutcome): Promise<void> {
  await act(async () => {
    worker.answer(outcome);
    await Promise.resolve();
  });
}

describe("a diagram block", () => {
  it("draws once in the worker, and a remount shows the kept picture at its size", async () => {
    const workers = new FakeDiagramWorkers();
    const pictures = new DiagramPictures(CACHE_BYTE_CAP, workers.start, keepUnusedMemory);
    const source = "flowchart LR\n  kept --> remounted\n";
    const first = renderBlock(pictures, source);
    // The source holds the picture's place until the picture lands.
    expect(first.container.querySelector("code")?.textContent).toBe(source);
    await settleQueue();
    expect(workers.latest().requests.map((request) => request.source)).toStrictEqual([source]);
    await answer(workers.latest(), drawnOutcome("kept"));
    expect(first.container.querySelector("img")).not.toBeNull();
    first.unmount();

    const second = renderBlock(pictures, source);

    // On the first render, before any effect runs.
    const picture = second.container.querySelector("img");
    expect(picture?.getAttribute("width")).toBe("121");
    expect(picture?.getAttribute("height")).toBe("80");
    expect(picture?.getAttribute("src")).toMatch(/^blob:/u);
    expect(second.container.querySelector("code")).toBeNull();
    await settleQueue();
    expect(workers.started).toHaveLength(1);
    expect(workers.latest().requests).toHaveLength(1);
  });

  it("keeps a picture's address while another block shows it, and revokes it after", async () => {
    const revoked = vi.spyOn(URL, "revokeObjectURL");
    onTestFinished(() => {
      revoked.mockRestore();
    });
    const workers = new FakeDiagramWorkers();
    const pictures = new DiagramPictures(CACHE_BYTE_CAP, workers.start, keepUnusedMemory);
    const source = "flowchart LR\n  shown --> twice\n";
    const first = renderBlock(pictures, source);
    await settleQueue();
    await answer(workers.latest(), drawnOutcome("shared"));
    const second = renderBlock(pictures, source);
    const address = second.container.querySelector("img")?.getAttribute("src");
    expect(first.container.querySelector("img")?.getAttribute("src")).toBe(address);

    first.unmount();
    expect(revoked).not.toHaveBeenCalled();
    second.unmount();
    expect(revoked).toHaveBeenCalledWith(address);
  });

  it("shows the reason above its source when it cannot be drawn", async () => {
    const workers = new FakeDiagramWorkers();
    const source = "flowchart TD\n  A --> B\n  A -->> oops\n";
    const { container } = renderBlock(
      new DiagramPictures(CACHE_BYTE_CAP, workers.start, keepUnusedMemory),
      source,
    );
    await settleQueue();
    await answer(workers.latest(), { kind: "failed", reason: "Diagram parse error on line 3" });

    expect(
      screen.getByText("Could not draw this diagram · Diagram parse error on line 3"),
    ).toBeTruthy();
    expect(container.querySelector("code")?.textContent).toBe(source);
    expect(container.querySelector("img")).toBeNull();
  });

  it("is drawn again when the scheme or the text size changes, and for nothing else", async () => {
    const root = document.documentElement;
    root.setAttribute(RESOLVED_SCHEME_ATTRIBUTE, "light");
    const workers = new FakeDiagramWorkers();
    const { container } = renderBlock(
      new DiagramPictures(CACHE_BYTE_CAP, workers.start, keepUnusedMemory),
      "flowchart LR\n  scheme --> size\n",
    );
    await settleQueue();
    await answer(workers.latest(), drawnOutcome("light"));
    const lightPicture = container.querySelector("img")?.getAttribute("src");

    act(() => {
      root.setAttribute(RESOLVED_SCHEME_ATTRIBUTE, "dark");
    });
    await settleQueue();
    const worker = workers.latest();
    expect(worker.requests.at(-1)?.palette.isDark).toBe(true);
    // The light picture stays until the dark one lands.
    expect(container.querySelector("img")?.getAttribute("src")).toBe(lightPicture);
    await answer(worker, drawnOutcome("dark"));

    act(() => {
      root.style.setProperty("font-size", "20px");
    });
    await settleQueue();
    expect(worker.requests.at(-1)?.palette.fontSizePx).toBe(16.25);
    await answer(worker, drawnOutcome("larger"));

    act(() => {
      root.style.setProperty("--meridian-transcript-width", "40rem");
      root.setAttribute(RESOLVED_SCHEME_ATTRIBUTE, "dark");
    });
    await settleQueue();
    expect(worker.requests).toHaveLength(3);
  });
});

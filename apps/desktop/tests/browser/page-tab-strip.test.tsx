// The tab strip's drag, against a real `DataTransfer` and a real cascade. happy-dom's drag
// events carry no `DataTransfer`, so the co-located cases use a hand-rolled stand-in that
// decides what `types`, `getData` and `effectAllowed` do; they prove the strip's arithmetic,
// not how it handles the real object. Two things here are the browser's:
//
// - The clipboard store: `setData` lowercases the format, `types` is the browser's own list,
//   and a private MIME type must survive that round trip. The strip's writer and its two
//   readers are one seam, and this drives all three ends.
// - The cascade: the drop marker and the selected-tab mark are declarations in
//   `PageTabStrip.css`, and a rule whose selector matches nothing computes to the same value as
//   one never written. No unit tier can tell those apart.

import { act } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderSettled } from "../helpers/app-harness.js";

import { crossMacrotaskBoundary } from "../helpers/macrotask-boundary.js";

import { installMeridianTokens } from "@renderer/app/token-installation.js";
import { PageTabStrip } from "@renderer/features/preview/components/PageTabStrip.js";
import { threePreviewPages } from "@renderer/features/preview/page-list-reading.test-support.js";
import { PAGE_TAB_DRAG_MEDIA_TYPE } from "@renderer/features/preview/tab-reorder.js";
// The preview feature's pane registration, imported for its side effect.
import "@renderer/features/preview/contributions/panes.js";

/** An unselected tab's computed border color: `getComputedStyle` resolves `transparent` to it. */
const TRANSPARENT_BORDER = "rgba(0, 0, 0, 0)";

/** What the strip reported, so a case can assert the translated move index. */
interface DraggedStrip {
  readonly tabs: readonly HTMLElement[];
  readonly reordered: { readonly pageId: string; readonly toIndex: number }[];
}

async function mountStrip(): Promise<DraggedStrip> {
  installMeridianTokens(document);
  const reordered: { readonly pageId: string; readonly toIndex: number }[] = [];
  const { container } = await renderSettled(
    <PageTabStrip
      reading={threePreviewPages()}
      onSelect={() => undefined}
      onClose={() => undefined}
      onReorder={(pageId, toIndex) => {
        reordered.push({ pageId, toIndex });
      }}
    />,
  );
  return {
    tabs: [...container.querySelectorAll<HTMLElement>(".meridian-preview-tab")],
    reordered,
  };
}

/**
 * Dispatch one real drag event, let the render it caused land, and report whether the strip
 * claimed it. `dispatchEvent` answers `false` exactly when a listener called `preventDefault`,
 * which for `dragover` is the acceptance: without it the element is not a drop target.
 *
 * The settle is required: React treats `dragover` as a continuous event, so its state is
 * scheduled rather than flushed, and an immediate style read would see the frame before the
 * marker.
 */
async function dispatchDrag(
  target: HTMLElement,
  type: "dragstart" | "dragover" | "drop",
  dataTransfer: DataTransfer,
): Promise<boolean> {
  let accepted = false;
  await act(async () => {
    accepted = !target.dispatchEvent(
      new DragEvent(type, { dataTransfer, bubbles: true, cancelable: true }),
    );
    await crossMacrotaskBoundary();
  });
  return accepted;
}

function borderStartColorOf(element: HTMLElement): string {
  return getComputedStyle(element).borderInlineStartColor;
}

describe("dragging a tab, against the browser's own drag store", () => {
  it("round-trips the private payload through the strip's own writer and reader", async () => {
    const strip = await mountStrip();
    const transfer = new DataTransfer();
    await dispatchDrag(strip.tabs[0] as HTMLElement, "dragstart", transfer);
    // The browser's list, not one this file built.
    //
    // `effectAllowed` is not asserted: Chromium honors that setter only during a genuine user
    // drag, so for a `DragEvent` this file dispatches it reads `"none"` however the writer
    // behaves. The cursor shape it governs is checked by dragging a tab by hand.
    expect([...transfer.types]).toContain(PAGE_TAB_DRAG_MEDIA_TYPE);
    expect(transfer.getData(PAGE_TAB_DRAG_MEDIA_TYPE)).toBe("page-a");

    expect(await dispatchDrag(strip.tabs[2] as HTMLElement, "dragover", transfer)).toBe(true);
    await dispatchDrag(strip.tabs[2] as HTMLElement, "drop", transfer);
    // Position 2 among three drawn tabs, with the dragged tab taken out, is index 1.
    expect(strip.reordered).toEqual([{ pageId: "page-a", toIndex: 1 }]);
  });

  it("paints the drop marker on the tab the drag is over, and only while it is", async () => {
    const strip = await mountStrip();
    const transfer = new DataTransfer();
    await dispatchDrag(strip.tabs[0] as HTMLElement, "dragstart", transfer);
    const target = strip.tabs[2] as HTMLElement;
    const atRest = borderStartColorOf(target);

    await dispatchDrag(target, "dragover", transfer);
    expect(target.className).toContain("meridian-preview-tab--drop-before");
    const marked = borderStartColorOf(target);
    expect(marked).not.toBe(atRest);

    await dispatchDrag(target, "drop", transfer);
    expect(target.className).not.toContain("meridian-preview-tab--drop-before");
    expect(borderStartColorOf(target)).toBe(atRest);
  });

  it("draws the selected tab differently from its neighbors", async () => {
    const strip = await mountStrip();
    const selected = strip.tabs[0] as HTMLElement;
    const neighbor = strip.tabs[1] as HTMLElement;
    // The neighbor is pinned to the transparent value, not only "different from the selected
    // one": inequality alone passes for a rule that stopped matching in either direction.
    expect(getComputedStyle(neighbor).borderTopColor).toBe(TRANSPARENT_BORDER);
    expect(getComputedStyle(selected).borderTopColor).not.toBe(TRANSPARENT_BORDER);
  });

  it("negative control: a drag carrying another type is not this strip's", async () => {
    // Why the payload is a private MIME type: a stray drag the strip accepted would reorder a
    // tab from a file dropped in from the desktop, and a drop it claimed but could not read
    // would swallow it from whatever else in the window would have taken it.
    const strip = await mountStrip();
    const foreign = new DataTransfer();
    foreign.setData("text/plain", "page-a");
    const target = strip.tabs[2] as HTMLElement;
    const atRest = borderStartColorOf(target);

    expect(await dispatchDrag(target, "dragover", foreign)).toBe(false);
    expect(borderStartColorOf(target)).toBe(atRest);
    await dispatchDrag(target, "drop", foreign);
    expect(strip.reordered).toEqual([]);
  });
});

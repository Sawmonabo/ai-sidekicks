// The tab strip's drag, against a real `DataTransfer` and a real cascade.
//
// This belongs to the browser tier and can belong nowhere else, and the reason is the
// unit suite's own scaffolding: happy-dom's drag events carry no `DataTransfer` at
// all, so the co-located cases hand the strip a hand-rolled stand-in. That stand-in is
// the INPUT to everything they assert — it decides what `types` contains, what
// `getData` returns, and whether assigning `effectAllowed` sticks — so those cases
// prove the strip's arithmetic and prove nothing about the object it will actually be
// handed. Two things here are the browser's and not a stub's:
//
//   • THE CLIPBOARD STORE. `setData` converts the format to ASCII lowercase, `types`
//     is the browser's own list rather than one this file built, and a private MIME
//     type is only useful if it survives that round trip intact. The strip's writer
//     and its two readers are one seam, and this drives all three ends of it.
//   • THE CASCADE. The drop marker and the selected-tab mark are both one declaration
//     in `pane/pane.css`, and a rule whose selector matches nothing computes to the
//     same value as a rule that was never written. No unit tier can tell those apart,
//     and the selected-tab rule was in exactly that state — keyed on an `aria-current`
//     the item never carries, because the attribute belongs on the face inside it.

import { act } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderSettled } from "../console-harness.js";

import { crossMacrotaskBoundary } from "../../../src/renderer/src/console/core/macrotask-boundary.test-support.js";

import { installMeridianTokens } from "../../../src/renderer/src/console/frame/index.js";
import { TabStrip } from "../../../src/renderer/src/console/browser/pane/TabStrip.js";
import { threeBrowserPages } from "../../../src/renderer/src/console/browser/pane/page-state.test-support.js";
import { BROWSER_TAB_DRAG_MEDIA_TYPE } from "../../../src/renderer/src/console/browser/pane/tab-reorder.js";
// The family door, imported for its side effect: this package puts a family's
// stylesheet behind its own barrel and nowhere else, and two of the cases below are
// about what that stylesheet computes to.
import "../../../src/renderer/src/console/browser/index.js";

/** What the strip reported, so a case can assert the translated move index. */
interface DraggedStrip {
  readonly tabs: readonly HTMLElement[];
  readonly reordered: { readonly pageId: string; readonly toIndex: number }[];
}

async function mountStrip(): Promise<DraggedStrip> {
  installMeridianTokens(document);
  const reordered: { readonly pageId: string; readonly toIndex: number }[] = [];
  const { container } = await renderSettled(
    <TabStrip
      reading={threeBrowserPages()}
      onSelect={() => undefined}
      onClose={() => undefined}
      onCreate={() => undefined}
      onReorder={(pageId, toIndex) => {
        reordered.push({ pageId, toIndex });
      }}
    />,
  );
  return {
    tabs: [...container.querySelectorAll<HTMLElement>(".meridian-browser-tab")],
    reordered,
  };
}

/**
 * Dispatch one real drag event, let the render it caused land, and report whether the
 * strip claimed it.
 *
 * `dispatchEvent` answers `false` exactly when a listener called `preventDefault`,
 * which for `dragover` IS the acceptance: an element that does not prevent the
 * default is not a drop target and the drop never fires there.
 *
 * THE SETTLE IS NOT OPTIONAL AND IT IS NOT A TIMING TWEAK. React treats `dragover` as
 * a continuous event, so the state it sets is scheduled rather than flushed the way a
 * click's is — a case that read the computed style straight after the dispatch would
 * measure the frame BEFORE the marker, and report "the marker does not paint" for a
 * strip that paints it correctly one frame later.
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
    // The browser's list, not one this file built: the writer put the type on and the
    // store kept it under exactly that key.
    //
    // `effectAllowed` is deliberately NOT asserted, and the reason is a limit of this
    // harness rather than a gap in the writer. Chromium honours that setter only while
    // a genuine user drag is in flight; a `DragEvent` this file constructs and
    // dispatches is not one, so the assignment is dropped and the property reads
    // `"none"` however the writer behaves. An assertion that cannot fail for the right
    // reason cannot pass for it either — the cursor shape it governs is verified by
    // dragging a tab, and by nothing that runs unattended.
    expect([...transfer.types]).toContain(BROWSER_TAB_DRAG_MEDIA_TYPE);
    expect(transfer.getData(BROWSER_TAB_DRAG_MEDIA_TYPE)).toBe("page-a");

    expect(await dispatchDrag(strip.tabs[2] as HTMLElement, "dragover", transfer)).toBe(true);
    await dispatchDrag(strip.tabs[2] as HTMLElement, "drop", transfer);
    // Slot 2 among three drawn tabs, with the dragged tab taken out, is index 1.
    expect(strip.reordered).toEqual([{ pageId: "page-a", toIndex: 1 }]);
  });

  it("paints the drop marker on the slot the drag is over, and only while it is", async () => {
    const strip = await mountStrip();
    const transfer = new DataTransfer();
    await dispatchDrag(strip.tabs[0] as HTMLElement, "dragstart", transfer);
    const target = strip.tabs[2] as HTMLElement;
    const atRest = borderStartColorOf(target);

    await dispatchDrag(target, "dragover", transfer);
    expect(target.className).toContain("meridian-browser-tab--drop-before");
    const marked = borderStartColorOf(target);
    expect(marked).not.toBe(atRest);

    await dispatchDrag(target, "drop", transfer);
    expect(target.className).not.toContain("meridian-browser-tab--drop-before");
    expect(borderStartColorOf(target)).toBe(atRest);
  });

  it("draws the selected tab differently from its neighbours", async () => {
    const strip = await mountStrip();
    const selected = strip.tabs[0] as HTMLElement;
    const neighbour = strip.tabs[1] as HTMLElement;
    expect(getComputedStyle(selected).borderTopColor).not.toBe(
      getComputedStyle(neighbour).borderTopColor,
    );
  });

  it("negative control: a drag carrying another type is not this strip's", async () => {
    // The whole reason the payload is a private MIME type. A drag the strip accepted
    // by mistake would reorder a tab from a file dropped out of the desktop, and a
    // drop the strip claimed and could not read would swallow it from whatever else
    // in the window would have taken it.
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

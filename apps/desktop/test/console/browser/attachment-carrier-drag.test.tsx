// Reordering the carrier with a pointer, against the real drag adapter.
//
// THIS TIER AND NO OTHER, for three reasons the co-located suite cannot supply:
//
//   • THE ADAPTER REFUSES A DRAG WITH NO `DataTransfer` and says so on the console.
//     happy-dom's `DragEvent` carries none, so every drag dispatched there is declined
//     before the library looks at the row — a suite that "drove the drag" would have
//     been asserting against a gesture that never started.
//   • THE DRAG-HANDLE GATE IS A HIT TEST. The adopted library decides whether a press
//     began on the grip by asking `document.elementFromPoint` what is under the
//     pointer, which needs layout. That gate is the whole reason the grip exists as a
//     separate control, and it is unobservable without a box.
//   • THE MARKS ARE A CASCADE. `data-drop-target` and `data-dragging` are two
//     declarations in `attachments.css`, and a rule whose selector matches nothing
//     computes to what no rule at all computes to. No unit tier can tell those apart.
//
// WHERE A DROP LANDS IS NOT ASSERTED TWICE. `attachment-reorder.ts` owns the
// arithmetic and its own suite pins it; what is checked here is that the gesture
// reaches that arithmetic at all, and with which two attachments.

import { act } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderSettled } from "../console-harness.js";

import { crossMacrotaskBoundary } from "../../../src/renderer/src/console/core/macrotask-boundary.test-support.js";
import { ManualClock } from "../../../src/renderer/src/console/core/index.js";
import { LiveAnnouncerProvider } from "../../../src/renderer/src/console/primitives/index.js";
import { installMeridianTokens } from "../../../src/renderer/src/console/frame/index.js";
import { CarrierList } from "../../../src/renderer/src/console/repos/attachments/CarrierList.js";
import {
  CARRIER_ENTRY_MILLISECONDS,
  threeAttachmentCarrier,
} from "../../../src/renderer/src/console/repos/attachments/carrier-entries.test-support.js";
// The family door, imported for its side effect: this package puts a family's
// stylesheets behind its own barrel and nowhere else, and two of the cases below are
// about what those rules compute to.
import "../../../src/renderer/src/console/repos/index.js";

/** The per-attachment bound these rows are measured against — none of them is near it. */
const ADMITTED_BYTES = 1_000_000;

/** What the list reported, so a case can assert the move the gesture asked for. */
interface DraggedCarrier {
  readonly rows: readonly HTMLElement[];
  readonly grips: readonly HTMLElement[];
  readonly moves: { readonly localId: string; readonly toPosition: number }[];
}

async function mountCarrier(): Promise<DraggedCarrier> {
  installMeridianTokens(document);
  const moves: { readonly localId: string; readonly toPosition: number }[] = [];
  const { container } = await renderSettled(
    <LiveAnnouncerProvider clock={new ManualClock()}>
      <CarrierList
        entries={threeAttachmentCarrier()}
        publishedAtMilliseconds={CARRIER_ENTRY_MILLISECONDS}
        maximumByteLength={ADMITTED_BYTES}
        onRetry={() => undefined}
        onAbandon={() => undefined}
        onReorder={(localId, toPosition) => {
          moves.push({ localId, toPosition });
        }}
      />
    </LiveAnnouncerProvider>,
  );
  return {
    rows: [...container.querySelectorAll<HTMLElement>("li.meridian-carrier-row")],
    grips: [...container.querySelectorAll<HTMLElement>(".meridian-carrier-row__grip")],
    moves,
  };
}

/** The centre of an element, which is where a person would have pressed. */
function centreOf(element: HTMLElement): { readonly clientX: number; readonly clientY: number } {
  const box = element.getBoundingClientRect();
  return { clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 };
}

/**
 * Dispatch one real drag event at a point, and let the render it caused land.
 *
 * THE COORDINATES ARE NOT DECORATION. The adapter reads them off the event for both of
 * its own decisions — the drag-handle hit test on `dragstart`, and the input it hands
 * every drop target afterwards — so an event dispatched at the origin starts no drag
 * from a grip that is not at the origin.
 *
 * THE SETTLE IS NOT A TIMING TWEAK. The library schedules `onDragStart` on an animation
 * frame and flushes it when the drop-target hierarchy first changes, so the row's own
 * `data-dragging` mark is one frame behind the dispatch that caused it.
 */
async function dispatchDrag(
  target: HTMLElement,
  type: "dragstart" | "dragenter" | "dragover" | "drop" | "dragend",
  dataTransfer: DataTransfer,
  at: HTMLElement = target,
): Promise<void> {
  await act(async () => {
    target.dispatchEvent(
      new DragEvent(type, { dataTransfer, bubbles: true, cancelable: true, ...centreOf(at) }),
    );
    await crossMacrotaskBoundary();
  });
}

/** Start a drag on one row, pressing on its own grip. */
async function beginDrag(carrier: DraggedCarrier, index: number): Promise<DataTransfer> {
  const transfer = new DataTransfer();
  await dispatchDrag(
    carrier.rows[index] as HTMLElement,
    "dragstart",
    transfer,
    carrier.grips[index] as HTMLElement,
  );
  return transfer;
}

describe("dragging an attachment, against the real drag adapter", () => {
  it("moves the dragged attachment to the position of the row it is dropped on", async () => {
    const carrier = await mountCarrier();
    const transfer = await beginDrag(carrier, 0);
    const target = carrier.rows[2] as HTMLElement;

    await dispatchDrag(target, "dragenter", transfer);
    await dispatchDrag(target, "drop", transfer);

    // The third row's declared position, which is where the first attachment goes.
    // The number is the list's answer and not this file's: `attachment-reorder.ts`
    // resolved it from the entry the drop landed on.
    expect(carrier.moves).toEqual([{ localId: "attachment-1", toPosition: 2 }]);
  });

  it("marks the row being dragged and the row under the pointer, and clears both", async () => {
    const carrier = await mountCarrier();
    const source = carrier.rows[0] as HTMLElement;
    const target = carrier.rows[2] as HTMLElement;
    const atRestOpacity = getComputedStyle(source).opacity;
    const atRestShadow = getComputedStyle(target).boxShadow;

    const transfer = await beginDrag(carrier, 0);
    await dispatchDrag(target, "dragenter", transfer);

    expect(source.dataset["dragging"]).toBe("true");
    expect(target.dataset["dropTarget"]).toBe("true");
    // Both marks are pinned to a COMPUTED value and not only to the attribute: the
    // attribute is this component's and the appearance is the stylesheet's, and a
    // selector that stopped matching would leave the first assertion passing while a
    // participant saw nothing move.
    expect(getComputedStyle(source).opacity).not.toBe(atRestOpacity);
    expect(getComputedStyle(target).boxShadow).not.toBe(atRestShadow);

    await dispatchDrag(target, "drop", transfer);
    expect(source.dataset["dragging"]).toBeUndefined();
    expect(target.dataset["dropTarget"]).toBeUndefined();
    expect(getComputedStyle(source).opacity).toBe(atRestOpacity);
    expect(getComputedStyle(target).boxShadow).toBe(atRestShadow);
  });

  it("negative control: a drop back on the row the drag started from moves nothing", async () => {
    // The `canDrop` refusal, which is the difference between a gesture that changed
    // nothing and a live region announcing "moved to position 1 of 3" about an
    // attachment that is exactly where it was.
    const carrier = await mountCarrier();
    const source = carrier.rows[0] as HTMLElement;
    const transfer = await beginDrag(carrier, 0);

    await dispatchDrag(source, "dragenter", transfer);
    expect(source.dataset["dropTarget"]).toBeUndefined();
    await dispatchDrag(source, "drop", transfer);

    expect(carrier.moves).toEqual([]);
  });

  it("negative control: a press that did not begin on the grip starts no drag", async () => {
    // The whole reason the grip is a control of its own. Without the hit test the row
    // itself would be the handle, and selecting the file name inside the card — or
    // pressing the card's own retry control — would lift the row instead.
    const carrier = await mountCarrier();
    const transfer = new DataTransfer();
    const source = carrier.rows[0] as HTMLElement;
    await dispatchDrag(
      source,
      "dragstart",
      transfer,
      source.querySelector(".meridian-carrier-row__body") as HTMLElement,
    );

    expect(source.dataset["dragging"]).toBeUndefined();
    await dispatchDrag(carrier.rows[2] as HTMLElement, "dragenter", transfer);
    await dispatchDrag(carrier.rows[2] as HTMLElement, "drop", transfer);
    expect(carrier.moves).toEqual([]);
  });
});

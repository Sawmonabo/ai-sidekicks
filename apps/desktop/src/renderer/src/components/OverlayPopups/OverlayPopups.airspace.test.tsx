// A modal's backdrop is airspace, and this proves each wrapper registers it. The visibility
// predicate in `features/preview/geometry/pane-geometry.ts` hides a native view only where a
// registered overlay rectangle overlaps the pane, so an unregistered full-viewport backdrop
// would leave a web page painted over a modal.
//
// Asserted through a mount, since only a mount sees the ref reach the rendered element and the
// registration go away on close. The non-modal menu wrapper is here too, to prove it does not
// claim the whole window.

import { render } from "@testing-library/react";
import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Dialog } from "@base-ui/react/dialog";
import { Menu } from "@base-ui/react/menu";
import { describe, expect, it } from "vitest";

import { airspaceRegistryFor } from "@renderer/lib/airspace-registries.js";
import { type AirspaceRect } from "@renderer/lib/airspace-registry.js";
import { OverlayAlertDialogPopup } from "./OverlayAlertDialogPopup.js";
import { OverlayDialogPopup } from "./OverlayDialogPopup.js";
import { OverlayMenuPopup } from "./OverlayMenuPopup.js";

/** The class that lets each case find the backdrop again. */
const BACKDROP_CLASS = "probe-backdrop";

/** The box a fixed `inset: 0` backdrop occupies; planted because the DOM shim lays nothing out. */
const VIEWPORT_RECT: AirspaceRect = { x: 0, y: 0, width: 1440, height: 900 };

/** One overlay primitive, opened and closed by the `open` this harness controls. */
interface OverlayCase {
  readonly name: string;
  readonly render: (open: boolean) => React.JSX.Element;
}

const MODAL_CASES: readonly OverlayCase[] = [
  {
    name: "OverlayDialogPopup",
    render: (open) => (
      <Dialog.Root open={open} modal="trap-focus">
        <OverlayDialogPopup backdropClassName={BACKDROP_CLASS} className="popup" label="A dialog">
          body
        </OverlayDialogPopup>
      </Dialog.Root>
    ),
  },
  {
    name: "OverlayAlertDialogPopup",
    render: (open) => (
      <AlertDialog.Root open={open}>
        <OverlayAlertDialogPopup backdropClassName={BACKDROP_CLASS} className="popup">
          body
        </OverlayAlertDialogPopup>
      </AlertDialog.Root>
    ),
  },
];

const NON_MODAL_CASES: readonly OverlayCase[] = [
  {
    name: "OverlayMenuPopup",
    render: (open) => (
      <Menu.Root open={open}>
        <Menu.Trigger>open</Menu.Trigger>
        <OverlayMenuPopup positionerClassName="positioner" className="popup">
          <Menu.Item>an act</Menu.Item>
        </OverlayMenuPopup>
      </Menu.Root>
    ),
  },
];

/** The backdrop the open modal drew, with a viewport-sized box planted on it. */
function plantViewportBackdrop(): void {
  const backdrop = document.querySelector(`.${BACKDROP_CLASS}`);
  if (!(backdrop instanceof HTMLElement)) {
    throw new Error("the modal drew no backdrop to register");
  }
  backdrop.getBoundingClientRect = (): DOMRect => VIEWPORT_RECT as DOMRect;
}

describe("a modal overlay's airspace", () => {
  it("covers every shared overlay wrapper", () => {
    // Vacuity floor: a removed case would leave the loop silent about its wrapper.
    expect(MODAL_CASES.map((modal) => modal.name)).toStrictEqual([
      "OverlayDialogPopup",
      "OverlayAlertDialogPopup",
    ]);
    expect(NON_MODAL_CASES.map((popup) => popup.name)).toStrictEqual(["OverlayMenuPopup"]);
  });

  it.each(MODAL_CASES)("$name registers the backdrop's whole rectangle", ({ render: open }) => {
    const registry = airspaceRegistryFor(document);
    const mounted = render(open(false));
    expect(registry.liveRects()).not.toContainEqual(VIEWPORT_RECT);
    mounted.rerender(open(true));
    plantViewportBackdrop();
    expect(registry.liveRects()).toContainEqual(VIEWPORT_RECT);
    mounted.unmount();
  });

  it.each(MODAL_CASES)("$name releases the backdrop on close", ({ render: open }) => {
    const registry = airspaceRegistryFor(document);
    const before = registry.registeredCount;
    const mounted = render(open(true));
    plantViewportBackdrop();
    // Both rectangles are the modal's: the backdrop covers the window, and the popup still
    // registers where a nested dialog draws no backdrop.
    expect(registry.registeredCount).toBe(before + 2);
    mounted.rerender(open(false));
    expect(registry.registeredCount).toBe(before);
    expect(registry.liveRects()).not.toContainEqual(VIEWPORT_RECT);
    mounted.unmount();
    expect(registry.registeredCount).toBe(before);
  });

  it.each(NON_MODAL_CASES)("$name registers its popup and nothing else", ({ render: open }) => {
    const registry = airspaceRegistryFor(document);
    const before = registry.registeredCount;
    const mounted = render(open(true));
    expect(registry.registeredCount).toBe(before + 1);
    expect(document.querySelector(`.${BACKDROP_CLASS}`)).toBeNull();
    mounted.rerender(open(false));
    expect(registry.registeredCount).toBe(before);
    mounted.unmount();
  });
});

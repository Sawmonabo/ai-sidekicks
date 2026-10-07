// A modal's backdrop and a combobox's list are airspace, and this proves each wrapper registers
// it. The visibility predicate in `features/preview/geometry/pane.ts` hides a native view only
// where a registered overlay rectangle overlaps the pane, so an unregistered backdrop or list
// would leave a web page painted over it.
//
// Asserted through a mount, since only a mount sees the ref reach the rendered element and the
// registration go away on close.

import { render } from "@testing-library/react";
import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Combobox } from "@base-ui/react/combobox";
import { Dialog } from "@base-ui/react/dialog";
import { describe, expect, it } from "vitest";

import { airspaceRegistryFor } from "#renderer/lib/airspace.js";
import { type AirspaceRect } from "#renderer/lib/airspace.js";
import { OverlayAlertDialogPopup } from "./OverlayAlertDialogPopup.js";
import { OverlayComboboxPopup } from "./OverlayComboboxPopup.js";
import { OverlayDialogPopup } from "./OverlayDialogPopup.js";

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

/** The backdrop the open modal drew, with a viewport-sized box planted on it. */
function plantViewportBackdrop(): void {
  const backdrop = document.querySelector(`.${BACKDROP_CLASS}`);
  if (!(backdrop instanceof HTMLElement)) {
    throw new Error("the modal drew no backdrop to register");
  }
  backdrop.getBoundingClientRect = (): DOMRect => VIEWPORT_RECT as DOMRect;
}

describe("a modal overlay's airspace", () => {
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
});

describe("a combobox list's airspace", () => {
  it("OverlayComboboxPopup registers the list while open and releases it on close", () => {
    const registry = airspaceRegistryFor(document);
    const before = registry.registeredCount;
    const combobox = (open: boolean): React.JSX.Element => (
      <Combobox.Root items={["opus"]} open={open}>
        <Combobox.Input aria-label="Model" />
        <OverlayComboboxPopup className="popup">
          <Combobox.List>
            <Combobox.Item value="opus">opus</Combobox.Item>
          </Combobox.List>
        </OverlayComboboxPopup>
      </Combobox.Root>
    );
    const mounted = render(combobox(true));
    expect(registry.registeredCount).toBe(before + 1);
    mounted.rerender(combobox(false));
    expect(registry.registeredCount).toBe(before);
    mounted.unmount();
  });
});

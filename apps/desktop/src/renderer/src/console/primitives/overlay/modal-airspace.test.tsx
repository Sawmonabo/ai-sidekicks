// A modal's BACKDROP is airspace, and this is what proves the wrappers register it.
//
// WHAT WAS WRONG. Each modal wrapper registered the popup's rectangle and nothing
// else, while the thing that actually covers the window — the fixed, full-viewport
// backdrop — was registered nowhere. The visibility predicate in
// `browser/geometry/pane-geometry.ts` hides a native view only where a registered
// overlay rectangle OVERLAPS the pane, so in a multi-pane layout a `WebContentsView`
// the dialog's own box did not cross stayed painted above the backdrop and kept its
// input: a live web page over a modal, eating the click that should have dismissed
// it. The registry has no "suppress everything" arm and needs none — a full-viewport
// rectangle IS that suppression — so what was missing was the registration.
//
// WHY IT IS ASSERTED THROUGH A MOUNT. The architecture gate next door reads source
// and can see that a backdrop carries an airspace ref; only a mount can see that the
// ref reached the element the library rendered and that the registration went away
// when the modal closed.
//
// AND WHY THE NON-MODAL FAMILIES ARE HERE TOO. The fix is worth nothing if it made
// every anchored popup claim the whole window: a menu that suppressed every native
// view in the window would be a far louder defect than the one it replaced. The three
// non-modal wrappers mount no backdrop, and the cases below say so by counting.

import { render } from "@testing-library/react";
import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Combobox } from "@base-ui/react/combobox";
import { Dialog } from "@base-ui/react/dialog";
import { Menu } from "@base-ui/react/menu";
import { Select } from "@base-ui/react/select";
import { describe, expect, it } from "vitest";

import { airspaceRegistryFor, type AirspaceRect } from "../../core/index.js";
import { OverlayAlertDialogPopup } from "./OverlayAlertDialogPopup.js";
import { OverlayComboboxPopup } from "./OverlayComboboxPopup.js";
import { OverlayDialogPopup } from "./OverlayDialogPopup.js";
import { OverlayMenuPopup } from "./OverlayMenuPopup.js";
import { OverlaySelectPopup } from "./OverlaySelectPopup.js";

/** The class every case below hangs on the backdrop so it can be found again. */
const BACKDROP_CLASS = "probe-backdrop";

/**
 * The box a fixed `inset: 0` backdrop occupies, stood in for.
 *
 * The shim lays nothing out, so the rectangle is planted rather than measured — which
 * is the honest instrument for this claim anyway: what is being asserted is that the
 * BACKDROP's own live box reaches the airspace, and a stand-in that no cascade could
 * have produced is one no accident could produce either.
 */
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
  {
    name: "OverlayComboboxPopup",
    render: (open) => (
      <Combobox.Root items={["one"]} open={open}>
        <OverlayComboboxPopup positionerClassName="positioner" className="popup">
          <Combobox.List>
            <Combobox.Item value="one">one</Combobox.Item>
          </Combobox.List>
        </OverlayComboboxPopup>
      </Combobox.Root>
    ),
  },
  {
    name: "OverlaySelectPopup",
    render: (open) => (
      <Select.Root items={[{ label: "one", value: "one" }]} open={open}>
        <OverlaySelectPopup className="popup">
          <Select.Item value="one">
            <Select.ItemText>one</Select.ItemText>
          </Select.Item>
        </OverlaySelectPopup>
      </Select.Root>
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
  it("covers every modal wrapper the family publishes", () => {
    // The vacuity floor: a case removed would leave the loop below saying nothing
    // about the wrapper it stopped covering.
    expect(MODAL_CASES.map((modal) => modal.name)).toStrictEqual([
      "OverlayDialogPopup",
      "OverlayAlertDialogPopup",
    ]);
    expect(NON_MODAL_CASES.map((popup) => popup.name)).toStrictEqual([
      "OverlayMenuPopup",
      "OverlayComboboxPopup",
      "OverlaySelectPopup",
    ]);
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
    // The popup and the backdrop are two rectangles and both are the modal's: the
    // backdrop is what covers the window, and the popup registration is what still
    // stands where a nested dialog renders no backdrop of its own.
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

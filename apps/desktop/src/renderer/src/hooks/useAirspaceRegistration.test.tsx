// The one airspace registration site, driven through a real mount.
//
// The hook registers what is attached and releases it on detach, and every shared overlay
// primitive attaches it, so opening one puts its own rectangles in the airspace and closing
// it takes exactly those back out. Only a mount can see the ref reach the element.
//
// How many rectangles is part of the claim: a modal registers two (the popup and the
// backdrop that covers the window), an anchored popup one. `OverlayPopups.airspace.test.tsx`
// owns what each rectangle is; this file asserts the count rises on open by exactly what the
// primitive puts up and returns to where it started on close.
// what that primitive puts up, and it comes back down to where it started on close.

import { render } from "@testing-library/react";
import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Dialog } from "@base-ui/react/dialog";
import { Menu } from "@base-ui/react/menu";
import { describe, expect, it } from "vitest";

import { airspaceRegistryFor } from "@renderer/lib/airspace-registries.js";
import { useAirspaceRegistration } from "./useAirspaceRegistration.js";
import { OverlayAlertDialogPopup } from "@renderer/components/OverlayPopups/OverlayAlertDialogPopup.js";
import { OverlayDialogPopup } from "@renderer/components/OverlayPopups/OverlayDialogPopup.js";
import { OverlayMenuPopup } from "@renderer/components/OverlayPopups/OverlayMenuPopup.js";

function OverlayProbe(props: { readonly open: boolean }): React.JSX.Element {
  const airspaceRef = useAirspaceRegistration("dialog");
  return props.open ? <div ref={airspaceRef} data-testid="popup" /> : <div />;
}

/** One overlay primitive, opened and closed by the `open` this harness controls. */
interface OverlayPrimitiveCase {
  readonly name: string;
  /**
   * How many rectangles this primitive puts in the airspace while it is open.
   *
   * Named per case rather than defaulted to one: a modal covers the window and says so with a
   * second rectangle.
   */
  readonly registrations: number;
  readonly render: (open: boolean) => React.JSX.Element;
}

/**
 * Every shared overlay primitive, each in the smallest tree that opens it. The combobox and
 * select popups belong to features and carry their own airspace tests.
 *
 * A table, so a primitive added without a case here is a diff a reviewer sees beside the
 * module.
 */
const OVERLAY_PRIMITIVE_CASES: readonly OverlayPrimitiveCase[] = [
  {
    name: "OverlayDialogPopup",
    registrations: 2,
    render: (open) => (
      <Dialog.Root open={open} modal="trap-focus">
        <OverlayDialogPopup backdropClassName="backdrop" className="popup" label="A dialog">
          body
        </OverlayDialogPopup>
      </Dialog.Root>
    ),
  },
  {
    name: "OverlayAlertDialogPopup",
    registrations: 2,
    render: (open) => (
      <AlertDialog.Root open={open}>
        <OverlayAlertDialogPopup backdropClassName="backdrop" className="popup">
          body
        </OverlayAlertDialogPopup>
      </AlertDialog.Root>
    ),
  },
  {
    name: "OverlayMenuPopup",
    registrations: 1,
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

describe("useAirspaceRegistration", () => {
  it("registers an attached overlay and removes it on unmount", () => {
    const registry = airspaceRegistryFor(document);
    const before = registry.registeredCount;
    const mounted = render(<OverlayProbe open />);
    expect(registry.registeredCount).toBe(before + 1);
    mounted.unmount();
    expect(registry.registeredCount).toBe(before);
  });

  it("registers nothing while the overlay is closed", () => {
    const registry = airspaceRegistryFor(document);
    const before = registry.registeredCount;
    const mounted = render(<OverlayProbe open={false} />);
    expect(registry.registeredCount).toBe(before);
    mounted.unmount();
  });

  it("registers on open and removes again on close, without remounting", () => {
    const registry = airspaceRegistryFor(document);
    const before = registry.registeredCount;
    const mounted = render(<OverlayProbe open={false} />);
    mounted.rerender(<OverlayProbe open />);
    expect(registry.registeredCount).toBe(before + 1);
    mounted.rerender(<OverlayProbe open={false} />);
    expect(registry.registeredCount).toBe(before);
    mounted.unmount();
  });

  it("reads the element's live rectangle rather than one captured at registration", () => {
    const registry = airspaceRegistryFor(document);
    const mounted = render(<OverlayProbe open />);
    const popup = mounted.getByTestId("popup");
    popup.getBoundingClientRect = () =>
      ({ x: 4, y: 8, width: 120, height: 60 }) as unknown as DOMRect;
    expect(registry.liveRects()).toContainEqual({ x: 4, y: 8, width: 120, height: 60 });
    mounted.unmount();
  });
});

describe("the overlay primitives", () => {
  it("covers every shared overlay primitive", () => {
    // The vacuity floor: a table with a case removed would leave the loop below passing over
    // the rest and saying nothing about the one it dropped.
    expect(OVERLAY_PRIMITIVE_CASES.map((probe) => probe.name)).toStrictEqual([
      "OverlayDialogPopup",
      "OverlayAlertDialogPopup",
      "OverlayMenuPopup",
    ]);
  });

  it.each(OVERLAY_PRIMITIVE_CASES)(
    "$name registers its $registrations on open and releases them on close",
    ({ registrations, render: renderCase }) => {
      const registry = airspaceRegistryFor(document);
      const before = registry.registeredCount;
      const mounted = render(renderCase(false));
      expect(registry.registeredCount).toBe(before);
      mounted.rerender(renderCase(true));
      expect(registry.registeredCount).toBe(before + registrations);
      mounted.rerender(renderCase(false));
      expect(registry.registeredCount).toBe(before);
      mounted.unmount();
      expect(registry.registeredCount).toBe(before);
    },
  );
});

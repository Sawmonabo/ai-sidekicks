// The primitive layer's one registration site, driven through a real mount.
//
// Two claims, and the second is the one the architecture gate cannot make. The hook
// registers what is attached and releases it on detach — and every overlay PRIMITIVE
// actually attaches it, so opening any of the five puts its own rectangles in the
// airspace and closing it takes exactly those back out. A gate that reads source can
// see the hook is called; only a mount can see the ref reached the element.
//
// HOW MANY RECTANGLES IS PART OF THE CLAIM, per primitive. A modal registers two —
// the popup and the backdrop that covers the window — and an anchored popup registers
// one; `overlay/modal-airspace.ts` owns that difference and `overlay/
// modal-airspace.test.tsx` owns what each of the two rectangles IS. What is asserted
// here is the arithmetic every primitive shares: the count goes up on open by exactly
// what that primitive puts up, and it comes back down to where it started on close.

import { render } from "@testing-library/react";
import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Combobox } from "@base-ui/react/combobox";
import { Dialog } from "@base-ui/react/dialog";
import { Menu } from "@base-ui/react/menu";
import { Select } from "@base-ui/react/select";
import { describe, expect, it } from "vitest";

import { airspaceRegistryFor } from "../core/index.js";
import { useAirspaceRegistration } from "./airspace-registration.js";
import { OverlayAlertDialogPopup } from "./overlay/OverlayAlertDialogPopup.js";
import { OverlayComboboxPopup } from "./overlay/OverlayComboboxPopup.js";
import { OverlayDialogPopup } from "./overlay/OverlayDialogPopup.js";
import { OverlayMenuPopup } from "./overlay/OverlayMenuPopup.js";
import { OverlaySelectPopup } from "./overlay/OverlaySelectPopup.js";

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
   * Named per case rather than defaulted to one: a default would be a number three
   * cases agree with and two are exempted from, and the exemption is the interesting
   * half — a modal covers the window and says so with a second rectangle.
   */
  readonly registrations: number;
  readonly render: (open: boolean) => React.JSX.Element;
}

/**
 * Every overlay primitive the family publishes, each in the smallest tree that opens
 * it.
 *
 * Written as a table so a primitive added without a case here is a diff a reviewer
 * sees beside the module — the architecture gate keeps the SOURCE claim, and this
 * keeps the mounted one.
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
  {
    name: "OverlayComboboxPopup",
    registrations: 1,
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
    registrations: 1,
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
  it("covers every overlay primitive the family publishes", () => {
    // The vacuity floor. A table with a case removed would leave the loop below
    // passing over four primitives and saying nothing about the fifth.
    expect(OVERLAY_PRIMITIVE_CASES.map((probe) => probe.name)).toStrictEqual([
      "OverlayDialogPopup",
      "OverlayAlertDialogPopup",
      "OverlayMenuPopup",
      "OverlayComboboxPopup",
      "OverlaySelectPopup",
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

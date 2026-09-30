// The popup's airspace through a real mount: open registers only its own rectangle, with no
// backdrop, and close releases it.

import { render } from "@testing-library/react";
import { Combobox } from "@base-ui/react/combobox";
import { describe, expect, it } from "vitest";

import { airspaceRegistryFor } from "@renderer/lib/airspace-registries.js";
import { OverlayComboboxPopup } from "./OverlayComboboxPopup.js";

function renderCombobox(open: boolean): React.JSX.Element {
  return (
    <Combobox.Root items={["one"]} open={open}>
      <OverlayComboboxPopup positionerClassName="positioner" className="popup">
        <Combobox.List>
          <Combobox.Item value="one">one</Combobox.Item>
        </Combobox.List>
      </OverlayComboboxPopup>
    </Combobox.Root>
  );
}

describe("OverlayComboboxPopup's airspace", () => {
  it("registers its popup alone on open and releases it on close", () => {
    // One rectangle and no backdrop: an anchored popup that claimed the whole window
    // would hide every native view in it.
    const registry = airspaceRegistryFor(document);
    const before = registry.registeredCount;
    const mounted = render(renderCombobox(false));
    expect(registry.registeredCount).toBe(before);
    mounted.rerender(renderCombobox(true));
    expect(registry.registeredCount).toBe(before + 1);
    mounted.rerender(renderCombobox(false));
    expect(registry.registeredCount).toBe(before);
    mounted.unmount();
    expect(registry.registeredCount).toBe(before);
  });
});

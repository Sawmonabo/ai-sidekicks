// Opening the select popup puts exactly its own popup in the window's airspace, with no backdrop;
// closing takes it back out. Driven through a real mount.

import { render } from "@testing-library/react";
import { Select } from "@base-ui/react/select";
import { describe, expect, it } from "vitest";

import { airspaceRegistryFor } from "@renderer/lib/airspace-registries.js";
import { OverlaySelectPopup } from "./OverlaySelectPopup.js";

function renderSelect(open: boolean): React.JSX.Element {
  return (
    <Select.Root items={[{ label: "one", value: "one" }]} open={open}>
      <OverlaySelectPopup className="popup">
        <Select.Item value="one">
          <Select.ItemText>one</Select.ItemText>
        </Select.Item>
      </OverlaySelectPopup>
    </Select.Root>
  );
}

describe("OverlaySelectPopup's airspace", () => {
  it("registers its popup alone on open and releases it on close", () => {
    // An anchored popup that claimed the whole window would hide every native view in it.
    const registry = airspaceRegistryFor(document);
    const before = registry.registeredCount;
    const mounted = render(renderSelect(false));
    expect(registry.registeredCount).toBe(before);
    mounted.rerender(renderSelect(true));
    expect(registry.registeredCount).toBe(before + 1);
    mounted.rerender(renderSelect(false));
    expect(registry.registeredCount).toBe(before);
    mounted.unmount();
    expect(registry.registeredCount).toBe(before);
  });
});

// The data page offers nothing, names the four audit rows verbatim, and never
// claims destruction on demand.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DataErasurePage, registerDataErasurePage } from "./DataErasurePage.js";
import { SettingsPageRegistry } from "../../settings-page-registry.js";

describe("data and erasure page", () => {
  it("says erasure is an operator procedure in this release", () => {
    const { container } = render(<DataErasurePage />);
    expect(container.textContent ?? "").toContain("an operator procedure");
  });

  it("names the four purge audit rows in their wire spelling", () => {
    const { container } = render(<DataErasurePage />);
    const chipLabels = [...container.querySelectorAll(".meridian-chip__label")].map(
      (element) => element.textContent ?? "",
    );
    expect(chipLabels).toStrictEqual([
      "session.purge_requested",
      "session.purged",
      "participant.purge_requested",
      "participant.purged",
    ]);
  });

  it("offers no control at all", () => {
    // The section's own rule — no export control, no erase control, and nothing
    // that would call a stub. Every interactive element is counted, not just the
    // ones a particular selector knows about.
    const { container } = render(<DataErasurePage />);
    expect(container.querySelectorAll("button, input, select, textarea, a[href]")).toHaveLength(0);
  });

  it("negative control: the control count bites on a page that offers one", () => {
    // Without this, the assertion above would pass over any tree that happened to
    // render no button — including an empty one — and would prove nothing about
    // this page's rule.
    const { container } = render(
      <div>
        <button type="button">Erase everything</button>
      </div>,
    );
    expect(container.querySelectorAll("button, input, select, textarea, a[href]")).toHaveLength(1);
  });

  it("claims the data section with a search vocabulary", () => {
    const registry = new SettingsPageRegistry();
    registerDataErasurePage(registry);
    const descriptor = registry.descriptorFor("data");
    expect(descriptor?.label).toBe("Data and erasure");
    expect(descriptor?.keywords).toContain("purge");
  });
});

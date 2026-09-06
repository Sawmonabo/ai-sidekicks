// The diagnostics page reports five separate unasked questions, composes no
// verdict, and draws no recovery control.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DiagnosticsPage, registerDiagnosticsPage } from "./DiagnosticsPage.js";
import { SettingsPageRegistry } from "../../settings-page-registry.js";

/** The five regions the design enumerates, by their accessible names. */
const EXPECTED_REGION_LABELS = [
  "Execution health",
  "Stuck runs",
  "Failure detail",
  "Recovery",
  "Diagnostic redaction",
];

describe("diagnostics page", () => {
  it("renders one region per read the design names, each with its own absence", () => {
    const { container } = render(<DiagnosticsPage />);
    const labels = [...container.querySelectorAll("section[aria-label]")].map(
      (element) => element.getAttribute("aria-label") ?? "",
    );
    for (const expected of EXPECTED_REGION_LABELS) {
      expect(labels).toContain(expected);
    }
    // Five absences, not one blanket "diagnostics unavailable": the count is the
    // claim, so it is asserted rather than described.
    expect(container.querySelectorAll(".meridian-nothing--not-checked")).toHaveLength(
      EXPECTED_REGION_LABELS.length,
    );
  });

  it("uses the not-checked kind rather than an empty or an error", () => {
    // "Nobody asked" and "there is none" are different facts. An `empty` here would
    // claim this machine is healthy; an `error` would claim a read failed.
    const { container } = render(<DiagnosticsPage />);
    expect(container.querySelector(".meridian-nothing--empty")).toBeNull();
    expect(container.querySelector(".meridian-nothing--error")).toBeNull();
  });

  it("draws no recovery control, disabled or otherwise", () => {
    const { container } = render(<DiagnosticsPage />);
    expect(container.querySelectorAll("button, input, select, textarea")).toHaveLength(0);
  });

  it("negative control: the control sweep bites on a disabled button", () => {
    // The rule is that an unavailable action is ABSENT, not greyed out — so the
    // sweep has to catch a disabled control, which is the shape it is guarding
    // against. Without this, the clean result above would also pass on a page that
    // rendered three disabled recovery buttons.
    const { container } = render(
      <div>
        <button type="button" disabled>
          Retry
        </button>
      </div>,
    );
    expect(container.querySelectorAll("button, input, select, textarea")).toHaveLength(1);
  });

  it("claims the diagnostics section with a search vocabulary", () => {
    const registry = new SettingsPageRegistry();
    registerDiagnosticsPage(registry);
    const descriptor = registry.descriptorFor("diagnostics");
    expect(descriptor?.label).toBe("Diagnostics and health");
    expect(descriptor?.keywords).toContain("stuck");
  });
});

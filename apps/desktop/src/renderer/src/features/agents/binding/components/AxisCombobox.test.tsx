// No vocabulary, no control: a disabled combobox would claim the axis is momentarily
// unavailable, which the daemon never said, so an absent or empty vocabulary renders nothing.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AxisCombobox } from "./AxisCombobox.js";

describe("axis combobox — an unavailable axis is absent, never disabled", () => {
  it("renders nothing when the vocabulary is absent", () => {
    const { container } = render(
      <AxisCombobox
        label="Effort"
        options={undefined}
        value={undefined}
        onValueChange={() => {}}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when the vocabulary is empty", () => {
    // Empty and absent differ on the wire and agree here: neither can be chosen from.
    const { container } = render(
      <AxisCombobox label="Effort" options={[]} value={undefined} onValueChange={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("negative control: a published vocabulary does render the field", () => {
    // Otherwise the cases above would pass for a component that always renders nothing.
    const { container } = render(
      <AxisCombobox
        label="Effort"
        options={["low", "high"]}
        value="low"
        onValueChange={() => {}}
      />,
    );
    expect(container.querySelector(".meridian-axis-field")).not.toBeNull();
    expect(container.textContent ?? "").toContain("Effort");
  });

  it("draws no disabled control in any of the three cases", () => {
    // Absence is the degradation; a disabled control anywhere here would be wrong.
    for (const options of [undefined, [], ["low"]] as (readonly string[] | undefined)[]) {
      const { container } = render(
        <AxisCombobox
          label="Effort"
          options={options}
          value={undefined}
          onValueChange={() => {}}
        />,
      );
      expect(container.querySelector("[disabled]")).toBeNull();
      expect(container.querySelector('[aria-disabled="true"]')).toBeNull();
    }
  });
});

describe("axis combobox — the override mark", () => {
  it("marks a field the caller edited over a definition's value", () => {
    const { container } = render(
      <AxisCombobox
        label="Effort"
        options={["low", "high"]}
        value="low"
        onValueChange={() => {}}
        isOverridden
      />,
    );
    expect(container.querySelector(".meridian-axis-field__overridden")).not.toBeNull();
  });

  it("negative control: an unedited field carries no mark", () => {
    const { container } = render(
      <AxisCombobox
        label="Effort"
        options={["low", "high"]}
        value="low"
        onValueChange={() => {}}
      />,
    );
    expect(container.querySelector(".meridian-axis-field__overridden")).toBeNull();
  });
});

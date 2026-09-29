// The one rule this control exists to hold: no vocabulary, no control.
//
// A disabled combobox would assert that the axis exists and is momentarily
// unavailable, which is a claim the daemon never made — so an absent or empty
// vocabulary renders nothing at all, and the caller says why beside it.

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
    // Without this, the two cases above would pass over a component that rendered
    // nothing under every input.
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
    // The distinction the header turns on: absence is the degradation, and a
    // disabled control anywhere here would be the wrong one.
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

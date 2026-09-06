// The grid pairs each term with its own definition, and keys on what it was given.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DefinitionGrid } from "./DefinitionGrid.js";

const ENTRIES = [
  { key: "first", term: <span>metered</span>, definition: "Billed per unit." },
  { key: "second", term: <span>subscription</span>, definition: "Included in a plan." },
];

describe("the settings definition grid", () => {
  it("renders one term and one definition per entry, in order", () => {
    const { container } = render(<DefinitionGrid entries={ENTRIES} />);
    expect([...container.querySelectorAll("dt")].map((node) => node.textContent)).toStrictEqual([
      "metered",
      "subscription",
    ]);
    expect([...container.querySelectorAll("dd")].map((node) => node.textContent)).toStrictEqual([
      "Billed per unit.",
      "Included in a plan.",
    ]);
  });

  it("negative control: it pairs them rather than emitting one list then the other", () => {
    // Without this, the case above would pass over a grid that rendered every term
    // and then every definition — which reads identically to a flat text assertion
    // and is exactly what the pairing exists to prevent.
    const { container } = render(<DefinitionGrid entries={ENTRIES} />);
    const pairs = [...container.querySelectorAll(".meridian-settings-page__vocabulary-entry")];
    expect(pairs).toHaveLength(2);
    expect(pairs[0]?.textContent).toBe("meteredBilled per unit.");
  });

  it("renders nothing at all for an empty set", () => {
    const { container } = render(<DefinitionGrid entries={[]} />);
    expect(container.querySelectorAll("dt")).toHaveLength(0);
  });
});

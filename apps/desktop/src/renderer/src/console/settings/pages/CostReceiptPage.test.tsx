// The cost page teaches the three splits, forbids the arithmetic, and says which
// absence it is rendering.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CostReceiptPage, registerCostReceiptPage } from "./CostReceiptPage.js";
import { SettingsPageRegistry } from "../settings-page-registry.js";

function renderedText(): string {
  const { container } = render(<CostReceiptPage />);
  return container.textContent ?? "";
}

describe("the cost page — what the receipt is", () => {
  it("names all three splits of the one figure", () => {
    const text = renderedText();
    for (const partition of ["Per run", "Per party", "Per paying account"]) {
      expect(text).toContain(partition);
    }
  });

  it("negative control: it names no fourth split", () => {
    // Model-level pricing is not a partition of this fold, and a table of it would
    // be a second accountant rather than a fourth column.
    expect(renderedText()).not.toMatch(/\bPer model\b/u);
  });

  it("forbids the arithmetic in the frame the body will land into", () => {
    const text = renderedText();
    expect(text).toContain("Nothing on screen is added up");
    expect(text).toContain("lower bound");
    expect(text).toContain("No total spans sessions");
  });
});

describe("the cost page — the absence it renders", () => {
  it("says nobody asked rather than showing a zero", () => {
    const text = renderedText();
    expect(text).toContain("No cost figure has been asked for");
    // A zero here would be a claim that the session has spent nothing, which is a
    // different sentence from nobody having asked for the figure.
    expect(text).not.toMatch(/\$\s?0|0\.00/u);
  });

  it("marks the absence as a question nobody put, not an empty result", () => {
    const { container } = render(<CostReceiptPage />);
    expect(container.querySelector(".meridian-nothing--not-checked")).not.toBeNull();
  });

  it("negative control: it renders no other kind of absence in its place", () => {
    // Without this, the case above would pass over a page rendering every absence
    // kind at once, which is how the five collapse back into one.
    const { container } = render(<CostReceiptPage />);
    expect(container.querySelector(".meridian-nothing--empty")).toBeNull();
    expect(container.querySelector(".meridian-nothing--error")).toBeNull();
  });

  it("offers no control over a figure it does not have", () => {
    const { container } = render(<CostReceiptPage />);
    expect(container.querySelectorAll("button, input")).toHaveLength(0);
  });
});

describe("the cost page — its rail entry", () => {
  it("claims the cost section with a search vocabulary", () => {
    const registry = new SettingsPageRegistry();
    registerCostReceiptPage(registry);
    const descriptor = registry.descriptorFor("cost");
    expect(descriptor?.label).toBe("Session cost");
    expect(descriptor?.keywords).toContain("receipt");
  });

  it("names no governance work anywhere a person reads", () => {
    expect(renderedText()).not.toMatch(/\b(?:Spec|Plan|ADR|BL|CP|I)-\d/u);
  });
});

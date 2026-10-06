// A copied formula goes onto the clipboard as its TeX source, found by the mark `MathBlock`
// writes on every formula it draws.

import { describe, expect, it } from "vitest";

import { rebuildMarkdown } from "./clipboard-flavors.js";

/** A fragment holding one drawn span, its MathML carrying the TeX as KaTeX writes it. */
function drawnSpan(attributes: string): DocumentFragment {
  const template = document.createElement("template");
  template.innerHTML =
    `<span ${attributes}><math><semantics><mi>x</mi>` +
    `<annotation encoding="application/x-tex">x^2</annotation></semantics></math></span>`;
  return template.content;
}

describe("a copied formula", () => {
  it("is rebuilt as its TeX source in a math block", () => {
    expect(rebuildMarkdown(drawnSpan('data-math=""'))).toBe("```math\nx^2\n```");
  });

  it("negative control: a span without the mark is not read as a formula", () => {
    expect(rebuildMarkdown(drawnSpan('class="other"'))).not.toContain("```math");
  });
});

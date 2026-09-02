// The one `dangerouslySetInnerHTML` site, and the four constraints that earn it.

import { render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MathBlock } from "./MathBlock.js";

describe("a formula that typesets", () => {
  it("renders MathML rather than styled HTML", async () => {
    const { container } = render(<MathBlock source="a^2 + b^2 = c^2" isDisplayMode />);
    await waitFor(() => {
      expect(container.querySelector("math")).not.toBeNull();
    });
  });

  it("negative control: `trust: false` means TeX cannot emit a link", async () => {
    // `\href` is exactly what `trust` gates. A formula that could reach outside itself
    // would make model output an anchor factory inside the one innerHTML site there is.
    const { container } = render(
      <MathBlock source={String.raw`\href{https://example.invalid}{click}`} isDisplayMode />,
    );
    await waitFor(() => {
      expect(container.querySelector("math") ?? container.querySelector("code")).not.toBeNull();
    });
    expect(container.querySelector("a")).toBeNull();
  });
});

describe("a formula that does not typeset", () => {
  it("renders its own source and names the absence, never KaTeX's error text", async () => {
    const { container } = render(<MathBlock source={String.raw`\notacommand{`} isDisplayMode />);
    await waitFor(() => {
      expect(container.textContent).toContain("notacommand");
    });
    expect(container.textContent).not.toContain("ParseError");
  });
});

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
    // `\href` is what `trust` gates; a formula must not be able to emit a link.
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

  it("takes the source arm and says so, rather than a formula-shaped blank", async () => {
    // Under a KaTeX told not to throw, a parse error comes back as markup and would be recorded
    // as typeset, so the source would never appear.
    const { container } = render(<MathBlock source={String.raw`\frac{1`} isDisplayMode />);

    await waitFor(() => {
      expect(container.querySelector(".meridian-math--source")).not.toBeNull();
    });
    expect(container.querySelector("code")?.textContent).toBe(String.raw`\frac{1`);
    expect(container.textContent).toContain("could not be typeset");
    expect(container.querySelector("math")).toBeNull();
  });

  it("negative control: a formula that typesets shows no notice and no source", async () => {
    const { container } = render(<MathBlock source="a^2 + b^2 = c^2" isDisplayMode />);

    await waitFor(() => {
      expect(container.querySelector("math")).not.toBeNull();
    });
    expect(container.querySelector(".meridian-math--source")).toBeNull();
    expect(container.textContent).not.toContain("could not be typeset");
  });

  it("negative control: a formula KaTeX only warns about still typesets", async () => {
    // `strict: false` is separate from throwing on a parse error: a Unicode character in math
    // mode is a strict warning and must still typeset.
    const { container } = render(<MathBlock source="é = mc^2" isDisplayMode />);

    await waitFor(() => {
      expect(container.querySelector("math")).not.toBeNull();
    });
    expect(container.textContent).not.toContain("could not be typeset");
  });
});

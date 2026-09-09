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

  it("takes the source arm and says so, rather than a formula-shaped blank", async () => {
    // The failure this case exists for is invisible by construction: under a KaTeX told
    // not to throw, a parse error comes back AS MARKUP, so the component records it as
    // typeset and the reader is shown KaTeX's own error rendering — coloured away to
    // nothing, in the arrangement this replaces. Nothing on screen would say the formula
    // failed, and the source would never appear.
    const { container } = render(<MathBlock source={String.raw`\frac{1`} isDisplayMode />);

    await waitFor(() => {
      expect(container.querySelector(".meridian-math--source")).not.toBeNull();
    });
    expect(container.querySelector("code")?.textContent).toBe(String.raw`\frac{1`);
    expect(container.textContent).toContain("could not be typeset");
    expect(container.querySelector("math")).toBeNull();
  });

  it("negative control: a formula that typesets shows no notice and no source", async () => {
    // Without this, a component that took the source arm unconditionally would pass
    // every case above and stop typesetting anything at all.
    const { container } = render(<MathBlock source="a^2 + b^2 = c^2" isDisplayMode />);

    await waitFor(() => {
      expect(container.querySelector("math")).not.toBeNull();
    });
    expect(container.querySelector(".meridian-math--source")).toBeNull();
    expect(container.textContent).not.toContain("could not be typeset");
  });

  it("negative control: a formula KaTeX only warns about still typesets", async () => {
    // `strict: false` is a separate constraint from throwing on a parse error, and this
    // is where the two are told apart: a Unicode character in math mode is a strict
    // WARNING, and a participant's slip inside a formula is not the console's error to
    // raise. A fix that reached the source arm through KaTeX's strict mode rather than
    // through a parse failure would fail here.
    const { container } = render(<MathBlock source="é = mc^2" isDisplayMode />);

    await waitFor(() => {
      expect(container.querySelector("math")).not.toBeNull();
    });
    expect(container.textContent).not.toContain("could not be typeset");
  });
});

// Command output: spans built from data, and never a markup string.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AnsiOutput } from "./AnsiOutput.js";

const ESCAPE = String.fromCodePoint(0x1b);

describe("rendering ANSI output", () => {
  it("puts each styled run in its own span, in a preformatted block", () => {
    const { container } = render(
      <AnsiOutput source={`${ESCAPE}[31mfailed${ESCAPE}[39m ok`} label="Output of ls" />,
    );
    expect(container.querySelector("pre")).not.toBeNull();
    expect(container.querySelector(".meridian-ansi__fg--red")).not.toBeNull();
    expect(container.textContent).toContain("failed");
    expect(container.textContent).toContain("ok");
  });

  it("names the block for a screen reader", () => {
    const { container } = render(<AnsiOutput source="plain" label="Output of ls" />);
    expect(container.querySelector("pre")?.getAttribute("aria-label")).toBe("Output of ls");
  });

  it("negative control: markup in the output reaches the screen as characters", () => {
    // The mapper is the whole path; there is no HTML string anywhere on it, which is why
    // a tool that prints a tag prints a tag rather than creating one.
    const { container } = render(<AnsiOutput source="<img src=x>" label="Output" />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<img src=x>");
  });
});

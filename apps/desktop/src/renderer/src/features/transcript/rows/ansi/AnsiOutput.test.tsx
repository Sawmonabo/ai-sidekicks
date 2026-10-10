// Command output: spans built from data, and never a markup string.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AnsiOutput } from "./AnsiOutput.js";
import { publishedTextOf } from "../../reveal/published-text.js";

describe("rendering ANSI output", () => {
  it("markup in the output reaches the screen as characters", () => {
    // The mapper is the whole path; there is no HTML string anywhere on it, which is why
    // a tool that prints a tag prints a tag rather than creating one.
    const { container } = render(
      <AnsiOutput
        publishedText={publishedTextOf("<img src=x>")}
        label="Output"
        isCutAtFlowHeight={false}
      />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<img src=x>");
  });
});

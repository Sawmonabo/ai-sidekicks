// Which renderer a tool's result reaches, read off its bytes.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { FootnoteRegistry } from "../markdown/footnotes/registry.js";
import { ToolOutput } from "./ToolOutput.js";

const ESCAPE = "\u001b";

const BEL = "\u0007";

describe("command output", () => {
  // No tool payload declares a body's shape, so its bytes are the only reading.

  it("routes a body carrying escape sequences through the ANSI path", () => {
    const { container } = render(
      <ToolOutput
        content={{ status: "available", body: `${ESCAPE}[31mfailed${ESCAPE}[39m ok` }}
        sourceId="event-01"
        footnotes={new FootnoteRegistry()}
        label="Output of ls"
      />,
    );
    expect(container.querySelector(".meridian-ansi__body")).not.toBeNull();
    expect(container.querySelector(".meridian-markdown")).toBeNull();
    expect(container.textContent).toContain("failed");
  });

  it("puts no escape sequence on the page, whichever renderer the body took", () => {
    // Anser leaves OSC and the two-byte escapes inside the chunk it returns.
    const { container } = render(
      <ToolOutput
        content={{
          status: "available",
          body: `${ESCAPE}]0;a title${BEL}built ${ESCAPE}(Bcleanly`,
        }}
        sourceId="event-01"
        footnotes={new FootnoteRegistry()}
        label="Output of make"
      />,
    );
    expect(container.textContent).toContain("built cleanly");
    expect(container.textContent).not.toContain(ESCAPE);
    expect(container.textContent).not.toContain("0;a title");
  });
});

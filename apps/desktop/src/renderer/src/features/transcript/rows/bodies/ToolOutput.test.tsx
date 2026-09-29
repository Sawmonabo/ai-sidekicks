// Which renderer a tool's result reaches, read off its bytes.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { FootnoteRegistry } from "../markdown/footnotes/footnote-registry.js";
import { ToolOutput } from "./ToolOutput.js";

/** The one byte every ANSI sequence opens with. */
const ESCAPE = "\u001b";

/** The BEL an OSC sequence is terminated by. */
const BEL = "\u0007";

describe("command output", () => {
  // No tool payload declares a body's shape, so the bytes are the only reading the wire
  // supplies; a renderer that ignored them would put escape sequences on the page.

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

  it("negative control: an ordinary reply still takes the markdown path", () => {
    // Without this the case above would pass over a body reader that answered "ANSI"
    // for every result, which is what put a web-search answer in a raw block with its
    // markdown showing.
    const { container } = render(
      <ToolOutput
        content={{ status: "available", body: "an ordinary **reply**" }}
        sourceId="event-01"
        footnotes={new FootnoteRegistry()}
        label="Output of a tool"
      />,
    );
    expect(container.querySelector(".meridian-ansi__body")).toBeNull();
  });

  it("puts no escape sequence on the page, whichever renderer the body took", () => {
    // The half neither renderer had: anser consumes the CSI sequences and leaves OSC
    // and the two-byte escapes inside the chunk it hands back, so a shell that set a
    // window title rendered the title sequence as text beside its output.
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

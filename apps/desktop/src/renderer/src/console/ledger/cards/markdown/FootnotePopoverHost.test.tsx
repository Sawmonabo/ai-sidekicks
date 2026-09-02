// One popup per body — and what a marker INSIDE a definition body does.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { FootnotePopoverHost } from "./FootnotePopoverHost.js";
import { FootnoteRegistry } from "./footnote-registry.js";
import { MarkdownNodes } from "./MarkdownNodes.js";
import { collectFootnoteDefinitions } from "./footnote-collection.js";
import { footnoteDefinitionPreamble, parseSettledBlock } from "./markdown-parse.js";

const SOURCE_ID = "event-40";

/**
 * A pair of notes that cite each other, plus a body that cites the first.
 *
 * This is the shape `footnote-collection.test.ts` already asserts is collectable, which
 * is what makes "a footnote inside a footnote is not a construct GFM nests" false.
 */
const CHAINED_NOTES = "cite[^a] here\n\n[^a]: first, see also[^b]\n\n[^b]: the second body\n";

/** A note that points at itself. */
const SELF_CITING_NOTE = "cite[^a] here\n\n[^a]: first, and again[^a]\n";

/**
 * The host around a body, wired the way `StreamingMarkdown` wires it.
 *
 * The registry is filled from the same parse the body renders, rather than by hand, so
 * the test cannot pass against definitions the real pipeline would never have recorded.
 */
function renderHostedBody(source: string, definitionPreamble = ""): HTMLElement {
  const parsed = parseSettledBlock(source, definitionPreamble);
  const { definitions, definedIdentifiers } = collectFootnoteDefinitions(parsed.children);
  const footnotes = new FootnoteRegistry();
  for (const definition of definitions) {
    footnotes.register({
      sourceId: SOURCE_ID,
      identifier: definition.identifier,
      bodyNodes: definition.children,
    });
  }
  const { container } = render(
    <FootnotePopoverHost
      sourceId={SOURCE_ID}
      footnotes={footnotes}
      uncitedIdentifiers={[]}
      definedFootnoteIdentifiers={definedIdentifiers}
    >
      <MarkdownNodes
        nodes={parsed.children}
        context={{ isSettled: true, definedFootnoteIdentifiers: definedIdentifiers }}
      />
    </FootnotePopoverHost>,
  );
  return container;
}

describe("a footnote reference inside a definition body", () => {
  it("navigates the popup to the note it names", () => {
    renderHostedBody(CHAINED_NOTES);
    fireEvent.click(screen.getByRole("button", { name: "Footnote a" }));
    expect(screen.getByText(/first, see also/u)).toBeTruthy();

    // The marker inside the open body is the second control with this name — the first
    // is the one in the message that opened the popup.
    const chained = screen.getByRole("button", { name: "Footnote b" });
    fireEvent.click(chained);

    expect(screen.getByText("the second body")).toBeTruthy();
    expect(screen.queryByText(/first, see also/u)).toBeNull();
  });

  it("re-opens the same body for a note that cites itself", () => {
    // The payload is the identifier, so a self-reference resolves to the definition it
    // is already showing. Stated rather than left to be discovered: the popup stays on
    // `a`, which is what a reader asking for `a` should get.
    renderHostedBody(SELF_CITING_NOTE);
    fireEvent.click(screen.getByRole("button", { name: "Footnote a" }));
    expect(screen.getByText(/first, and again/u)).toBeTruthy();

    const selfReference = screen.getAllByRole("button", { name: "Footnote a" }).at(-1);
    fireEvent.click(selfReference ?? document.body);

    expect(screen.getByText(/first, and again/u)).toBeTruthy();
  });

  it("negative control: a marker naming an identifier the message never defined stays inert", () => {
    // Without this, a host that made every marker in a definition body a control would
    // pass the cases above and offer a press that opens an empty popup. The preamble is
    // what makes the orphan a reference NODE rather than literal characters, so the
    // marker really reaches the mapper and really has to be turned down.
    renderHostedBody(
      "cite[^a] here\n\n[^a]: first, see also[^gone]\n",
      footnoteDefinitionPreamble(new Set(["gone"])),
    );
    fireEvent.click(screen.getByRole("button", { name: "Footnote a" }));
    expect(screen.getByText(/first, see also/u)).toBeTruthy();

    expect(screen.queryByRole("button", { name: "Footnote gone" })).toBeNull();
    const inert = document.querySelector('.meridian-markdown__footnote[data-defined="false"]');
    expect(inert?.tagName).toBe("SUP");
    expect(inert?.getAttribute("aria-label")).toBe("Footnote gone");
  });
});

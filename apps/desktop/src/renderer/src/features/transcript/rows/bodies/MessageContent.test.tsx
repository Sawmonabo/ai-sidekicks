import type { HydratedSessionEventContent } from "@ai-sidekicks/contracts";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { FootnoteRegistry } from "../markdown/footnotes/footnote-registry.js";
import { MessageContent } from "./MessageContent.js";

const ESCAPE = "\u001b";

function renderBody(
  content: HydratedSessionEventContent | undefined,
  overrides: { readonly liveText?: string; readonly contentType?: string } = {},
): HTMLElement {
  const { container } = render(
    <MessageContent
      content={content}
      {...(overrides.liveText === undefined ? {} : { liveText: overrides.liveText })}
      {...(overrides.contentType === undefined ? {} : { contentType: overrides.contentType })}
      sourceId="event-01"
      footnotes={new FootnoteRegistry()}
      label="The agent's reply"
    />,
  );
  return container;
}

function renderDeclaredBody(body: string, mediaType: string): HTMLElement {
  return renderBody({ status: "available", body }, { contentType: mediaType });
}

describe("a body nobody asked for", () => {
  it("live text is rendered rather than reported absent", () => {
    // A streaming turn has no stored body, so the unread marker would be wrong for it.
    const container = renderBody(undefined, { liveText: "arriving now" });
    expect(container.textContent).toContain("arriving now");
    expect(container.querySelector(".meridian-nothing--not-checked")).toBeNull();
  });
});

describe("the media type its producer declared", () => {
  it("renders a declared markdown body as markdown", () => {
    const container = renderDeclaredBody("an ordinary **reply**", "text/markdown");
    expect(container.querySelector(".meridian-markdown")).not.toBeNull();
    expect(container.querySelector("strong")?.textContent).toBe("reply");
  });

  it("keeps declared markdown on the markdown path when a control byte rode along", () => {
    // An escape inside a declared markdown body is terminal residue: it is stripped and the
    // markdown structure is still drawn.
    const container = renderDeclaredBody(`${ESCAPE}[31m## A heading${ESCAPE}[39m`, "text/markdown");
    expect(container.querySelector(".meridian-markdown")).not.toBeNull();
    expect(container.querySelector(".meridian-ansi__body")).toBeNull();
    expect(container.textContent).toContain("A heading");
    expect(container.textContent).not.toContain(ESCAPE);
  });

  it("renders a declared plain-text body verbatim, reformatting nothing", () => {
    const container = renderDeclaredBody("an ordinary *literal* reply", "text/plain");
    expect(container.querySelector(".meridian-machine-body__plain")).not.toBeNull();
    expect(container.querySelector(".meridian-markdown")).toBeNull();
    expect(container.querySelector("em")).toBeNull();
    expect(container.textContent).toContain("*literal*");
  });

  it("reads the type through its parameters and its case", () => {
    // `contentType` is a free-form wire string; comparing the raw member would send real
    // markdown to the plain arm.
    for (const declared of ["text/markdown; charset=utf-8", "TEXT/Markdown"]) {
      const container = renderDeclaredBody("an ordinary **reply**", declared);
      expect(container.querySelector("strong")?.textContent).toBe("reply");
    }
  });
});

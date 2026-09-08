// The two dispositions a machine body can take, and the two it must never take —
// and, below them, which of the three renderers a body reaches at all.

import type { HydratedSessionEventContent } from "@ai-sidekicks/contracts";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MachineBody } from "./MachineBody.js";
import { FootnoteRegistry } from "../markdown/index.js";

/** The one byte every ANSI sequence opens with. */
const ESCAPE = "\u001b";

/** The BEL an OSC sequence is terminated by. */
const BEL = "\u0007";

function renderBody(
  content: HydratedSessionEventContent | undefined,
  overrides: { readonly liveText?: string; readonly contentType?: string } = {},
): HTMLElement {
  const { container } = render(
    <MachineBody
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

/** An assistant body whose producer declared `mediaType`, rendered. */
function renderDeclaredBody(body: string, mediaType: string): HTMLElement {
  return renderBody({ status: "available", body }, { contentType: mediaType });
}

describe("a body that opened", () => {
  it("renders it", () => {
    const container = renderBody({ status: "available", body: "the reply" });
    expect(container.textContent).toContain("the reply");
  });

  it("negative control: it says nothing about truncation", () => {
    // Without this, a notice rendered unconditionally would pass every truncation
    // assertion below while telling a reader that every body is a prefix.
    const container = renderBody({ status: "available", body: "the reply" });
    expect(container.textContent).not.toContain("Truncated");
    expect(container.textContent).not.toContain("turn_content_truncated");
  });
});

describe("a body that was truncated", () => {
  it("renders the prefix and says how much of it is shown", () => {
    const container = renderBody({
      status: "available",
      body: "the prefix",
      contentLength: 4096,
      contentTruncated: true,
    });
    expect(container.textContent).toContain("the prefix");
    expect(container.textContent).toContain("Truncated when recorded");
    // A no-break space, as `formatByteQuantity` emits it — asserting an ordinary
    // space here would pass only if the figure had lost the character that keeps it
    // from wrapping away from its unit.
    expect(container.textContent).toContain("4.0\u00A0KiB");
  });

  it("names the declared loss the wire vocabulary carries", () => {
    const container = renderBody({
      status: "available",
      body: "the prefix",
      contentTruncated: true,
    });
    expect(container.textContent).toContain("turn_content_truncated");
  });

  it("does not invent a total the payload did not record", () => {
    const container = renderBody({
      status: "available",
      body: "the prefix",
      contentTruncated: true,
    });
    expect(container.textContent).toContain("the original size was not recorded");
  });
});

describe("a body that could not be read", () => {
  it("renders the turn at its position with an empty body", () => {
    const container = renderBody({ status: "unavailable", reason: "compacted" });
    expect(container.querySelector(".meridian-machine-body__empty")).not.toBeNull();
    expect(container.textContent).toContain("destroyed when the session was compacted");
    expect(container.textContent).toContain("turn_content_unavailable");
  });

  it("marks a signature mismatch as a failure and ordinary loss as an absence", () => {
    // The two-hue rule in one assertion: red is reserved for a failure, and a body
    // destroyed by retention doing its job is not one.
    const tampered = renderBody({ status: "unavailable", reason: "digest_unbound" });
    expect(tampered.querySelector(".meridian-nothing--error")).not.toBeNull();

    const lost = renderBody({ status: "unavailable", reason: "absent" });
    expect(lost.querySelector(".meridian-nothing--error")).toBeNull();
    expect(lost.querySelector(".meridian-nothing--empty")).not.toBeNull();
  });
});

describe("a body nobody asked for", () => {
  it("says it has not been read, which is not the same as not being there", () => {
    const container = renderBody(undefined);
    // `not-checked` rather than `not-loaded`: nothing is in flight here, so
    // nothing may claim to be — a skeleton bar is a promise of a body arriving.
    expect(container.querySelector(".meridian-nothing--not-checked")).not.toBeNull();
    expect(container.querySelector(".meridian-nothing--not-loaded")).toBeNull();
  });

  it("negative control: live text is rendered rather than reported absent", () => {
    // A streaming turn HAS no stored body, so the unread marker would be wrong for
    // exactly the row a reader is watching arrive.
    const container = renderBody(undefined, { liveText: "arriving now" });
    expect(container.textContent).toContain("arriving now");
    expect(container.querySelector(".meridian-nothing--not-checked")).toBeNull();
  });
});

describe("command output", () => {
  // WHICH RENDERER A BODY TAKES IS READ OFF THE BODY. It used to be a prop, and every
  // call site passed `"prose"` — so the ANSI arm was unreachable and a shell-shaped
  // tool result went through a renderer that strips nothing, putting its escape
  // sequences on the page as literal text. No registered payload declares a body's
  // shape, so the bytes are the only reading the wire supplies.

  it("routes a body carrying escape sequences through the ANSI path", () => {
    const { container } = render(
      <MachineBody
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
      <MachineBody
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
      <MachineBody
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

describe("the media type its producer declared", () => {
  // THE DEFECT THIS CLOSES. The renderer was chosen from the bytes alone, and
  // `AssistantOutputPayload` has carried `contentType` all along — so a `text/plain`
  // reply carrying an asterisk pair was reformatted into emphasis nobody wrote, and a
  // markdown reply carrying one stray escape went through the terminal renderer whole,
  // losing every heading, list and code fence in it.

  it("renders a declared markdown body as markdown", () => {
    const container = renderDeclaredBody("an ordinary **reply**", "text/markdown");
    expect(container.querySelector(".meridian-markdown")).not.toBeNull();
    expect(container.querySelector("strong")?.textContent).toBe("reply");
  });

  it("keeps declared markdown on the markdown path when a control byte rode along", () => {
    // The declaration is the producer's own statement of what it emitted. An escape
    // sequence inside such a body is terminal residue the media type does not cover, so
    // it is stripped and the markdown structure is still drawn — reading it instead as
    // "this whole body is command output" throws that structure away for one byte.
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

  it("keeps declared plain text off the ANSI path and still puts no escape on the page", () => {
    // The ANSI renderer is for command output, and an assistant body its producer called
    // plain text is not that whichever bytes it carries — but the bytes are still bytes
    // no reader should see.
    const container = renderDeclaredBody(`${ESCAPE}]0;a title${BEL}built`, "text/plain");
    expect(container.querySelector(".meridian-machine-body__plain")).not.toBeNull();
    expect(container.querySelector(".meridian-ansi__body")).toBeNull();
    expect(container.textContent).toBe("built");
  });

  it("takes the plain arm for a declaration this console has no renderer for", () => {
    // Fail-closed on the safe side: a producer that described its body precisely is not
    // second-guessed, and nothing is interpreted that was not asked for.
    const container = renderDeclaredBody('{ "ok": **true** }', "application/json");
    expect(container.querySelector(".meridian-machine-body__plain")).not.toBeNull();
    expect(container.querySelector("strong")).toBeNull();
    expect(container.textContent).toContain("**true**");
  });

  it("reads the type through its parameters and its case", () => {
    // `contentType` is a free-form wire string, so the value arrives as the producer
    // spelled it. A comparison against the raw member answers "unrecognised" for both of
    // these and drops a real markdown reply onto the plain arm.
    for (const declared of ["text/markdown; charset=utf-8", "TEXT/Markdown"]) {
      const container = renderDeclaredBody("an ordinary **reply**", declared);
      expect(container.querySelector("strong")?.textContent).toBe("reply");
    }
  });

  it("declares the shape of a live turn as well as a stored one", () => {
    // A streaming assistant turn has no stored body yet and the same declaration on its
    // row, so a reading applied only to `content` would reformat the tail of every
    // plain-text turn and settle it correctly one beat later.
    const container = renderBody(undefined, {
      liveText: "arriving *now*",
      contentType: "text/plain",
    });
    expect(container.querySelector(".meridian-machine-body__plain")).not.toBeNull();
    expect(container.textContent).toContain("arriving *now*");
  });

  it("negative control: a body with no declaration still reads its own bytes", () => {
    // The tool trio carries no content type at all, so removing the byte reading would
    // put a build log's escape sequences on the page as text — the defect the byte
    // reading was added to close. Both of its answers are asserted here.
    const ansi = renderBody({
      status: "available",
      body: `${ESCAPE}[31mfailed${ESCAPE}[39m`,
    });
    expect(ansi.querySelector(".meridian-ansi__body")).not.toBeNull();

    const prose = renderBody({ status: "available", body: "an ordinary **reply**" });
    expect(prose.querySelector(".meridian-markdown")).not.toBeNull();
    expect(prose.querySelector(".meridian-machine-body__plain")).toBeNull();
  });
});

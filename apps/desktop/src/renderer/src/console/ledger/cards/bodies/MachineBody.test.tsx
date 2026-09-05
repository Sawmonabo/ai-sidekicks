// The two dispositions a machine body can take, and the two it must never take.

import type { HydratedSessionEventContent } from "@ai-sidekicks/contracts";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MachineBody } from "./MachineBody.js";
import { FootnoteRegistry } from "../markdown/index.js";

function renderBody(
  content: HydratedSessionEventContent | undefined,
  overrides: { readonly liveText?: string } = {},
): HTMLElement {
  const { container } = render(
    <MachineBody
      content={content}
      {...(overrides.liveText === undefined ? {} : { liveText: overrides.liveText })}
      kind="prose"
      sourceId="event-01"
      footnotes={new FootnoteRegistry()}
      label="The agent's reply"
    />,
  );
  return container;
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
  it("renders through the ANSI path rather than the markdown one", () => {
    const { container } = render(
      <MachineBody
        content={{ status: "available", body: "plain output" }}
        kind="command-output"
        sourceId="event-01"
        footnotes={new FootnoteRegistry()}
        label="Output of ls"
      />,
    );
    expect(container.querySelector(".meridian-ansi__body")).not.toBeNull();
    expect(container.querySelector(".meridian-markdown")).toBeNull();
  });
});

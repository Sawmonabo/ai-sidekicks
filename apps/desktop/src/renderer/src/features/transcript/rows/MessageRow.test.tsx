// Three families, one layout — and the edit affordance this card mounts on a user row.

import type { HydratedSessionEventContent } from "@ai-sidekicks/contracts";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { inlineCardSeatRegistry, type InlineCardSeatProps } from "@renderer/console/seats/index.js";
import { MessageRow } from "./MessageRow.js";
import { classifyTranscriptRow } from "./row-kind.js";
import { FootnoteRegistry } from "./markdown/footnotes/footnote-registry.js";
import { sampleRunRow } from "@test/helpers/timeline-row-samples.js";

function renderMessageCard(
  overrides: {
    readonly type?: string;
    readonly summary?: string;
    readonly payload?: Readonly<Record<string, unknown>>;
    readonly content?: HydratedSessionEventContent;
    readonly liveText?: string;
    readonly inlineCards?: readonly InlineCardSeatProps[];
    readonly editAffordance?: React.ReactNode;
    readonly reasoningSurface?: React.ReactNode;
  } = {},
): HTMLElement {
  const row = sampleRunRow({
    type: overrides.type ?? "assistant.message",
    ...(overrides.summary === undefined ? {} : { summary: overrides.summary }),
    ...(overrides.payload === undefined ? {} : { payload: overrides.payload }),
  });
  const rowKind = classifyTranscriptRow(row);
  if (rowKind === undefined) {
    throw new Error(`${row.type} is not a message kind`);
  }
  const { container } = render(
    <MessageRow
      row={row}
      rowKind={rowKind}
      actorHue={undefined}
      isSuperseded={false}
      density="expanded"
      footnotes={new FootnoteRegistry()}
      thinkingRow={overrides.reasoningSurface}
      {...(overrides.content === undefined ? {} : { content: overrides.content })}
      {...(overrides.liveText === undefined ? {} : { liveText: overrides.liveText })}
      {...(overrides.inlineCards === undefined ? {} : { inlineCards: overrides.inlineCards })}
      editControl={overrides.editAffordance}
    />,
  );
  return container;
}

describe("which body a message renders", () => {
  it("renders a user's row through the row's own summary", () => {
    // The whole of what the wire carries for a user: their words are sealed in
    // the per-user encrypted column and reach no timeline row.
    const container = renderMessageCard({
      type: "user.message",
      summary: "please run the tests",
    });
    expect(container.textContent).toContain("please run the tests");
    expect(container.querySelector(".meridian-markdown")).not.toBeNull();
  });

  it("renders an agent's reply through the hydrated projection", () => {
    const container = renderMessageCard({
      content: { status: "available", body: "here is the result" },
    });
    expect(container.textContent).toContain("here is the result");
  });

  it("prefers live text over a stored body, because a live turn has none yet", () => {
    const container = renderMessageCard({ liveText: "arriv" });
    expect(container.textContent).toContain("arriv");
    expect(container.querySelector(".meridian-nothing--not-checked")).toBeNull();
  });

  it("negative control: a user row never renders the machine-body absence", () => {
    // Without this, a card that routed every family through `MachineBody` would put
    // "this body has not been read" under every message a person typed.
    const container = renderMessageCard({ type: "user.message", summary: "hello" });
    expect(container.querySelector(".meridian-nothing--not-checked")).toBeNull();
  });

  it("says so when a user row carries no summary at all", () => {
    const container = renderMessageCard({ type: "user.message", summary: "" });
    expect(container.textContent).toContain("no summary");
  });
});

describe("the three families this card serves", () => {
  it("names each one on the row", () => {
    expect(renderMessageCard({ type: "user.message" }).textContent).toContain("Message");
    expect(renderMessageCard({ type: "assistant.message" }).textContent).toContain("Reply");
    expect(renderMessageCard({ type: "assistant.thinking_update" }).textContent).toContain(
      "Reasoning",
    );
  });

  it("negative control: the family modifier is not one constant string", () => {
    const user = renderMessageCard({ type: "user.message" });
    const assistant = renderMessageCard({ type: "assistant.message" });
    expect(user.querySelector(".meridian-message-card--user-message")).not.toBeNull();
    expect(assistant.querySelector(".meridian-message-card--user-message")).toBeNull();
  });
});

describe("the edit affordance", () => {
  it("renders the supplied element on a user row", () => {
    const container = renderMessageCard({
      type: "user.message",
      editAffordance: <button type="button">Edit</button>,
    });
    expect(container.querySelector("button")?.textContent).toBe("Edit");
  });

  it("renders nothing at all while none is supplied", () => {
    const container = renderMessageCard({ type: "user.message" });
    expect(container.querySelector("button")).toBeNull();
  });

  it("offers none on a machine row", () => {
    // The affordance edits a user's own boundary; a reply has none to edit.
    const container = renderMessageCard({
      type: "assistant.message",
      editAffordance: <button type="button">Edit</button>,
    });
    expect(container.querySelector("button")).toBeNull();
  });
});

describe("a message's inline cards", () => {
  const diffCard: InlineCardSeatProps = {
    kind: "diff",
    runId: "run-01",
    diffArtifactId: "diff-artifact-01",
    artifactManifestId: "artifact-manifest-01",
  };

  it("chips the card whether or not its body has landed", () => {
    const container = renderMessageCard({ inlineCards: [diffCard] });
    expect(container.querySelector(".meridian-chip")?.textContent).toContain("diff");
  });

  it("names an unfilled kind rather than rendering an empty region", () => {
    const container = renderMessageCard({ inlineCards: [diffCard] });
    // Scoped to the card, because the row's own unread body renders the same kind:
    // an unscoped selector here would pass on the wrong element.
    expect(
      container.querySelector(".meridian-message-card__card .meridian-nothing--not-checked"),
    ).not.toBeNull();
  });

  it("renders the registered body once a family fills the seat", () => {
    inlineCardSeatRegistry.register("diff", {
      owner: "a test",
      render: () => <span>a diff</span>,
    });
    try {
      const container = renderMessageCard({ inlineCards: [diffCard] });
      expect(container.textContent).toContain("a diff");
      expect(
        container.querySelector(".meridian-message-card__card .meridian-nothing--not-checked"),
      ).toBeNull();
    } finally {
      inlineCardSeatRegistry.unregister("diff");
    }
  });

  it("negative control: a message with no cards renders no card region", () => {
    const container = renderMessageCard({});
    expect(container.querySelector(".meridian-message-card__cards")).toBeNull();
  });
});

describe("the settled turn's receipt", () => {
  it("reports the size and type the row itself recorded", () => {
    const container = renderMessageCard({
      payload: { contentLength: 2048, contentType: "text/markdown" },
    });
    const receipt = container.querySelector(".meridian-message-card__receipt")?.textContent ?? "";
    expect(receipt).toContain("2.0\u00A0KiB");
    expect(receipt).toContain("text/markdown");
  });

  it("negative control: a row that recorded neither gets no receipt line", () => {
    // Without this, a line saying "Recorded" and nothing else would appear under every
    // body-less row in the log.
    const container = renderMessageCard({ payload: {} });
    expect(container.querySelector(".meridian-message-card__receipt")).toBeNull();
  });

  it("reports no cost and no token count", () => {
    const container = renderMessageCard({
      payload: { contentLength: 2048, costUsd: 0.42, tokens: 900 },
    });
    const receipt = container.querySelector(".meridian-message-card__receipt")?.textContent ?? "";
    expect(receipt).not.toContain("0.42");
    expect(receipt).not.toContain("900");
  });
});

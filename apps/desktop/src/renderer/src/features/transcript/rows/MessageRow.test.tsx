// Three row kinds, one layout — and the controls this card mounts in a row's footer.

import type { HydratedSessionEventContent } from "@ai-sidekicks/contracts";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  inlineCardRegistry,
  type InlineCardProps,
} from "@renderer/registries/inline-cards/inline-card-registry.js";
import { createFixtureBridge } from "@renderer/services/platform/platform-bridge.fixture.js";
import { FixtureBridgeProvider } from "@test/helpers/app-frame-fixtures.js";
import { MessageRow } from "./MessageRow.js";
import { classifyTranscriptRow } from "./row-kind.js";
import { FootnoteRegistry } from "./markdown/footnotes/footnote-registry.js";
import { sampleRunRow } from "@test/helpers/timeline-row-samples.js";
import { FIRST_RUN_SCENARIO } from "../../../../../../fixtures/scenarios/first-run.js";

function renderMessageCard(
  overrides: {
    readonly type?: string;
    readonly summary?: string;
    readonly payload?: Readonly<Record<string, unknown>>;
    readonly content?: HydratedSessionEventContent;
    readonly liveText?: string;
    readonly inlineCards?: readonly InlineCardProps[];
    readonly editAffordance?: React.ReactNode;
    readonly thinkingRow?: React.ReactNode;
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
    <FixtureBridgeProvider fixture={createFixtureBridge({ scenario: FIRST_RUN_SCENARIO })}>
      <MessageRow
        row={row}
        rowKind={rowKind}
        actorHue={undefined}
        isSuperseded={false}
        density="expanded"
        footnotes={new FootnoteRegistry()}
        thinkingRow={overrides.thinkingRow}
        {...(overrides.content === undefined ? {} : { content: overrides.content })}
        {...(overrides.liveText === undefined ? {} : { liveText: overrides.liveText })}
        {...(overrides.inlineCards === undefined ? {} : { inlineCards: overrides.inlineCards })}
        editControl={overrides.editAffordance}
      />
    </FixtureBridgeProvider>,
  );
  return container;
}

describe("which body a message renders", () => {
  it("renders a user's row through the row's own summary", () => {
    // A user's words reach no `TimelineRow`; the summary is all the wire carries.
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
    // Without this, a card that routed every kind through the machine body would put "this body
    // has not been read" under every message a person typed.
    const container = renderMessageCard({ type: "user.message", summary: "hello" });
    expect(container.querySelector(".meridian-nothing--not-checked")).toBeNull();
  });

  it("says so when a user row carries no summary at all", () => {
    const container = renderMessageCard({ type: "user.message", summary: "" });
    expect(container.textContent).toContain("no summary");
  });
});

describe("the three row kinds this card serves", () => {
  it("names each one on the row", () => {
    expect(renderMessageCard({ type: "user.message" }).textContent).toContain("Message");
    expect(renderMessageCard({ type: "assistant.message" }).textContent).toContain("Reply");
    expect(renderMessageCard({ type: "assistant.thinking_update" }).textContent).toContain(
      "Reasoning",
    );
  });

  it("negative control: the kind modifier is not one constant string", () => {
    const user = renderMessageCard({ type: "user.message" });
    const assistant = renderMessageCard({ type: "assistant.message" });
    expect(user.querySelector(".meridian-message-card--user-message")).not.toBeNull();
    expect(assistant.querySelector(".meridian-message-card--user-message")).toBeNull();
  });
});

function buttonLabels(container: HTMLElement): readonly (string | null)[] {
  return Array.from(container.querySelectorAll("button"), (button) => button.textContent);
}

describe("the row's own controls", () => {
  it("puts Copy before the supplied edit control on a user row", () => {
    const container = renderMessageCard({
      type: "user.message",
      editAffordance: <button type="button">Edit</button>,
    });
    expect(buttonLabels(container)).toStrictEqual(["Copy", "Edit"]);
  });

  it("offers only Copy on a user row while no edit control is supplied", () => {
    const container = renderMessageCard({ type: "user.message" });
    expect(buttonLabels(container)).toStrictEqual(["Copy"]);
  });

  it("offers Copy on a reply once it has text to copy", () => {
    const container = renderMessageCard({
      content: { status: "available", body: "here is the result" },
    });
    expect(buttonLabels(container)).toStrictEqual(["Copy"]);
  });

  it("offers nothing on a reply with no text yet, and never an edit control", () => {
    // The edit control edits a user's own message; a reply has none to edit, and a
    // reply with nothing read has nothing to copy.
    const container = renderMessageCard({
      type: "assistant.message",
      editAffordance: <button type="button">Edit</button>,
    });
    expect(buttonLabels(container)).toStrictEqual([]);
  });
});

describe("a message's inline cards", () => {
  const diffCard: InlineCardProps = {
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

  it("renders the registered body once an owner registers a body for the card kind", () => {
    inlineCardRegistry.register("diff", {
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
      inlineCardRegistry.unregister("diff");
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

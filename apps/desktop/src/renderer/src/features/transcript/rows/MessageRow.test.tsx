// Which body a message row renders, the inline cards it hosts, and what its receipt leaves out.

import { formatByteQuantity } from "@renderer/lib/wire-figures.js";
import type { HydratedSessionEventContent } from "@ai-sidekicks/contracts/event-envelope";
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
import { FIRST_RUN_SCENARIO } from "@fixtures/scenarios/first-run.js";

function renderMessageCard(
  overrides: {
    readonly type?: string;
    readonly summary?: string;
    readonly payload?: Readonly<Record<string, unknown>>;
    readonly content?: HydratedSessionEventContent;
    readonly liveText?: string;
    readonly inlineCards?: readonly InlineCardProps[];
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
        agentHue={undefined}
        isSuperseded={false}
        density="expanded"
        footnotes={new FootnoteRegistry()}
        thinkingRow={undefined}
        {...(overrides.content === undefined ? {} : { content: overrides.content })}
        {...(overrides.liveText === undefined ? {} : { liveText: overrides.liveText })}
        {...(overrides.inlineCards === undefined ? {} : { inlineCards: overrides.inlineCards })}
        editControl={undefined}
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
});

describe("a message's inline cards", () => {
  const diffCard: InlineCardProps = {
    kind: "diff",
    runId: "run-01",
    diffArtifactId: "diff-artifact-01",
    artifactManifestId: "artifact-manifest-01",
  };

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
});

describe("the settled turn's receipt", () => {
  it("reports the recorded size and no cost or token count", () => {
    const container = renderMessageCard({
      payload: { contentLength: 2048, costUsd: 0.42, tokens: 900 },
    });
    const receipt = container.querySelector(".meridian-message-card__receipt")?.textContent ?? "";
    expect(receipt).toBe(`Recorded · ${formatByteQuantity(2048).text}`);
  });
});

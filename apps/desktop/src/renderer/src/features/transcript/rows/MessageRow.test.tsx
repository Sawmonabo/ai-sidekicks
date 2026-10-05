// Which body a message row renders, what its Copy takes, where a reply's foot stands, the inline
// cards it hosts, and what its receipt leaves out.

import { formatByteQuantity } from "@renderer/lib/wire-figures.js";
import type { HydratedSessionEventContent } from "@ai-sidekicks/contracts/event-envelope";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  inlineCardRegistry,
  type InlineCardProps,
} from "@renderer/registries/inline-cards/inline-card-registry.js";
import {
  createFixtureBridge,
  type FixtureBridge,
} from "@renderer/services/platform/platform-bridge.fixture.js";
import type { ClipboardContent } from "@shared/preload-api.js";
import { FixtureBridgeProvider } from "@test/helpers/app-frame-fixtures.js";
import { MessageRow } from "./MessageRow.js";
import { classifyTranscriptRow } from "./row-kind.js";
import { FootnoteRegistry } from "./markdown/footnotes/footnote-registry.js";
import { sampleRunRow } from "@test/helpers/transcript-event-row-samples.js";
import { FIRST_RUN_SCENARIO } from "@fixtures/scenarios/first-run.js";
import {
  RowRevealContext,
  type RowRevealContextValue,
} from "../reveal/components/RowRevealProvider.js";
import { replyRowIdsByFootRowId } from "../window/reply-rows.js";

function renderMessageCard(
  overrides: {
    readonly id?: string;
    readonly type?: string;
    readonly summary?: string;
    readonly payload?: Readonly<Record<string, unknown>>;
    readonly content?: HydratedSessionEventContent;
    readonly liveText?: string;
    readonly inlineCards?: readonly InlineCardProps[];
    readonly replyRowIds?: readonly string[] | undefined;
    readonly revealChannel?: RowRevealContextValue;
    readonly fixture?: FixtureBridge;
  } = {},
): HTMLElement {
  const row = sampleRunRow({
    ...(overrides.id === undefined ? {} : { id: overrides.id }),
    type: overrides.type ?? "assistant.message",
    ...(overrides.summary === undefined ? {} : { summary: overrides.summary }),
    ...(overrides.payload === undefined ? {} : { payload: overrides.payload }),
  });
  const rowKind = classifyTranscriptRow(row);
  if (rowKind === undefined) {
    throw new Error(`${row.type} is not a message kind`);
  }
  const { container } = render(
    <FixtureBridgeProvider
      fixture={overrides.fixture ?? createFixtureBridge({ scenario: FIRST_RUN_SCENARIO })}
    >
      <RowRevealContext value={overrides.revealChannel}>
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
          {...(overrides.replyRowIds === undefined ? {} : { replyRowIds: overrides.replyRowIds })}
          editControl={undefined}
        />
      </RowRevealContext>
    </FixtureBridgeProvider>,
  );
  return container;
}

describe("which body a message renders", () => {
  it("renders a user's row through the row's own summary", () => {
    // A user's words reach no `TranscriptEventRow`; the summary is all the wire carries.
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

describe("a message's Copy", () => {
  /** Presses the row's Copy and answers what main was asked to write. */
  async function pressCopy(overrides: Parameters<typeof renderMessageCard>[0]) {
    const fixture = createFixtureBridge({ scenario: FIRST_RUN_SCENARIO });
    const copied: ClipboardContent[] = [];
    vi.spyOn(fixture.bridge.native, "copyToClipboard").mockImplementation(async (content) => {
      copied.push(content);
    });
    renderMessageCard({ ...overrides, fixture });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy" }));
      await Promise.resolve();
    });
    return copied;
  }

  it("writes a reply's markdown with a formatted flavor beside it", async () => {
    const reply = "Rename **the reader** and keep `its callers`.";
    const copied = await pressCopy({
      content: { status: "available", body: reply },
      replyRowIds: ["event-01"],
    });

    expect(copied).toStrictEqual([
      {
        text: reply,
        html: "<p>Rename <strong>the reader</strong> and keep <code>its callers</code>.</p>",
      },
    ]);
  });

  it("takes the whole turn's text from the reply's foot, and leaves the tool row out", async () => {
    const turn = [
      sampleRunRow({ id: "reply-opening", type: "assistant.message" }),
      sampleRunRow({ id: "tool-between", type: "tool.result" }),
      sampleRunRow({ id: "reply-closing", type: "assistant.message" }),
    ];
    const replyRows = replyRowIdsByFootRowId(turn);
    // Only the reply's last row carries its foot, and the person's next message starts a new turn.
    expect(replyRows.get("reply-opening")).toBeUndefined();
    const nextTurn = replyRowIdsByFootRowId([
      ...turn,
      sampleRunRow({ id: "person-asks", type: "user.message" }),
      sampleRunRow({ id: "reply-next", type: "assistant.message" }),
    ]);
    expect(nextTurn.get("reply-next")).toStrictEqual(["reply-next"]);
    const drawnText = new Map([
      ["reply-opening", "Read **the reader** first."],
      ["tool-between", "tool output: 3 files changed"],
    ]);
    const copied = await pressCopy({
      id: "reply-closing",
      content: { status: "available", body: "Then rename it." },
      replyRowIds: replyRows.get("reply-closing"),
      revealChannel: {
        publishedTextFor: (rowId) => drawnText.get(rowId),
        subscribe: () => () => undefined,
      },
    });

    expect(copied).toStrictEqual([
      {
        text: "Read **the reader** first.\n\nThen rename it.",
        html: "<p>Read <strong>the reader</strong> first.</p>\n<p>Then rename it.</p>",
      },
    ]);
  });

  it("writes the person's own message as plain text and nothing else", async () => {
    const copied = await pressCopy({ type: "user.message", summary: "Rename **the reader**" });

    expect(copied).toStrictEqual([{ text: "Rename **the reader**" }]);
  });
});

describe("a reply's foot", () => {
  it("stands on the reply's last row alone, with its one time and Copy, once it has text", () => {
    const occurredAt = "2026-09-02T10:00:00.000Z";
    const replyRows = replyRowIdsByFootRowId([
      sampleRunRow({ id: "reply-opening", type: "assistant.message" }),
      sampleRunRow({ id: "reply-closing", type: "assistant.message" }),
    ]);
    const timesIn = (container: HTMLElement) =>
      container.querySelectorAll(`[title="${occurredAt}"]`);

    const opening = renderMessageCard({
      id: "reply-opening",
      content: { status: "available", body: "Read the reader first." },
      replyRowIds: replyRows.get("reply-opening"),
    });
    expect(timesIn(opening)).toHaveLength(0);
    expect(opening.querySelector(".meridian-transcript-row-layout__footer")).toBeNull();

    // Nothing to read yet: no foot, and no time standing over the empty answer.
    const empty = renderMessageCard({
      id: "reply-closing",
      replyRowIds: replyRows.get("reply-closing"),
    });
    expect(timesIn(empty)).toHaveLength(0);
    expect(empty.querySelector(".meridian-transcript-row-layout__footer")).toBeNull();

    const closing = renderMessageCard({
      id: "reply-closing",
      liveText: "Then rename it.",
      replyRowIds: replyRows.get("reply-closing"),
    });
    const foot = closing.querySelector(".meridian-transcript-row-layout__footer");
    const time = timesIn(closing)[0];
    const copy = foot?.querySelector("button");
    expect(timesIn(closing)).toHaveLength(1);
    expect(foot?.contains(time ?? null)).toBe(true);
    expect(copy?.textContent).toBe("Copy");
    // The foot and its time stand at rest; only the Copy waits for a hover or focus.
    expect(foot?.classList.contains("meridian-transcript-row-layout__footer--on-hover")).toBe(
      false,
    );
    expect(time?.closest(".meridian-transcript-row-layout__revealed")).toBeNull();
    expect(foot?.contains(copy?.closest(".meridian-transcript-row-layout__revealed") ?? null)).toBe(
      true,
    );

    // The last row has nothing to read yet, but an earlier row does: the reply still has its foot.
    const closingAfterText = renderMessageCard({
      id: "reply-closing",
      replyRowIds: replyRows.get("reply-closing"),
      revealChannel: {
        publishedTextFor: (rowId) => (rowId === "reply-opening" ? "Read it first." : undefined),
        subscribe: () => () => undefined,
      },
    });
    expect(timesIn(closingAfterText)).toHaveLength(1);
    expect(
      closingAfterText.querySelectorAll(".meridian-transcript-row-layout__footer button"),
    ).toHaveLength(1);
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

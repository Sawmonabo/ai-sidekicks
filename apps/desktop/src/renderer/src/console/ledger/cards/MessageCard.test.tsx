// Three families, one layout — and the slot this card holds open for another plan.

import type { HydratedSessionEventContent } from "@ai-sidekicks/contracts";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  inlineCardSeatRegistry,
  type InlineCardSeatProps,
  type OwnerSlotProps,
} from "../../seats/index.js";
import { EDIT_AFFORDANCE_SLOT, MessageCard } from "./MessageCard.js";
import { FootnoteRegistry } from "./markdown/index.js";
import { sampleRunRow } from "./row-samples.js";

const EMPTY_SLOT: OwnerSlotProps<React.ReactNode> = {
  contract: EDIT_AFFORDANCE_SLOT,
  body: undefined,
};

function renderMessageCard(
  overrides: {
    readonly type?: string;
    readonly summary?: string;
    readonly payload?: Readonly<Record<string, unknown>>;
    readonly content?: HydratedSessionEventContent;
    readonly liveText?: string;
    readonly inlineCards?: readonly InlineCardSeatProps[];
    readonly editAffordance?: OwnerSlotProps<React.ReactNode>;
  } = {},
): HTMLElement {
  const { container } = render(
    <MessageCard
      row={sampleRunRow({
        type: overrides.type ?? "assistant.message",
        ...(overrides.summary === undefined ? {} : { summary: overrides.summary }),
        ...(overrides.payload === undefined ? {} : { payload: overrides.payload }),
      })}
      participantHue={undefined}
      isSuperseded={false}
      density="expanded"
      footnotes={new FootnoteRegistry()}
      {...(overrides.content === undefined ? {} : { content: overrides.content })}
      {...(overrides.liveText === undefined ? {} : { liveText: overrides.liveText })}
      {...(overrides.inlineCards === undefined ? {} : { inlineCards: overrides.inlineCards })}
      editAffordance={overrides.editAffordance ?? EMPTY_SLOT}
    />,
  );
  return container;
}

describe("which body a message renders", () => {
  it("renders a participant's row through the row's own summary", () => {
    // The whole of what the wire carries for a participant: their words are sealed in
    // the per-participant encrypted column and reach no timeline row.
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

  it("negative control: a participant row never renders the machine-body absence", () => {
    // Without this, a card that routed every family through `MachineBody` would put
    // "this body has not been read" under every message a person typed.
    const container = renderMessageCard({ type: "user.message", summary: "hello" });
    expect(container.querySelector(".meridian-nothing--not-checked")).toBeNull();
  });

  it("says so when a participant row carries no summary at all", () => {
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
    const participant = renderMessageCard({ type: "user.message" });
    const assistant = renderMessageCard({ type: "assistant.message" });
    expect(participant.querySelector(".meridian-message-card--participant-message")).not.toBeNull();
    expect(assistant.querySelector(".meridian-message-card--participant-message")).toBeNull();
  });
});

describe("the edit affordance slot", () => {
  it("renders the owning plan's body once it is supplied", () => {
    const container = renderMessageCard({
      type: "user.message",
      editAffordance: {
        contract: EDIT_AFFORDANCE_SLOT,
        body: <button type="button">Edit</button>,
      },
    });
    expect(container.querySelector("button")?.textContent).toBe("Edit");
  });

  it("renders nothing at all while the slot is empty", () => {
    const container = renderMessageCard({ type: "user.message" });
    expect(container.querySelector("button")).toBeNull();
  });

  it("offers no slot on a machine row", () => {
    // The affordance edits a participant's own boundary; a reply has none to edit.
    const container = renderMessageCard({
      type: "assistant.message",
      editAffordance: {
        contract: EDIT_AFFORDANCE_SLOT,
        body: <button type="button">Edit</button>,
      },
    });
    expect(container.querySelector("button")).toBeNull();
  });

  it("names its owner, its obligation, and when the slot dies", () => {
    expect(EDIT_AFFORDANCE_SLOT.owningTask).not.toBe("");
    expect(EDIT_AFFORDANCE_SLOT.mountObligation).not.toBe("");
    expect(EDIT_AFFORDANCE_SLOT.deleteShellIn).not.toBe("");
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

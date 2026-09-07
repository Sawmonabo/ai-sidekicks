// The ask card: two answer arms, a countdown that settles nothing, and four terminals.

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { INPUT_ASK_SLOT, type DriverAskReading } from "./input-ask.js";
import { InputAskCard } from "./InputAskCard.js";

/**
 * Ten o'clock, as the mount would read it, and five past, as the daemon stamps it.
 *
 * Both stated with `Date.UTC` rather than read back out of a string: the platform
 * parser is banned in this tree because it normalizes rather than refuses, and a
 * fixture that derived its milliseconds by parsing its own literal would be asking a
 * reader to trust the one function the console does not use.
 */
const NOW_MILLISECONDS = Date.UTC(2026, 8, 2, 10, 0, 0);
const PAST_THE_DEADLINE_MILLISECONDS = Date.UTC(2026, 8, 2, 10, 6, 0);

function pendingAsk(overrides: Partial<DriverAskReading> = {}): DriverAskReading {
  return {
    askId: "ask-01",
    state: "requested",
    prompt: "Which branch should this land on?",
    options: [],
    expiresAt: "2026-09-02T10:05:00.000Z",
    deliveredAnswer: undefined,
    ...overrides,
  };
}

function renderCard(
  ask: DriverAskReading,
  overrides: {
    readonly nowEpochMilliseconds?: number;
    readonly onAnswer?: (response: string) => void;
    readonly body?: (props: { readonly ask: DriverAskReading }) => React.ReactNode;
  } = {},
): HTMLElement {
  const { container } = render(
    <InputAskCard
      slot={{ contract: INPUT_ASK_SLOT, body: overrides.body }}
      ask={ask}
      nowEpochMilliseconds={overrides.nowEpochMilliseconds ?? NOW_MILLISECONDS}
      onAnswer={overrides.onAnswer ?? (() => undefined)}
    />,
  );
  return container;
}

describe("the pending ask", () => {
  it("renders the provider's question", () => {
    expect(renderCard(pendingAsk()).textContent).toContain("Which branch should this land on?");
  });

  it("says so when the ask carried no question rather than rendering an empty region", () => {
    const container = renderCard(pendingAsk({ prompt: undefined }));
    expect(container.textContent).toContain("carried no question");
  });

  it("offers the free-text arm on an ask that declared no choice set", () => {
    const container = renderCard(pendingAsk());
    expect(container.querySelector(".meridian-input-ask__field")).not.toBeNull();
    expect(container.querySelector(".meridian-input-ask__option")).toBeNull();
  });

  it("offers the free-text arm beside a choice set rather than instead of it", () => {
    const container = renderCard(
      pendingAsk({ options: [{ value: "develop", label: "The integration branch" }] }),
    );
    expect(container.querySelector(".meridian-input-ask__field")).not.toBeNull();
    expect(container.textContent).toContain("The integration branch");
    expect(container.textContent).toContain("develop");
  });

  it("delivers the option's value and never its label", () => {
    const onAnswer = vi.fn();
    const container = renderCard(
      pendingAsk({ options: [{ value: "develop", label: "The integration branch" }] }),
      { onAnswer },
    );
    container.querySelector<HTMLButtonElement>(".meridian-input-ask__option")?.click();
    expect(onAnswer).toHaveBeenCalledWith("develop");
  });

  it("renders an option with no label by its value alone", () => {
    const container = renderCard(pendingAsk({ options: [{ value: "main", label: undefined }] }));
    expect(container.textContent).toContain("main");
    expect(container.querySelector(".meridian-input-ask__option-label")).toBeNull();
  });
});

describe("the countdown", () => {
  it("shows what the daemon's stamp leaves", () => {
    expect(renderCard(pendingAsk()).textContent).toContain("Answer within");
  });

  // THE RULE THIS SURFACE MOST HAS TO KEEP: a countdown at zero is a statement about
  // the console, never about the ask. An input ask that expires parks its run, and
  // only the `driver_ask.expired` row may say that it did.
  it("waits for the daemon past zero rather than settling a terminal", () => {
    const container = renderCard(pendingAsk(), {
      nowEpochMilliseconds: PAST_THE_DEADLINE_MILLISECONDS,
    });
    expect(container.textContent).toContain("Waiting for the daemon.");
    expect(container.textContent).not.toContain("expired");
  });

  it("negative control: the answer arms survive a countdown that reached zero", () => {
    // Without this, a card that hid its arms at zero would leave a still-open ask
    // unanswerable for as long as the daemon took to settle it.
    const container = renderCard(pendingAsk(), {
      nowEpochMilliseconds: PAST_THE_DEADLINE_MILLISECONDS,
    });
    expect(container.querySelector(".meridian-input-ask__field")).not.toBeNull();
  });

  it("counts nothing down for a row carrying no deadline", () => {
    const container = renderCard(pendingAsk({ expiresAt: undefined }));
    expect(container.textContent).toContain("No deadline was stamped");
    expect(container.textContent).not.toContain("Answer within");
  });

  it("counts nothing down for a stamp it could not read", () => {
    const container = renderCard(pendingAsk({ expiresAt: "not a timestamp" }));
    expect(container.textContent).toContain("No deadline was stamped");
  });
});

describe("the terminals", () => {
  it("shows the delivered answer on the responded row", () => {
    const container = renderCard(
      pendingAsk({ state: "responded", deliveredAnswer: "develop", options: [] }),
    );
    expect(container.textContent).toContain("was answered");
    expect(container.textContent).toContain("develop");
  });

  it("says which of the two closures happened", () => {
    expect(renderCard(pendingAsk({ state: "expired" })).textContent).toContain("expired");
    expect(renderCard(pendingAsk({ state: "canceled" })).textContent).toContain("canceled");
  });

  it("negative control: expired and canceled are not one sentence", () => {
    const expired = renderCard(pendingAsk({ state: "expired" })).textContent;
    const canceled = renderCard(pendingAsk({ state: "canceled" })).textContent;
    expect(expired).not.toBe(canceled);
  });

  it("offers no answer arm on a settled ask", () => {
    const container = renderCard(pendingAsk({ state: "expired" }));
    expect(container.querySelector(".meridian-input-ask__field")).toBeNull();
    expect(container.querySelector(".meridian-input-ask__option")).toBeNull();
  });
});

describe("the plan-owned body", () => {
  it("replaces the shell entirely once it is mounted", () => {
    const container = renderCard(pendingAsk(), { body: () => <p>the real ask card</p> });
    expect(container.textContent).toBe("the real ask card");
  });
});

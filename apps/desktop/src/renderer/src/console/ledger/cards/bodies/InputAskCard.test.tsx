// The ask card: two answer arms, a countdown that settles nothing, four terminals, and
// what became of the answer a press dispatched.
//
// THE DELIVERY CASES READ WHAT A PARTICIPANT WOULD SEE AND WHAT THEY COULD STILL DO.
// The defect was that a refused answer reached the screen nowhere: the free-text arm
// emptied itself on dispatch, the option buttons changed not at all, and a run blocked
// on an unanswered ask looked like one waiting to be typed into. So every case below
// asserts on the rendered field or the rendered refusal, never on a callback count.

import { fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  ASK_ANSWER_UNSENT,
  INPUT_ASK_SLOT,
  type DriverAskDelivery,
  type DriverAskReading,
} from "./input-ask.js";
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
    // The card renders nothing off the run and the reading requires it, so a fixture
    // that omitted it would be a shape the reader cannot produce.
    runId: undefined,
    state: "requested",
    prompt: "Which branch should this land on?",
    options: [],
    expiresAt: "2026-09-02T10:05:00.000Z",
    deliveredAnswer: undefined,
    ...overrides,
  };
}

/** One refused delivery, carrying the door's own refusal shape. */
const REFUSED_DELIVERY: DriverAskDelivery = {
  status: "refused",
  response: "develop",
  refusal: {
    code: "driver.request_not_found",
    detail: "The driver has no record of this ask.",
    origin: "daemon",
  },
};

function renderCard(
  ask: DriverAskReading,
  overrides: {
    readonly nowEpochMilliseconds?: number;
    readonly delivery?: DriverAskDelivery;
    readonly onAnswer?: (response: string) => void;
    readonly body?: (props: { readonly ask: DriverAskReading }) => React.ReactNode;
  } = {},
): HTMLElement {
  const { container } = render(
    <InputAskCard
      slot={{ contract: INPUT_ASK_SLOT, body: overrides.body }}
      ask={ask}
      nowEpochMilliseconds={overrides.nowEpochMilliseconds ?? NOW_MILLISECONDS}
      delivery={overrides.delivery ?? ASK_ANSWER_UNSENT}
      onAnswer={overrides.onAnswer ?? (() => undefined)}
    />,
  );
  return container;
}

/** The free-text field, or a failure naming the card that drew none. */
function fieldOf(container: HTMLElement): HTMLTextAreaElement {
  const field = container.querySelector<HTMLTextAreaElement>(".meridian-input-ask__field");
  if (field === null) {
    throw new Error("the ask card drew no free-text field");
  }
  return field;
}

/** Type an answer into the free-text arm and submit it, as a participant would. */
function sendFreeText(container: HTMLElement, text: string): void {
  fireEvent.change(fieldOf(container), { target: { value: text } });
  fireEvent.click(container.querySelector(".meridian-input-ask__send") as Element);
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

/**
 * The card inside a holder that owns the delivery, which is what the row is.
 *
 * The card is controlled — it dispatches and renders what it is handed — so a case
 * about what a PRESS leaves on screen has to close that loop, or it is asserting over
 * a component that decides nothing.
 */
function MountedWithDelivery(props: {
  readonly ask: DriverAskReading;
  readonly settled: DriverAskDelivery;
}): React.JSX.Element {
  const [delivery, setDelivery] = useState<DriverAskDelivery>(ASK_ANSWER_UNSENT);
  return (
    <InputAskCard
      slot={{ contract: INPUT_ASK_SLOT, body: undefined }}
      ask={props.ask}
      nowEpochMilliseconds={NOW_MILLISECONDS}
      delivery={delivery}
      onAnswer={() => {
        setDelivery(props.settled);
      }}
    />
  );
}

describe("what became of the answer", () => {
  it("keeps the participant's words on screen when the answer was refused", () => {
    // THE DEFECT, EXERCISED. The arm cleared the field the instant the callback
    // returned, so a delivery that never reached the driver left an empty box, a
    // blocked run, and nothing to retry from.
    const { container } = render(
      <MountedWithDelivery ask={pendingAsk()} settled={REFUSED_DELIVERY} />,
    );

    sendFreeText(container, "land it on develop");

    expect(fieldOf(container).value).toBe("land it on develop");
    expect(container.textContent).toContain("driver.request_not_found");
    expect(container.textContent).toContain("The driver has no record of this ask.");
  });

  it("leaves every answer control pressable after a refusal", () => {
    // Rule 9: a refusal never hides the control that produced it. Without this the
    // refusal would be readable and the retry unreachable.
    const container = renderCard(
      pendingAsk({ options: [{ value: "develop", label: undefined }] }),
      { delivery: REFUSED_DELIVERY },
    );
    expect(
      container.querySelector<HTMLButtonElement>(".meridian-input-ask__option")?.disabled,
    ).toBe(false);
    expect(fieldOf(container).disabled).toBe(false);
  });

  it("clears the draft once the driver has acknowledged the answer", () => {
    const { container } = render(
      <MountedWithDelivery
        ask={pendingAsk()}
        settled={{ status: "accepted", response: "land it on develop" }}
      />,
    );

    sendFreeText(container, "land it on develop");

    expect(fieldOf(container).value).toBe("");
    expect(container.textContent).toContain("The answer reached the driver.");
  });

  it("says it is waiting for the daemon rather than that the ask was answered", () => {
    // The ask's terminal is the `driver_ask.responded` row's to state. A card that
    // said "answered" here would settle an ask the daemon has not settled.
    //
    // Read off the BADGE, because that is where the words are: an inline absence
    // carries its second line as the label's tooltip rather than as text — see
    // `Nothing.tsx` — so a case reading `textContent` alone would report a wait this
    // card never renders.
    const container = renderCard(pendingAsk(), {
      delivery: { status: "accepted", response: "develop" },
    });
    const badge = container.querySelector(".meridian-nothing__badge-label");
    expect(badge?.textContent).toBe("The answer reached the driver.");
    expect(badge?.getAttribute("title")).toContain("Waiting for this ask's own row");
    expect(container.textContent).not.toContain("This ask was answered.");
  });

  it("dims every answer control while one answer is on the wire", () => {
    const container = renderCard(
      pendingAsk({ options: [{ value: "develop", label: undefined }] }),
      { delivery: { status: "delivering", response: "develop" } },
    );
    expect(
      container.querySelector<HTMLButtonElement>(".meridian-input-ask__option")?.disabled,
    ).toBe(true);
    expect(fieldOf(container).disabled).toBe(true);
    expect(container.textContent).toContain("Delivering this answer.");
  });

  it("negative control: an ask nobody has answered says nothing about a delivery", () => {
    // Without this, a card that always drew a delivery line would print console
    // bookkeeping under every open ask on the log.
    const container = renderCard(pendingAsk());
    expect(container.textContent).not.toContain("Delivering this answer.");
    expect(container.textContent).not.toContain("reached the driver");
    expect(container.querySelector(".meridian-refusal")).toBeNull();
  });
});

describe("the plan-owned body", () => {
  it("replaces the shell entirely once it is mounted", () => {
    const container = renderCard(pendingAsk(), { body: () => <p>the real ask card</p> });
    expect(container.textContent).toBe("the real ask card");
  });
});

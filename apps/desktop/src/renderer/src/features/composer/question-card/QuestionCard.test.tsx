// The question card: what became of the answer a press dispatched.
//
// THE DELIVERY CASES READ WHAT A USER WOULD SEE AND WHAT THEY COULD STILL DO.
// The defect was that a refused answer reached the screen nowhere: the free-text arm
// emptied itself on dispatch, and a run blocked on an unanswered question looked like
// one waiting to be typed into. So every case below asserts on the rendered field or
// the rendered refusal, never on a callback count.

import { fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import {
  UNSENT_ANSWER_DELIVERY,
  type AnswerDelivery,
  type QuestionReading,
} from "@renderer/store/session-events/question-reading.js";
import { QuestionCard } from "./QuestionCard.js";

const OPEN_QUESTION: QuestionReading = {
  questionId: "019b793b-7b60-7a21-9f14-6b0c2a7d0e11",
  runId: undefined,
  pageCount: 1,
};

/** One refused delivery, carrying the call's own refusal shape. */
const REFUSED_DELIVERY: AnswerDelivery = {
  status: "refused",
  response: "develop",
  refusal: {
    code: "call-rejected",
    detail: "The background service is not answering.",
    origin: "daemon",
  },
};

function renderCard(
  overrides: {
    readonly delivery?: AnswerDelivery;
    readonly body?: (props: { readonly question: QuestionReading }) => React.ReactNode;
  } = {},
): HTMLElement {
  const { container } = render(
    <QuestionCard
      body={overrides.body}
      question={OPEN_QUESTION}
      delivery={overrides.delivery ?? UNSENT_ANSWER_DELIVERY}
      onAnswer={() => undefined}
    />,
  );
  return container;
}

/** The free-text field, or a failure naming the card that drew none. */
function fieldOf(container: HTMLElement): HTMLTextAreaElement {
  const field = container.querySelector<HTMLTextAreaElement>(".meridian-input-ask__field");
  if (field === null) {
    throw new Error("the question card drew no free-text field");
  }
  return field;
}

/** Type an answer into the free-text arm and submit it, as a user would. */
function sendFreeText(container: HTMLElement, text: string): void {
  fireEvent.change(fieldOf(container), { target: { value: text } });
  fireEvent.click(container.querySelector(".meridian-input-ask__send") as Element);
}

/**
 * The card inside a holder that owns the delivery, which is what the mount is.
 *
 * The card is controlled — it dispatches and renders what it is handed — so a case
 * about what a PRESS leaves on screen has to close that loop, or it is asserting over
 * a component that decides nothing.
 */
function MountedWithDelivery(props: { readonly settled: AnswerDelivery }): React.JSX.Element {
  const [delivery, setDelivery] = useState<AnswerDelivery>(UNSENT_ANSWER_DELIVERY);
  return (
    <QuestionCard
      body={undefined}
      question={OPEN_QUESTION}
      delivery={delivery}
      onAnswer={() => {
        setDelivery(props.settled);
      }}
    />
  );
}

describe("what became of the answer", () => {
  it("keeps the user's words on screen when the answer was refused", () => {
    // THE DEFECT, EXERCISED. The arm cleared the field the instant the callback
    // returned, so a delivery that never reached the daemon left an empty box, a
    // blocked run, and nothing to retry from.
    const { container } = render(<MountedWithDelivery settled={REFUSED_DELIVERY} />);

    sendFreeText(container, "land it on develop");

    expect(fieldOf(container).value).toBe("land it on develop");
    expect(container.textContent).toContain("call-rejected");
    expect(container.textContent).toContain("The background service is not answering.");
  });

  it("leaves the field usable after a refusal", () => {
    // A refusal never hides the control that produced it. Without this the
    // refusal would be readable and the retry unreachable.
    expect(fieldOf(renderCard({ delivery: REFUSED_DELIVERY })).disabled).toBe(false);
  });

  it("clears the draft once the daemon has taken the answer", () => {
    const { container } = render(
      <MountedWithDelivery settled={{ status: "accepted", response: "land it on develop" }} />,
    );

    sendFreeText(container, "land it on develop");

    expect(fieldOf(container).value).toBe("");
    expect(container.textContent).toContain("The answer was delivered.");
  });

  it("closes the field while one answer is on the wire", () => {
    const container = renderCard({ delivery: { status: "delivering", response: "develop" } });
    expect(fieldOf(container).disabled).toBe(true);
    expect(container.textContent).toContain("Delivering this answer.");
  });

  it("negative control: a question nobody has answered says nothing about a delivery", () => {
    // Without this, a card that always drew a delivery line would print console
    // bookkeeping under every open question on the log.
    const container = renderCard();
    expect(container.textContent).not.toContain("Delivering this answer.");
    expect(container.textContent).not.toContain("was delivered");
    expect(container.querySelector(".meridian-refusal")).toBeNull();
  });
});

describe("the mount-owned body", () => {
  it("replaces the built-in card entirely once it is mounted", () => {
    const container = renderCard({ body: () => <p>the real question card</p> });
    expect(container.textContent).toBe("the real question card");
  });
});

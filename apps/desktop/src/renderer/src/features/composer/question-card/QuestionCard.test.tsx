// The question card: the answers it sends, and what became of them.
//
// THE CASES READ WHAT A PERSON WOULD SEE AND WHAT THEY COULD STILL DO. A refused answer
// once reached the screen nowhere: the typed field emptied itself on dispatch, and a run
// blocked on an unanswered question looked like one waiting to be typed into. So the
// delivery cases assert on the rendered controls or the rendered refusal, and the
// answer cases on the list the card hands its mount.

import { fireEvent, render, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import type { QuestionAnswer, QuestionPrompt } from "@ai-sidekicks/contracts";

import {
  UNSENT_ANSWER_DELIVERY,
  type AnswerDelivery,
  type QuestionReading,
} from "@renderer/store/session-events/question-reading.js";
import { QuestionCard } from "./QuestionCard.js";

const OPEN_QUESTION: QuestionReading = {
  questionId: "019b793b-7b60-7a21-9f14-6b0c2a7d0e11",
  runId: undefined,
  pageCount: 2,
};

const BRANCH_QUESTION: QuestionPrompt = {
  header: "Branch",
  text: "Which branch should this land on?",
  heading: "Landing the fix",
  options: [{ label: "develop", description: "The integration branch" }, { label: "main" }],
  severalAnswers: false,
  secret: false,
};

const NOTES_QUESTION: QuestionPrompt = {
  text: "Anything the reviewer should know?",
  options: [],
  severalAnswers: false,
  secret: false,
};

const QUESTIONS = [BRANCH_QUESTION, NOTES_QUESTION];

/** One refused delivery, carrying the call's own refusal shape. */
const REFUSED_DELIVERY: AnswerDelivery = {
  status: "refused",
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
    readonly onAnswer?: (answers: QuestionAnswer[]) => void;
  } = {},
): HTMLElement {
  const { container } = render(
    <QuestionCard
      body={overrides.body}
      question={OPEN_QUESTION}
      questions={QUESTIONS}
      delivery={overrides.delivery ?? UNSENT_ANSWER_DELIVERY}
      onAnswer={overrides.onAnswer ?? (() => undefined)}
    />,
  );
  return container;
}

/** The card's section for the question at `index`. */
function questionSection(container: HTMLElement, index: number): HTMLElement {
  const section = container.querySelectorAll<HTMLElement>(".meridian-input-ask__question")[index];
  if (section === undefined) {
    throw new Error(`the question card drew no question ${String(index)}`);
  }
  return section;
}

function fieldOf(container: HTMLElement, index: number): HTMLTextAreaElement {
  return within(questionSection(container, index)).getByRole("textbox");
}

function answerButton(container: HTMLElement): HTMLButtonElement {
  return within(container).getByRole("button", { name: "Answer" });
}

/** The option row whose label is `label`; its accessible name also carries the description. */
function optionRow(container: HTMLElement, index: number, label: string): HTMLButtonElement {
  return within(questionSection(container, index)).getByRole("button", {
    name: new RegExp(`^${label}`),
  });
}

function pick(container: HTMLElement, index: number, label: string): void {
  fireEvent.click(optionRow(container, index, label));
}

function type(container: HTMLElement, index: number, text: string): void {
  fireEvent.change(fieldOf(container, index), { target: { value: text } });
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
      questions={QUESTIONS}
      delivery={delivery}
      onAnswer={() => {
        setDelivery(props.settled);
      }}
    />
  );
}

describe("the questions it draws", () => {
  it("draws each question with its header, summary line, options and typed field", () => {
    const branch = within(questionSection(renderCard(), 0));

    expect(branch.getByText("Branch")).toBeTruthy();
    expect(branch.getByText("Which branch should this land on?")).toBeTruthy();
    expect(branch.getByText("Landing the fix")).toBeTruthy();
    expect(branch.getByRole("button", { name: /^develop/ }).textContent).toContain(
      "The integration branch",
    );
    expect(branch.getByRole("button", { name: /^main/ })).toBeTruthy();
    expect(branch.getByRole("textbox")).toBeTruthy();
  });
});

describe("the answers it sends", () => {
  it("sends one answer per question, in the record's order, only once every question has one", () => {
    const sent: QuestionAnswer[][] = [];
    const container = renderCard({ onAnswer: (answers) => sent.push(answers) });

    pick(container, 0, "develop");
    expect(answerButton(container).disabled).toBe(true);
    fireEvent.click(answerButton(container));
    expect(sent).toStrictEqual([]);

    type(container, 1, "the flaky test is known");
    fireEvent.click(answerButton(container));

    expect(sent).toStrictEqual([
      [
        { kind: "picked", labels: ["develop"] },
        { kind: "typed", text: "the flaky test is known" },
      ],
    ]);
  });

  it("takes whichever of a marked row and typed text the person touched last", () => {
    const sent: QuestionAnswer[][] = [];
    const container = renderCard({ onAnswer: (answers) => sent.push(answers) });
    type(container, 1, "none");

    pick(container, 0, "develop");
    type(container, 0, "a release branch");
    fireEvent.click(answerButton(container));
    pick(container, 0, "main");
    fireEvent.click(answerButton(container));

    expect(sent.map((answers) => answers[0])).toStrictEqual([
      { kind: "typed", text: "a release branch" },
      { kind: "picked", labels: ["main"] },
    ]);
  });
});

describe("what became of the answer", () => {
  it("keeps the person's answers on screen when the answer was refused", () => {
    // THE DEFECT, EXERCISED. The field once cleared the instant the callback returned,
    // so a delivery that never reached the daemon left an empty box, a blocked run, and
    // nothing to retry from.
    const { container } = render(<MountedWithDelivery settled={REFUSED_DELIVERY} />);

    pick(container, 0, "develop");
    type(container, 1, "the flaky test is known");
    fireEvent.click(answerButton(container));

    expect(optionRow(container, 0, "develop").getAttribute("aria-pressed")).toBe("true");
    expect(fieldOf(container, 1).value).toBe("the flaky test is known");
    expect(container.textContent).toContain("call-rejected");
    expect(container.textContent).toContain("The background service is not answering.");
  });

  it("leaves the controls usable after a refusal", () => {
    // A refusal never hides the control that produced it. Without this the refusal
    // would be readable and the retry unreachable.
    const container = renderCard({ delivery: REFUSED_DELIVERY });
    expect(fieldOf(container, 0).disabled).toBe(false);
    expect(optionRow(container, 0, "main").disabled).toBe(false);
  });

  it("clears the answers once the daemon has taken them", () => {
    const { container } = render(<MountedWithDelivery settled={{ status: "accepted" }} />);

    pick(container, 0, "develop");
    type(container, 1, "the flaky test is known");
    fireEvent.click(answerButton(container));

    expect(optionRow(container, 0, "develop").getAttribute("aria-pressed")).toBe("false");
    expect(fieldOf(container, 1).value).toBe("");
    expect(container.textContent).toContain("The answer was delivered.");
  });

  it("closes the controls while one answer is on the wire", () => {
    const container = renderCard({ delivery: { status: "delivering" } });
    expect(fieldOf(container, 0).disabled).toBe(true);
    expect(optionRow(container, 0, "main").disabled).toBe(true);
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

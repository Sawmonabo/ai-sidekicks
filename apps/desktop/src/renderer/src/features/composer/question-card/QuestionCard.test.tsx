// The question card: the answers it hands its mount, a secret only ever as a secret, drafts that
// never cross to another record, and answers kept on screen when a delivery is refused.

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

const TOKEN_QUESTION: QuestionPrompt = {
  header: "Deploy",
  text: "Paste the deploy token",
  options: [],
  severalAnswers: false,
  secret: true,
};

const REFUSED_DELIVERY: AnswerDelivery = {
  status: "refused",
  refusal: {
    code: "call-rejected",
    detail: "The background service is not answering.",
    origin: "daemon",
  },
};

function renderCard(onAnswer: (answers: QuestionAnswer[]) => void): HTMLElement {
  const { container } = render(
    <QuestionCard
      question={OPEN_QUESTION}
      questions={QUESTIONS}
      delivery={UNSENT_ANSWER_DELIVERY}
      onAnswer={onAnswer}
    />,
  );
  return container;
}

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
 * The card inside a holder that owns the delivery, as a mount does. The card is controlled,
 * so a case about what a press leaves on screen has to close that loop.
 */
function MountedWithDelivery(props: { readonly settled: AnswerDelivery }): React.JSX.Element {
  const [delivery, setDelivery] = useState<AnswerDelivery>(UNSENT_ANSWER_DELIVERY);
  return (
    <QuestionCard
      question={OPEN_QUESTION}
      questions={QUESTIONS}
      delivery={delivery}
      onAnswer={() => {
        setDelivery(props.settled);
      }}
    />
  );
}

describe("the answers it sends", () => {
  it("sends one answer per question, in the record's order, only once every question has one", () => {
    const sent: QuestionAnswer[][] = [];
    const container = renderCard((answers) => sent.push(answers));

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
    const container = renderCard((answers) => sent.push(answers));
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

describe("a secret question", () => {
  it("draws one masked field and sends its value only as a secret", () => {
    // A `typed` answer is stored and a `secret` one is not, so a secret sent as `typed` would
    // be written down.
    const sent: QuestionAnswer[][] = [];
    const { container } = render(
      <QuestionCard
        question={OPEN_QUESTION}
        questions={[TOKEN_QUESTION]}
        delivery={UNSENT_ANSWER_DELIVERY}
        onAnswer={(answers) => sent.push(answers)}
      />,
    );
    const field = within(container).getByLabelText<HTMLInputElement>("Paste the deploy token");

    expect(field.type).toBe("password");
    expect(container.querySelector(".meridian-input-ask__options")).toBeNull();
    expect(container.textContent).not.toContain("Something else…");

    fireEvent.change(field, { target: { value: "tok-8f2c" } });
    fireEvent.click(answerButton(container));

    expect(sent).toStrictEqual([[{ kind: "secret", value: "tok-8f2c" }]]);
  });
});

describe("another record", () => {
  it("starts another record's card from empty drafts", () => {
    const card = (question: QuestionReading): React.JSX.Element => (
      <QuestionCard
        question={question}
        questions={QUESTIONS}
        delivery={UNSENT_ANSWER_DELIVERY}
        onAnswer={() => undefined}
      />
    );
    const { container, rerender } = render(card(OPEN_QUESTION));
    pick(container, 0, "develop");
    type(container, 1, "the flaky test is known");

    rerender(card({ ...OPEN_QUESTION, questionId: "019b793b-7b60-7a21-9f14-6b0c2a7d0e12" }));

    expect(optionRow(container, 0, "develop").getAttribute("aria-pressed")).toBe("false");
    expect(fieldOf(container, 1).value).toBe("");
  });
});

describe("what became of the answer", () => {
  it("keeps the person's answers on screen when the answer was refused", () => {
    // A delivery that never reached the daemon must leave the answers to retry from.
    const { container } = render(<MountedWithDelivery settled={REFUSED_DELIVERY} />);

    pick(container, 0, "develop");
    type(container, 1, "the flaky test is known");
    fireEvent.click(answerButton(container));

    expect(optionRow(container, 0, "develop").getAttribute("aria-pressed")).toBe("true");
    expect(fieldOf(container, 1).value).toBe("the flaky test is known");
    expect(container.textContent).toContain("The background service is not answering.");
  });
});

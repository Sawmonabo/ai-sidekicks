// The free-text field's DOM identity, driven through the card because one question can be drawn
// in two panes at once. The assertion is the label association, not the id string: with a
// shared id, either label focuses the first field and neither is unambiguous to assistive
// technology.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { QuestionPrompt } from "@ai-sidekicks/contracts";

import {
  UNSENT_ANSWER_DELIVERY,
  type QuestionReading,
} from "@renderer/store/session-events/question-reading.js";
import { QuestionCard } from "./QuestionCard.js";

const SHARED_QUESTION: QuestionReading = {
  questionId: "019b793b-7b60-7a21-9f14-6b0c2a7d0e11",
  runId: undefined,
  pageCount: 1,
};

const SHARED_PROMPT: QuestionPrompt = {
  text: "Which branch should this land on?",
  options: [],
  severalAnswers: false,
  secret: false,
};

function renderQuestionTwice(): HTMLElement {
  const { container } = render(
    <>
      {["first-pane", "second-pane"].map((pane) => (
        <QuestionCard
          key={pane}
          body={undefined}
          question={SHARED_QUESTION}
          questions={[SHARED_PROMPT]}
          delivery={UNSENT_ANSWER_DELIVERY}
          onAnswer={() => {
            // Dispatch is another suite's subject.
          }}
        />
      ))}
    </>,
  );
  return container;
}

function fieldsIn(container: HTMLElement): readonly HTMLTextAreaElement[] {
  return [...container.querySelectorAll("textarea")];
}

function labelsIn(container: HTMLElement): readonly HTMLLabelElement[] {
  return [...container.querySelectorAll("label")];
}

describe("TypedAnswerField — one field per card, whatever question it draws", () => {
  it("negative control: two cards for one question do not share a field id", () => {
    const container = renderQuestionTwice();

    const [firstField, secondField] = fieldsIn(container);

    expect(firstField?.id).not.toBe(secondField?.id);
  });

  it("gives each label its own field to activate", () => {
    const container = renderQuestionTwice();

    const [firstLabel, secondLabel] = labelsIn(container);
    const [firstField, secondField] = fieldsIn(container);

    expect(firstLabel?.htmlFor).toBe(firstField?.id);
    expect(secondLabel?.htmlFor).toBe(secondField?.id);
  });

  it("names a field at all, so the label is an association and not decoration", () => {
    const container = renderQuestionTwice();

    for (const field of fieldsIn(container)) {
      expect(field.id.length).toBeGreaterThan(0);
    }
  });
});

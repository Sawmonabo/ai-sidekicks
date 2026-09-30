// The free-text arm's DOM identity, and why two cards on one page may not share one.
//
// DRIVEN THROUGH THE CARD RATHER THAN THE ARM, because the subject is what a document
// holding two cards contains: one question can be drawn in two panes at once, and both
// cards are then in the same document. An arm rendered alone can never show that.
//
// AND THE ASSERTION IS THE LABEL ASSOCIATION, not the id string. What a shared id costs
// is exactly this: activating either label focuses the first matching field, so one
// user's answer is typed into another pane's field, and assistive technology can
// associate neither label unambiguously. The ids are read only to say what went wrong
// when the association fails.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

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

/** One question drawn twice in one document, as two panes hold it. */
function renderQuestionTwice(): HTMLElement {
  const { container } = render(
    <>
      {["first-pane", "second-pane"].map((pane) => (
        <QuestionCard
          key={pane}
          body={undefined}
          question={SHARED_QUESTION}
          delivery={UNSENT_ANSWER_DELIVERY}
          onAnswer={() => {
            // The dispatch is another suite's subject; this one is about identity.
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

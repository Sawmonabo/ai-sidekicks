// The free-text arm's DOM identity, and why two parallel runs may not share one.
//
// DRIVEN THROUGH THE CARD RATHER THAN THE ARM, because the subject is what a document
// holding two open asks contains: a provider mints its ask ids per provider session, so
// two runs blocked at once legitimately raise `ask-01` each, and both cards are on
// screen in the same ledger. An arm rendered alone can never show that.
//
// AND THE ASSERTION IS THE LABEL ASSOCIATION, not the id string. What a shared id costs
// is exactly this: activating either label focuses the first matching field, so one
// user's answer is typed into another run's question, and assistive technology
// can associate neither label unambiguously. The ids are read only to say what went
// wrong when the association fails.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ASK_ANSWER_UNSENT, INPUT_ASK_SLOT, type DriverAskReading } from "./input-ask.js";
import { InputAskCard } from "./InputAskCard.js";
import type { RunId } from "@ai-sidekicks/contracts";

/** The provider-minted id both runs legitimately raise. */
const SHARED_ASK_ID = "ask-01";

const FIRST_RUN_ID = "019b79ee-0280-740e-8110-d1a4c1150001" as RunId;
const SECOND_RUN_ID = "019b79ee-0280-740e-8110-d1a4c1150002" as RunId;

const NOW_MILLISECONDS = Date.UTC(2026, 8, 2, 10, 0, 0);

function askOn(runId: RunId): DriverAskReading {
  return {
    askId: SHARED_ASK_ID,
    runId,
    state: "requested",
    prompt: "Which branch should this land on?",
    options: [],
    expiresAt: undefined,
    deliveredAnswer: undefined,
  };
}

/** Both open asks in one document, exactly as one ledger window holds them. */
function renderBothAsks(): HTMLElement {
  const { container } = render(
    <>
      {[FIRST_RUN_ID, SECOND_RUN_ID].map((runId) => (
        <InputAskCard
          key={runId}
          slot={{ contract: INPUT_ASK_SLOT, body: undefined }}
          ask={askOn(runId)}
          nowEpochMilliseconds={NOW_MILLISECONDS}
          delivery={ASK_ANSWER_UNSENT}
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

describe("AskFreeTextArm — one field per ask, whatever the provider called it", () => {
  it("negative control: two runs sharing an ask id do not share a field id", () => {
    const container = renderBothAsks();

    const [firstField, secondField] = fieldsIn(container);

    expect(firstField?.id).not.toBe(secondField?.id);
  });

  it("gives each label its own field to activate", () => {
    const container = renderBothAsks();

    const [firstLabel, secondLabel] = labelsIn(container);
    const [firstField, secondField] = fieldsIn(container);

    expect(firstLabel?.htmlFor).toBe(firstField?.id);
    expect(secondLabel?.htmlFor).toBe(secondField?.id);
  });

  it("names a field at all, so the label is an association and not decoration", () => {
    const container = renderBothAsks();

    for (const field of fieldsIn(container)) {
      expect(field.id.length).toBeGreaterThan(0);
    }
  });
});

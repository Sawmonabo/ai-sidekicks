// What a selection MEANS, which is the one thing a rendered choice control cannot show.
//
// A select that offers the right options and reports the wrong value looks identical to
// one that reports the right value, so every case here reads what the control handed its
// caller rather than what it drew.
//
// THE FIELD COMES FROM THE MAPPER AND IS NEVER HAND-BUILT. An enumeration containing the
// empty string is the case this file exists for, and half of that case is that the mapper
// still classifies it as a drawn choice rather than sending the whole schema to the raw
// editor — a hand-written descriptor would assert the control's half while assuming the
// half that puts it on screen.

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SchemaChoiceField } from "./SchemaChoiceField.js";
import { type SchemaFieldDescriptor } from "../schema-fields.js";
import { planSchemaForm } from "../schema-form-plan.js";

afterEach(cleanup);

/** The descriptor the mapper draws for an enumeration over these members. */
function choiceFieldOver(choices: readonly string[]): SchemaFieldDescriptor {
  const plan = planSchemaForm({
    type: "object",
    properties: { severity: { type: "string", enum: [...choices], title: "Severity" } },
  });
  const entry = plan.shape === "fields" ? plan.entries[0] : undefined;
  if (entry?.form !== "field" || entry.field.kind !== "choice") {
    throw new Error("the mapper did not draw this enumeration as a choice control");
  }
  return entry.field;
}

/** Mount the control over one enumeration, reporting what it writes back. */
function renderChoice(
  choices: readonly string[],
  value: unknown,
): { readonly select: HTMLSelectElement; readonly onChange: ReturnType<typeof vi.fn> } {
  const onChange = vi.fn();
  const { container } = render(
    <SchemaChoiceField
      field={choiceFieldOver(choices)}
      value={value}
      onChange={onChange}
      controlId="severity-control"
      describedById={undefined}
    />,
  );
  const select = container.querySelector("select");
  if (select === null) {
    throw new Error("the choice control drew no select");
  }
  return { select, onChange };
}

/** The option offering one member, found by the text it shows rather than by its value. */
function optionShowing(select: HTMLSelectElement, member: string): HTMLOptionElement {
  const found = [...select.options].find((option) => option.textContent === member);
  if (found === undefined) {
    throw new Error(`no option shows the member ${JSON.stringify(member)}`);
  }
  return found;
}

describe("the enumerated choice control", () => {
  it("reports the member that was picked, including one the schema spells empty", () => {
    const { select, onChange } = renderChoice(["", "high"], undefined);

    fireEvent.change(select, { target: { value: optionShowing(select, "").value } });

    expect(onChange).toHaveBeenCalledWith("");
  });

  it("shows an answered empty string as that member rather than as no answer", () => {
    const { select } = renderChoice(["", "high"], "");

    // By position rather than by value: the empty member and the unanswered option are
    // the two the finding conflated, and only their positions tell them apart.
    expect(select.selectedIndex).toBe([...select.options].indexOf(optionShowing(select, "")));
  });

  it("writes no answer at all when the unanswered option is chosen back to", () => {
    const { select, onChange } = renderChoice(["low", "high"], "high");

    fireEvent.change(select, { target: { value: optionShowing(select, "Not answered").value } });

    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it("shows no answer for a held value that is not a member at all", () => {
    // A restored draft can hold anything; the schema's verdict is what reports it, and
    // the control's job is to not claim a member nobody picked.
    const { select } = renderChoice(["low", "high"], "retired");

    expect(select.selectedIndex).toBe(0);
  });
});

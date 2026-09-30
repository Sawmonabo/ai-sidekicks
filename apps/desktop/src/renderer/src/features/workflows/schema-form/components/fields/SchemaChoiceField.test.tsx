// What a selection means, which a rendered choice control cannot show: cases read what the
// control handed its caller. Fields come from the mapper, since an enumeration containing the
// empty string must still be classified as a drawn choice, which a hand-built descriptor
// would assume.

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SchemaChoiceField } from "./SchemaChoiceField.js";
import { answeredScalar, UNANSWERED_SCALAR } from "../../answer/schema-draft.js";
import { type SchemaFieldDescriptor } from "../../plan/schema-fields.js";
import { planSchemaForm } from "../../plan/schema-form-plan.js";

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

/** The descriptor the mapper draws for an optional yes-or-no, which this control also draws. */
function optionalBooleanField(): SchemaFieldDescriptor {
  const plan = planSchemaForm({
    type: "object",
    properties: { notify: { type: "boolean", title: "Notify" } },
  });
  const entry = plan.shape === "fields" ? plan.entries[0] : undefined;
  if (entry?.form !== "field" || entry.field.kind !== "checkbox") {
    throw new Error("the mapper did not draw this boolean as a field");
  }
  return entry.field;
}

/** Mount the control over one field, reporting what it writes back. */
function renderControl(
  field: SchemaFieldDescriptor,
  value: unknown,
): { readonly select: HTMLSelectElement; readonly onChange: ReturnType<typeof vi.fn> } {
  const onChange = vi.fn();
  const { container } = render(
    <SchemaChoiceField
      field={field}
      value={value}
      unreadableText=""
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

/** Mount the control over one enumeration, reporting what it writes back. */
function renderChoice(
  choices: readonly string[],
  value: unknown,
): { readonly select: HTMLSelectElement; readonly onChange: ReturnType<typeof vi.fn> } {
  return renderControl(choiceFieldOver(choices), value);
}

/** The option offering one member, found by the text it shows rather than its value. */
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

    expect(onChange).toHaveBeenCalledWith(answeredScalar(""));
  });

  it("shows an answered empty string as that member rather than as no answer", () => {
    const { select } = renderChoice(["", "high"], "");

    // By position: the empty member and the unanswered option differ only there.
    expect(select.selectedIndex).toBe([...select.options].indexOf(optionShowing(select, "")));
  });

  it("writes no answer at all when the unanswered option is chosen back to", () => {
    const { select, onChange } = renderChoice(["low", "high"], "high");

    fireEvent.change(select, { target: { value: optionShowing(select, "Not answered").value } });

    expect(onChange).toHaveBeenCalledWith(UNANSWERED_SCALAR);
  });

  it("reports a boolean rather than the word its option showed", () => {
    // The option text is what a person reads and the member value is what the answer carries;
    // writing "Yes" would put a string at a boolean member.
    const { select, onChange } = renderControl(optionalBooleanField(), undefined);

    fireEvent.change(select, { target: { value: optionShowing(select, "Yes").value } });

    expect(onChange).toHaveBeenCalledWith(answeredScalar(true));
  });

  it("shows a held no as the answer it is rather than as no answer", () => {
    const { select } = renderControl(optionalBooleanField(), false);

    expect(select.selectedIndex).toBe([...select.options].indexOf(optionShowing(select, "No")));
  });

  it("leaves an optional yes-or-no unanswered when it is chosen back to", () => {
    const { select, onChange } = renderControl(optionalBooleanField(), true);

    fireEvent.change(select, { target: { value: optionShowing(select, "Not answered").value } });

    expect(onChange).toHaveBeenCalledWith(UNANSWERED_SCALAR);
  });

  it("shows no answer for a held value that is not a member at all", () => {
    // A restored draft can hold anything; the control must not claim a member nobody picked.
    const { select } = renderChoice(["low", "high"], "retired");

    expect(select.selectedIndex).toBe(0);
  });
});

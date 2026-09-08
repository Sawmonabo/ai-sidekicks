// The mount two of this directory's suites drive their cases through.
//
// HOISTED ON THE SECOND SUITE, not written twice. `SchemaForm.test.tsx` owns the form as
// a whole and `SchemaFieldList.test.tsx` owns the collection surface, and both need the
// same thing: one schema, mounted through the real hook, with the composed answer and the
// real report readable beside the markup. A second copy of that mount would have been two
// answers to what a form under test IS.

import { fireEvent, render, screen, within } from "@testing-library/react";

import { ACTIVATE_LABEL } from "./SchemaActivationControl.js";
import { SchemaForm } from "./SchemaForm.js";
import { useSchemaForm } from "./use-schema-form.js";

/** Where the host below writes the answer the controls composed, for a case to read. */
const COMPOSED_ANSWER_CLASS = "composed-answer";

/** Where the host writes what the schema actually said, so a case can walk the report. */
const REPORTED_ISSUES_CLASS = "reported-issues";

/**
 * The form, mounted over one schema through its own hook.
 *
 * It writes the composed answer out beside the controls, because the value a submission
 * would carry is the only thing that settles what a control MEANT: a select that looks
 * right and reports `undefined` renders identically to one that reports a member.
 *
 * And it writes the report's own sentences out for the same reason one level up: whether
 * a finding reached a person is a question about the report and the DOM together, and a
 * case that listed the expected sentences by hand would pass over a report that had grown
 * a fourth one nothing drew.
 */
export function SchemaFormHost(props: { readonly inputSchema: unknown }): React.JSX.Element {
  const form = useSchemaForm(props.inputSchema);
  return (
    <>
      <SchemaForm form={form} />
      <output className={COMPOSED_ANSWER_CLASS}>{JSON.stringify(form.answer)}</output>
      <output className={REPORTED_ISSUES_CLASS}>
        {JSON.stringify((form.report?.issues ?? []).map((issue) => issue.message))}
      </output>
    </>
  );
}

/** Render one schema's form and hand back the container it drew into. */
export function renderForm(inputSchema: unknown): HTMLElement {
  const { container } = render(<SchemaFormHost inputSchema={inputSchema} />);
  return container;
}

/** The answer the drawn controls have composed so far, read back as a value. */
export function composedAnswer(container: HTMLElement): unknown {
  return JSON.parse(container.querySelector(`.${COMPOSED_ANSWER_CLASS}`)?.textContent ?? "null");
}

/** Every sentence the schema reported about this answer, read off the real report. */
export function reportedIssueTexts(container: HTMLElement): readonly string[] {
  return JSON.parse(
    container.querySelector(`.${REPORTED_ISSUES_CLASS}`)?.textContent ?? "[]",
  ) as readonly string[];
}

/** Every sentence the form actually drew, wherever on the form it drew it. */
export function renderedIssueTexts(container: HTMLElement): readonly string[] {
  return [...container.querySelectorAll(".meridian-schema-field__issues li")].map(
    (entry) => entry.textContent ?? "",
  );
}

/** The findings block the form drew about the whole answer, rather than about a member. */
export function rootIssuesElement(container: HTMLElement): Element | null {
  return container.querySelector(".meridian-schema-form > .meridian-schema-field__issues");
}

/**
 * The fieldset one collection drew, which is what a case scopes a query to.
 *
 * Scoped rather than global, because the control that answers an optional container reads
 * the same on a collection's legend as on a group's — one component draws both — so a
 * form holding either beside the other offers two buttons of that name and a global query
 * would press whichever came first.
 */
export function listFieldset(container: HTMLElement): HTMLElement {
  const fieldset = container.querySelector(".meridian-schema-list");
  if (!(fieldset instanceof HTMLElement)) {
    throw new Error("this form drew no collection");
  }
  return fieldset;
}

/**
 * Answer every optional collection this form drew.
 *
 * What a case ABOUT ENTRIES needs before there are any: an optional collection opens
 * unanswered and draws no entry controls at all, so a case about how a row is named or
 * where its finding lands has to say it is answering the collection first. Pressed through
 * the real control under its real label rather than by reaching into the draft, because
 * the control is the only way a person reaches that state.
 */
export function answerEveryCollection(container: HTMLElement): void {
  for (const fieldset of container.querySelectorAll(".meridian-schema-list")) {
    if (!(fieldset instanceof HTMLElement)) {
      continue;
    }
    const control = within(fieldset).queryByRole("button", { name: ACTIVATE_LABEL });
    if (control !== null) {
      fireEvent.click(control);
    }
  }
}

/**
 * Press the control that adds one entry to the named collection.
 *
 * Named rather than "the only list", because the add control's accessible name carries
 * its collection now: a helper that reached for a fixed one would be a helper that only
 * works on forms with one list, which is the shape the name exists to distinguish.
 */
export function addListEntry(collectionLabel: string): void {
  fireEvent.click(screen.getByRole("button", { name: `Add an entry to ${collectionLabel}` }));
}

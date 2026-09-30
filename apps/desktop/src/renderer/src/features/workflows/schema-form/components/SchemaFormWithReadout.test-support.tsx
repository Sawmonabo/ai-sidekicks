// The mount every whole-form suite in this directory runs its cases through: one schema
// through the real hook, with the composed answer and the real report readable beside it.

import { fireEvent, render, screen, within } from "@testing-library/react";

import { ACTIVATE_LABEL } from "./SchemaActivationControl.js";
import { SchemaForm } from "./SchemaForm.js";
import { resolveSchemaValidatorCompiler } from "../hooks/useSchemaForm.test-support.js";
import { settle } from "@test/helpers/settle.js";
import { useSchemaForm } from "../hooks/useSchemaForm.js";

/** Where the form writes the answer the controls composed. */
const COMPOSED_ANSWER_CLASS = "composed-answer";

/** Where the form writes the report's sentences. */
const REPORTED_ISSUES_CLASS = "reported-issues";

/**
 * The form mounted over one schema through its own hook. It writes out the composed answer
 * (only that settles what a control meant) and the report's sentences, so a case can find a
 * finding nothing drew.
 */
export function SchemaFormWithReadout(props: { readonly inputSchema: unknown }): React.JSX.Element {
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

/**
 * Render one schema's form and wait for its compiler chunk, so the container holds a verdict.
 * The wait is `resolveSchemaValidatorCompiler`'s: a bare `settle` races the first `import()`
 * (`useSchemaForm.test-support.tsx`). The window before the verdict is
 * `useSchemaForm.compiler.test.tsx`'s subject.
 */
export async function renderForm(inputSchema: unknown): Promise<HTMLElement> {
  await resolveSchemaValidatorCompiler();
  const { container } = render(<SchemaFormWithReadout inputSchema={inputSchema} />);
  await settle();
  return container;
}

/** The answer the drawn controls have composed so far. */
export function composedAnswer(container: HTMLElement): unknown {
  return JSON.parse(container.querySelector(`.${COMPOSED_ANSWER_CLASS}`)?.textContent ?? "null");
}

/** Every sentence the schema reported about this answer. */
export function reportedIssueTexts(container: HTMLElement): readonly string[] {
  return JSON.parse(
    container.querySelector(`.${REPORTED_ISSUES_CLASS}`)?.textContent ?? "[]",
  ) as readonly string[];
}

/** Every sentence the form drew, wherever it drew it. */
export function renderedIssueTexts(container: HTMLElement): readonly string[] {
  return [...container.querySelectorAll(".meridian-schema-field__issues li")].map(
    (entry) => entry.textContent ?? "",
  );
}

/** The findings block about the whole answer, rather than about a member. */
export function rootIssuesElement(container: HTMLElement): Element | null {
  return container.querySelector(".meridian-schema-form > .meridian-schema-field__issues");
}

/**
 * The fieldset one collection drew, to scope queries: the activation button reads the same
 * on a list's legend as on a group's, so a global query would press whichever came first.
 */
export function listFieldset(container: HTMLElement): HTMLElement {
  const fieldset = container.querySelector(".meridian-schema-list");
  if (!(fieldset instanceof HTMLElement)) {
    throw new Error("this form drew no collection");
  }
  return fieldset;
}

/**
 * Answer every optional collection this form drew, through the real control. An optional
 * collection opens unanswered and draws no entry controls until then.
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

/** Press the add control of the named collection; its accessible name carries the label. */
export function addListEntry(collectionLabel: string): void {
  fireEvent.click(screen.getByRole("button", { name: `Add an entry to ${collectionLabel}` }));
}

// The mount the whole-form cases run through: one schema through the real hook, with the composed
// answer readable beside it.

import { render } from "@testing-library/react";

import { SchemaForm } from "./SchemaForm.js";
import { loadSchemaValidatorCompiler } from "../json-schema-validator-loader.js";
import { settle } from "@test/helpers/settle.js";
import { useSchemaForm } from "../hooks/useSchemaForm.js";

/** Where the form writes the answer the controls composed. */
const COMPOSED_ANSWER_CLASS = "composed-answer";

/**
 * Render one schema's form and wait for its compiler chunk, so the container holds a verdict.
 * The compiler is loaded first because a bare `settle` races the first `import()`.
 */
export async function renderForm(inputSchema: unknown): Promise<HTMLElement> {
  await loadSchemaValidatorCompiler();
  const { container } = render(<SchemaFormWithReadout inputSchema={inputSchema} />);
  await settle();
  return container;
}

/** The answer the drawn controls have composed so far. */
export function composedAnswer(container: HTMLElement): unknown {
  return JSON.parse(container.querySelector(`.${COMPOSED_ANSWER_CLASS}`)?.textContent ?? "null");
}

/**
 * The form mounted over one schema through its own hook. It writes out the composed answer, since
 * only that settles what a control meant.
 */
function SchemaFormWithReadout(props: { readonly inputSchema: unknown }): React.JSX.Element {
  const form = useSchemaForm(props.inputSchema);
  return (
    <>
      <SchemaForm form={form} />
      <output className={COMPOSED_ANSWER_CLASS}>{JSON.stringify(form.answer)}</output>
    </>
  );
}

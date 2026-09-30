// The mount every case over the hook drives: the hook in a component that renders nothing,
// with a live handle on its latest state (a new object each render, so a captured snapshot
// goes stale). `mountForm` waits for the compiler chunk itself, never a turn count: a bare
// `settle` races the first `import()` in a file's module registry, so that file's first
// case would read a form with no verdict.

import { render } from "@testing-library/react";

import { answeredScalar, UNANSWERED_SCALAR } from "../answer/schema-draft.js";
import { settle } from "@test/helpers/settle.js";
import { useSchemaForm, type SchemaFormState } from "./useSchemaForm.js";
import { schemaFormAnswerBody } from "../schema-form-mounts.js";
import { loadSchemaValidatorCompiler } from "../json-schema-validator-loader.js";
import { type SchemaMemberPath } from "../schema-member-path.js";

/**
 * Resolve the schema compiler's chunk, so a form mounted after this opens in one step. The
 * one copy of that wait for every mount that needs it, at the lowest module that owns the
 * concern; the registry memoizes, so a later caller awaits a settled promise.
 */
export async function resolveSchemaValidatorCompiler(): Promise<void> {
  await loadSchemaValidatorCompiler();
}

/**
 * Resolve both chunks the form loads, so a form mounted after this opens armed: the compiler
 * and the kit's answer body. Warming only one either suspends on the body or leaves the submit
 * act disabled while the validator reads `compiling`, so a case that warms only the kit races
 * the compiler and fails intermittently. The answer mount is loaded, not the bare chunk,
 * because the loader-backed body holds a second memo.
 */
export async function resolveSchemaFormChunks(): Promise<void> {
  await resolveSchemaValidatorCompiler();
  await schemaFormAnswerBody.load();
}

/** Mount the hook, let its compiler land, and hand back a live handle on its state. */
export async function mountForm(inputSchema: unknown): Promise<() => SchemaFormState> {
  // Warmed before the mount so the hook's own load resolves off the registry.
  await resolveSchemaValidatorCompiler();
  let latest: SchemaFormState | undefined;
  function Probe(props: { readonly inputSchema: unknown }): React.JSX.Element {
    latest = useSchemaForm(props.inputSchema);
    return <div />;
  }
  render(<Probe inputSchema={inputSchema} />);
  await settle();
  return () => {
    if (latest === undefined) {
      throw new Error("the hook never rendered");
    }
    return latest;
  };
}

/** What one drawn control is displaying at a member. */
export function memberValueOf(form: SchemaFormState, memberPath: SchemaMemberPath): unknown {
  return form.memberView(memberPath).value;
}

/** What every row of one collection is displaying, in the order the rows are drawn. */
export function listValuesOf(
  form: SchemaFormState,
  memberPath: SchemaMemberPath,
): readonly unknown[] {
  return form.listEntries(memberPath).map((entry) => entry.value);
}

/** Answer one member through the real draft constructors, or take the answer back on nothing. */
export function answerMember(
  form: SchemaFormState,
  memberPath: SchemaMemberPath,
  value: unknown,
): void {
  form.setMemberDraft(memberPath, value === undefined ? UNANSWERED_SCALAR : answeredScalar(value));
}

/** Answer one row of a collection, addressed by where that row is drawn. */
export function answerListEntry(
  form: SchemaFormState,
  memberPath: SchemaMemberPath,
  index: number,
  value: unknown,
): void {
  form.setListEntryDraft(
    memberPath,
    index,
    value === undefined ? UNANSWERED_SCALAR : answeredScalar(value),
  );
}

/** A schema whose members exercise a nested write and a list. */
export const NESTED_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    release: { type: "object", properties: { tag: { type: "string" } }, required: ["tag"] },
    reviewers: { type: "array", items: { type: "string" } },
  },
  required: ["title"],
} as const;

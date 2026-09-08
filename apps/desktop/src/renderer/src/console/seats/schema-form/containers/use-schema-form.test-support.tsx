// The mount every case over this hook drives, and the one schema both halves of the suite
// need.
//
// HOISTED ON THE SPLIT AND NOT WRITTEN TWICE. The suite over this hook grew past what one
// file should hold and became two — the state a form holds and what a form OPENS holding —
// and both need the same probe: the hook mounted in a component that renders nothing, with
// a live handle on its latest state. A second copy of that would have been two answers to
// what "the form under test" is, and they would drift the first time either grew a wrapper.
//
// A HANDLE RATHER THAN A SNAPSHOT, because the state is a new object on every render: a
// case that captured one and read it after an `act` would be reading the form as it was
// before the edit it just made.

import { render } from "@testing-library/react";

import { answeredScalar, UNANSWERED_SCALAR } from "../answer/schema-draft.js";
import { useSchemaForm, type SchemaFormState } from "./use-schema-form.js";
import type { SchemaMemberPath } from "../../../bridge/index.js";

/** Mount the hook and hand back a live handle on its latest state. */
export function mountForm(inputSchema: unknown): () => SchemaFormState {
  let latest: SchemaFormState | undefined;
  function Probe(): React.JSX.Element {
    latest = useSchemaForm(inputSchema);
    return <div />;
  }
  render(<Probe />);
  return () => {
    if (latest === undefined) {
      throw new Error("the hook never rendered");
    }
    return latest;
  };
}

/**
 * What one drawn control is displaying, which is the reading a case makes about a member.
 *
 * A case asks about a VALUE and the hook answers with a control view — the value beside
 * the text a control could not read — so this takes the half every case here is about.
 * Written once beside the mount for the reason the mount is: two suites read it.
 */
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

/**
 * Answer one member with a value, or take the answer back where the value is nothing.
 *
 * The draft node a control would report, composed through the real constructors rather
 * than as an object literal: a case writing its own node would be a second reading of
 * what "answered" means, and the first one to drift would drift silently.
 */
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

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

import { useSchemaForm, type SchemaFormState } from "./use-schema-form.js";

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

// The schema form mount: how a tier mounts one and reads whether it is ready.
//
// The form loads two chunks: its own kit (`schemaFormChunk`) and the schema compiler, which its
// hook fetches on mount. Until the compiler settles the form carries `aria-busy` and has no
// verdict, so a tier that audited it early would report on a form nobody can answer. The wait is
// on that state, never on a count of turns: a memoized promise still resolves on a later
// microtask (`run-graph-settled.ts` gives the general reason).
//
// Readiness is the absence of `aria-busy` on the form itself. The selector is scoped to the form
// and matches the attribute's presence, not its value, so a stray `aria-busy="false"` elsewhere
// is not read as busy. A form carrying `aria-busy="false"` keeps the caller waiting to the
// deadline, which fails loudly, instead of returning a form that is still compiling.

import { waitFor } from "@testing-library/react";

import { renderSettled } from "../app-harness.js";
import { schemaFormChunk } from "@renderer/features/workflows/schema-form/schema-form-mounts.js";
import { resolveSchemaFormChunks } from "@renderer/features/workflows/schema-form/hooks/useSchemaForm.test-support.js";

/**
 * How long a verdict may take before the mount throws. It bounds a hang; on an idle host the
 * compile lands within a turn or two. Throwing keeps a tier from reporting clean over a form
 * that never got its verdict.
 */
const SCHEMA_FORM_VERDICT_DEADLINE_MS = 5_000;

/**
 * The class the schema form puts on its own `<form>`.
 *
 * A literal because the form exports no class names. A caller asks for presence first and busy
 * second, so a rename fails the mount by name instead of satisfying the wait at once.
 */
const SCHEMA_FORM_SELECTOR = "form.meridian-schema-answer";

/** What a caller mounts: the phase's question and the schema its answer is shaped by. */
export interface SchemaFormMounting {
  readonly prompt: string;
  readonly inputSchema: unknown;
}

/** Whether this region holds a schema answer form at all. */
function holdsSchemaForm(region: ParentNode): boolean {
  return region.querySelector(SCHEMA_FORM_SELECTOR) !== null;
}

/**
 * Whether this region holds a schema form that has not got its verdict yet.
 *
 * Ask it second: with no form in the region it is false, so a renamed class would pass silently.
 */
function schemaFormIsAwaitingCompiler(region: ParentNode): boolean {
  return region.querySelector(`${SCHEMA_FORM_SELECTOR}[aria-busy]`) !== null;
}

/**
 * Whether this form has stopped waiting for its compiler.
 *
 * Derived from the two predicates above so the class name and the busy rule stay in one place.
 */
export function isSchemaFormSettled(region: ParentNode): boolean {
  return holdsSchemaForm(region) && !schemaFormIsAwaitingCompiler(region);
}

/**
 * Mount one schema form and return its container once the verdict has landed.
 *
 * `onSubmit` is a no-op: no tier asserts on the send, and a mount that took one would invite a
 * case to assert on a callback instead of on what the form drew.
 */
export async function mountSettledSchemaForm(mounting: SchemaFormMounting): Promise<HTMLElement> {
  await resolveSchemaFormChunks();
  const { SchemaFormAnswer } = await schemaFormChunk.load();
  const { container } = await renderSettled(
    <SchemaFormAnswer
      prompt={mounting.prompt}
      inputSchema={mounting.inputSchema}
      onSubmit={() => undefined}
    />,
  );
  await waitFor(
    () => {
      if (!isSchemaFormSettled(container)) {
        throw new Error("the schema form is still waiting for its compiler");
      }
    },
    { timeout: SCHEMA_FORM_VERDICT_DEADLINE_MS },
  );
  return container;
}

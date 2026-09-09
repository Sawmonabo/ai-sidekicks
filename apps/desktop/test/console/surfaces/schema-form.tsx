// The schema form, mounted with the verdict it is answered under already in hand.
//
// Not a test file — no `include` glob reaches it as one. It lives beside the family
// mounts because that is what it is: a composition two tiers read, mounted once. The
// form is a SEAT rather than a view family, which is why it has no registrar here and
// is composed as a component — `composer.tsx` beside it is the same shape.
//
// TWO CHUNKS ARRIVE BEFORE THIS FORM IS THE FORM A PERSON ANSWERS, and only one of
// them had a wait. `schemaFormChunk` is the seat's own kit — the two composed surfaces
// and their sheet — and the schema COMPILER is a second chunk the form's own hook
// fetches when it mounts. A mount that resolved the kit and then settled once audited a
// form still reading `compiling`: `aria-busy` set, the one act closed, and NO verdict,
// which on the raw arm means no findings and no `aria-invalid` on the editor. That is a
// different composition from the one either tier says it is looking at.
//
// AND THE WAIT IS ON A STATE, NEVER ON A COUNT OF TURNS. `phase-graph-settled.ts` states
// the general reason and this surface supplies a sharper one: the compiler's door is not
// memoised — `loadSchemaValidatorCompiler` runs a fresh `import()` per call and hands
// back a fresh promise — so resolving the module registry ahead of the mount makes the
// hook's own load CHEAP and does not make it synchronous. Under browser mode that
// resolution has landed after `renderSettled`'s single macrotask boundary on every
// measurement taken here, which is why warming alone left both cases exactly as red as
// they were before it. What is waited for is the form's own answer to "do I have a
// verdict yet", which it already publishes for a screen reader.
//
// THE MARKER IS THE FORM'S, NOT THIS MODULE'S. `SchemaFormAnswer` carries `aria-busy`
// while its validator reads `compiling` and drops it on every settlement — a verdict, a
// schema that would not compile, or a compiler that never arrived. All three are states
// a tier may audit and none of them is a wait, so the readiness rule is the absence of
// that attribute rather than the presence of any one arm.

import { waitFor } from "@testing-library/react";

import { renderSettled } from "../console-harness.js";
import { schemaFormChunk } from "../../../src/renderer/src/console/seats/index.js";
// The seat's own wait for the compiler chunk, taken from the module that owns it rather
// than restated: `loadSchemaValidatorCompiler` has one home for this job, and the three
// console-unit supports already take it from there.
import { resolveSchemaValidatorCompiler } from "../../../src/renderer/src/console/seats/schema-form/containers/use-schema-form.test-support.js";

/**
 * How long a verdict may take before the mount is refused rather than returned.
 *
 * A ceiling on a hang, not a wait anybody expects to spend — the compile lands within a
 * turn or two of the mount on an idle host. It THROWS rather than returning, on
 * `phase-graph-settled.ts`'s reasoning: a tier that audited a form which never got its
 * verdict reports clean over the surface it was written to cover.
 */
const VERDICT_DEADLINE_MS = 5_000;

/** What a caller mounts: the phase's question and the schema its answer is shaped by. */
export interface SchemaFormMounting {
  readonly prompt: string;
  readonly inputSchema: unknown;
}

/**
 * Whether this form has stopped waiting for the thing that checks it.
 *
 * Exported beside the mount for the reason `isPhaseGraphSettled` is: a case that wants to
 * state the readiness it depends on before it measures anything can read it, and the
 * reading is one rule rather than one per tier.
 */
export function isSchemaFormSettled(surface: HTMLElement): boolean {
  const form = surface.querySelector<HTMLElement>(".meridian-schema-answer");
  return form !== null && form.getAttribute("aria-busy") === null;
}

/**
 * Mount one schema form and hand back its container once the verdict has landed.
 *
 * `onSubmit` is a no-op and deliberately not a caller's: no tier reading this surface
 * asserts on the send, and a mount that took one would invite a case to press the act
 * and then assert on a callback rather than on what the form drew.
 */
export async function mountSettledSchemaForm(mounting: SchemaFormMounting): Promise<HTMLElement> {
  await resolveSchemaValidatorCompiler();
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
    { timeout: VERDICT_DEADLINE_MS },
  );
  return container;
}

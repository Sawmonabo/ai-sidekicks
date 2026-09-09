// The schema form: how a tier mounts one, and how anything reads whether it is ready.
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
// the general reason and this surface supplies a sharper one: the compiler's door is
// memoised (`SchemaValidatorCompilerChunk` holds one module promise per renderer), and a
// memoised promise is still a promise — the hook's own `then` lands on a later microtask
// and installs the verdict through a state update, so resolving the compiler ahead of the
// mount makes the hook's load CHEAP and does not make it synchronous. Before the memo
// landed, that resolution reached the tree after `renderSettled`'s single macrotask
// boundary on every measurement taken here, which is why warming alone left both cases
// exactly as red as they were before it. What is waited for is the form's own answer to
// "do I have a verdict yet", which it already publishes for a screen reader.
//
// THE MARKER IS THE FORM'S, NOT THIS MODULE'S. `SchemaFormAnswer` carries `aria-busy`
// while its validator reads `compiling` and drops it on every settlement — a verdict, a
// schema that would not compile, or a compiler that never arrived. All three are states
// a tier may audit and none of them is a wait, so readiness is the absence of that
// attribute rather than the presence of any one arm.
//
// ONE HOME FOR THAT READING, WHICH IS WHY IT IS HERE AND NOT AT THE TIER ROOT. Two lanes
// reached the same question from opposite ends — a mount that had to wait for the
// verdict, and a family mount that had to wait for the compiler — and for a moment
// answered it in two modules. `apps/desktop/AGENTS.md` §Shared code settles which one
// survives: one implementation per job, hoisted on the second use. It is this file
// rather than the tier root because the subject is the `seats/schema-form` seat that two
// tiers and three mounts read, and because the tier root is typechecked WITHOUT the DOM
// lib — `tsconfig.test.json` includes `test/**/*` under Node options and resolves
// `ParentNode` for nothing there, while `test/console/surfaces/**` is in the browser
// program beside the mounts that drive it.
//
// THE DEFECT THE SCOPE REPLACED, since the reading arrived carrying one. The workflows
// family's parked-run mount waited on `region.querySelector("[aria-busy]")` — unscoped —
// and called a match "the compiler has not arrived yet". React renders an ARIA attribute
// as a STRING, so any control rendered with `aria-busy={false}` is the literal
// `aria-busy="false"` in the document and that selector matched it. Nothing in that pane
// draws one today, which is what makes it worth naming: the read was true by coincidence
// rather than by rule, and the first control the pane grows with a busy state it is not
// currently in would have hung the mount until it timed out, under a message naming a
// compiler that had landed long before.
//
// AND THE BUSY READING MATCHES THE ATTRIBUTE'S PRESENCE RATHER THAN ITS VALUE, once
// scoped to the form. `SchemaFormAnswer.tsx` renders `aria-busy={isAwaitingVerdict ?
// true : undefined}`, so on every shape this seat produces the two rules agree: the
// attribute reads `"true"` or it is not there at all, which is the pair
// `use-schema-form.compiler.test.tsx` pins. They disagree on one shape it does not
// produce — a form carrying `aria-busy="false"` — and the disagreement is not
// symmetric. Presence keeps a caller waiting to its deadline, which fails loudly; a
// value match returns, and the tier above then audits or photographs a form that is
// still compiling and reports clean. So the reading fails closed on the one shape
// neither rule has evidence for.

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

/**
 * The class the seat puts on its own `<form>`, read here and set there.
 *
 * A LITERAL rather than an import: the seat does not export its class names for a test,
 * so the alternative is not a shared constant but a production export minted for a wait.
 * What keeps the literal honest is the order a caller asks in — presence first, busy
 * second — so a rename fails a mount by name instead of turning its wait into a
 * condition satisfied the instant it is asked.
 */
const SCHEMA_FORM_SELECTOR = "form.meridian-schema-answer";

/** What a caller mounts: the phase's question and the schema its answer is shaped by. */
export interface SchemaFormMounting {
  readonly prompt: string;
  readonly inputSchema: unknown;
}

/** Whether this region holds the seat's own answer form at all. */
export function holdsSchemaForm(region: ParentNode): boolean {
  return region.querySelector(SCHEMA_FORM_SELECTOR) !== null;
}

/**
 * Whether this region holds a schema form that has not got its verdict yet.
 *
 * Asked SECOND, always: a busy reading alone is satisfied by a region holding no form at
 * all, which is what a renamed class silently produces, so a caller states the form is
 * there before it asks anything about its state.
 */
export function schemaFormIsAwaitingCompiler(region: ParentNode): boolean {
  return region.querySelector(`${SCHEMA_FORM_SELECTOR}[aria-busy]`) !== null;
}

/**
 * Whether this form has stopped waiting for the thing that checks it.
 *
 * Exported beside the mount for the reason `isPhaseGraphSettled` is: a case that wants
 * to state the readiness it depends on before it measures anything can read it, and the
 * reading is one rule rather than one per tier. DERIVED from the two predicates above
 * rather than restating their selector — a third copy of the class name is a third thing
 * a rename has to find, and a settled rule that drifted from the busy rule would leave a
 * region that is neither.
 */
export function isSchemaFormSettled(region: ParentNode): boolean {
  return holdsSchemaForm(region) && !schemaFormIsAwaitingCompiler(region);
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

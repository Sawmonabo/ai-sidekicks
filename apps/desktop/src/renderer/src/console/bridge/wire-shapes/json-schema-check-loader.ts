// The schema compiler as the door publishes it: the same call, with the module that
// performs it fetched first.
//
// WHY THIS MODULE EXISTS AT ALL. The bridge door is on the console's initial import graph
// — the renderer root reaches it — so every value the door names is charged to every
// launch. `compileSchemaValidator`'s only production readers are inside
// `seats/schema-form/`, which is a loader-backed chunk of its own, and behind the compiler
// stands the schema library's JSON-Schema entry point and everything it pulls in. A door
// line for the compiler therefore did exactly what `apps/desktop/AGENTS.md` §Module shape
// warns a door line for a lazily-read body does: a symbol reachable both statically and
// dynamically is assigned to the STATIC chunk, so the validator rode the document of every
// session that never draws a form, against the `renderer-initial-bundle` budget
// `Spec-023 §Console Design (Meridian)` sets.
//
// SO THE DOOR NAMES THIS, AND THIS NAMES THE WORK THROUGH `import()`. What stays on the
// graph is one function body and a type reference that erases; the compiler and its
// library are emitted as their own chunk and fetched the first time a schema form mounts.
// `workflow-definition-file-codec.ts` beside it is the same move for the definition file's
// two sides, and the two are deliberately separate modules: they defer different
// sub-graphs, for different surfaces, and one wrapper naming both would fetch the parser
// for a form and the schema reader for an export.
//
// AND THE DEFERRAL IS HERE RATHER THAN IN THE CALLER. A view family — and the seat kit
// above this one — may not reach past this family's door, which
// `console-cross-family-deep-import` closes, so the form cannot `import()` the validator
// module itself. The wrapper belongs on this side of the door, which is also where the
// reason for it is legible: the door's own eagerness is what has to be paid for.
//
// THE ADDRESSING IS NOT DEFERRED WITH IT. `schema-member-path.ts` carries no schema
// library and is read by six modules of that same seat on their first render, so it stays
// an ordinary eager door line; deferring it would have bought nothing and made a control's
// React key wait on a chunk.
//
// NO MEMO IS KEPT BESIDE IT, for `workflow-definition-file-codec.ts`'s reason: the module
// map is already the memo, and a second cache here would be a class written for a caller
// that has none. WHAT a compiled validator's lifetime is stays the caller's — one per
// schema per mount, held by `use-schema-form.ts`, which is where the schema identity that
// keys it lives.
//
// THE ONLY WAY THIS REJECTS is a chunk that did not load, which is a fact about the
// install rather than about the schema — so it travels as a rejection to the caller's own
// seam rather than as a sentence about a definition that is fine.

import type { SchemaValidator } from "./json-schema-check.js";

/**
 * Fetch the schema compiler, and hand back the compiler itself.
 *
 * The FUNCTION and not a compiled validator, because compiling is synchronous once the
 * module is here and the schema is the caller's: a wrapper taking the schema would put one
 * `import()` on the door per compile and would hide, from the one module that has to know
 * it, when the compile actually happened.
 */
export async function loadSchemaValidatorCompiler(): Promise<
  (inputSchema: unknown) => SchemaValidator
> {
  const { compileSchemaValidator } = await import("./json-schema-check.js");
  return compileSchemaValidator;
}

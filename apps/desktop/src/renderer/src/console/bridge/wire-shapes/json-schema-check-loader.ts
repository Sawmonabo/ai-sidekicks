// The schema compiler as the door publishes it: the same call, with the module that
// performs it fetched first.
//
// WHY THIS MODULE EXISTS AT ALL. The bridge door is on the console's initial import graph
// — the renderer root reaches it — so every value the door names is charged to every
// launch. `compileSchemaValidator`'s only production readers are inside
// `seats/schema-form/`, which is a loader-backed chunk of its own, and behind the compiler
// stands the schema library's JSON-Schema entry point and everything it pulls in. A door
// line for the compiler therefore did exactly what this package's module rules warn
// a door line for a lazily-read body does: a symbol reachable both statically and
// dynamically is assigned to the STATIC chunk, so the validator rode the document of every
// session that never draws a form, against the `renderer-initial-bundle` budget
// the console's design language sets.
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
// THE PROMISE IS MEMOISED, AND "THE MODULE MAP IS ALREADY THE MEMO" IS WHY IT HAD TO BE.
// This module carried that sentence, borrowed from `workflow-definition-file-codec.ts`,
// and it is true about the MODULE and false about the wait: an `import()` of a module the
// map already holds still hands back a FRESH promise that settles on a later turn, and the
// caller here is a hook that starts its load inside a mount. Every consumer therefore paid
// a turn per call that no amount of warming could remove, and three of them were measured
// paying it — the accessibility tier audited a form whose validator still read `compiling`
// (no verdict, so no findings and no `aria-invalid` on the raw arm), and three console-unit
// supports raced their file's first `import()` on its first mount. One held promise is what
// makes a second call synchronous-to-settle rather than merely cheap.
//
// A CLASS WITH A PRIVATE FIELD, never a module-level `let`, on this package's state
// rules, and `SchemaFormChunk` is the same shape one family up for the same
// job. The instance below is this renderer's; a test builds its own, which is what keeps
// the memo out of the shared state a module-level promise would be.
//
// WHAT A COMPILED VALIDATOR'S LIFETIME IS STAYS THE CALLER'S — one per schema per mount,
// held by `use-schema-form.ts`, where the schema identity that keys it lives. This memo is
// about the CHUNK and says nothing about a compile.
//
// THE ONLY WAY THIS REJECTS is a chunk that did not load, which is a fact about the
// install rather than about the schema — so it travels as a rejection rather than as a
// sentence about a definition that is fine, and the memo is DROPPED on that arm so a later
// call reaches a live loader rather than a cached failure. WHERE IT SETTLES is named,
// because a rejection with no named consumer is one nobody attaches to:
// `seats/schema-form/containers/use-schema-form.ts` takes it on the rejecting arm of the
// one `then` it puts here, inside its own compile round, and turns it into that hook's
// `checker-unavailable` validator arm — which opens the raw editor and arms the act. That
// arm is a settlement rather than a retry, so nothing re-asks until a schema moves or a
// form is opened again; dropping the memo is what makes those two reach a live fetch.
// Nothing about the failure reaches a person from HERE; what a fetch raises is about the
// transport, and the sentence somebody reads is the arm's.

import type { SchemaValidator } from "./json-schema-check.js";

/**
 * What the door hands back: the compiler, not a compiled validator.
 *
 * The FUNCTION, because compiling is synchronous once the module is here and the schema is
 * the caller's: a wrapper taking the schema would put one `import()` on the door per
 * compile and would hide, from the one module that has to know it, when the compile
 * actually happened.
 */
export type SchemaValidatorCompiler = (inputSchema: unknown) => SchemaValidator;

/**
 * How the chunk is reached. Injected so the failing arm is reachable from a test at all.
 *
 * `SchemaFormChunk` beside this one takes no seam and its rejection path is asserted by
 * nothing as a result — a memo that quietly cached a failure would pass every case that
 * module has. The default is the real `import()` and no caller passes anything else, so
 * the seam costs one parameter and buys the one case that matters.
 */
export type SchemaValidatorCompilerFetch = () => Promise<SchemaValidatorCompiler>;

/** The compiler's chunk, fetched once per instance however many forms ask. */
export class SchemaValidatorCompilerChunk {
  readonly #fetchCompiler: SchemaValidatorCompilerFetch;
  #compilerPromise: Promise<SchemaValidatorCompiler> | undefined;

  public constructor(fetchCompiler: SchemaValidatorCompilerFetch = importSchemaValidatorCompiler) {
    this.#fetchCompiler = fetchCompiler;
  }

  /**
   * The compiler, fetched once. Every later call gets the SAME promise, which is the
   * property a caller inside a render round depends on — see the header.
   */
  public load(): Promise<SchemaValidatorCompiler> {
    this.#compilerPromise ??= this.#loadOnce();
    return this.#compilerPromise;
  }

  async #loadOnce(): Promise<SchemaValidatorCompiler> {
    try {
      return await this.#fetchCompiler();
    } catch (loadError) {
      // A chunk that did not arrive is not a chunk that cannot: the fetch fails
      // transiently. Memoising the rejection would leave every later form for the life of
      // the window holding a failure a second request would not have reproduced — and the
      // hook's own arm for it is `checker-unavailable`, which is a settlement rather than
      // a retry, so a form opened again is the only thing that re-asks and this is what
      // lets it. `SchemaFormChunk`'s memo drops on the same terms and for the same reason.
      this.#compilerPromise = undefined;
      throw loadError;
    }
  }
}

/** The real edge into the chunk, and the one place the specifier is written. */
async function importSchemaValidatorCompiler(): Promise<SchemaValidatorCompiler> {
  const { compileSchemaValidator } = await import("./json-schema-check.js");
  return compileSchemaValidator;
}

/** The renderer's loader. A test builds its own; nothing else does. */
const schemaValidatorCompilerChunk: SchemaValidatorCompilerChunk =
  new SchemaValidatorCompilerChunk();

/**
 * Fetch the schema compiler, and hand back the compiler itself.
 *
 * The door's shape is unchanged — one call, one promise of the compiler — so the hook and
 * the three test supports that already reach it need no edit. What moved is behind it.
 */
export function loadSchemaValidatorCompiler(): Promise<SchemaValidatorCompiler> {
  return schemaValidatorCompilerChunk.load();
}

// The schema compiler behind a loader: it and its library are a chunk of their own, fetched
// on the first compile. The promise is memoized because `import()` of a loaded module still
// returns a fresh promise that settles a turn later; measured, that turn had the accessibility
// tier audit a form still `compiling`. It rejects only when the chunk did not load.

import type { SchemaValidator } from "./json-schema-validator.js";

/**
 * What the loader hands back: the compiler, not a compiled validator. Compiling is
 * synchronous once the module is here and the schema is the caller's.
 */
export type SchemaValidatorCompiler = (inputSchema: unknown) => SchemaValidator;

/** The compiler's chunk, fetched once however many forms ask. */
class SchemaValidatorCompilerChunk {
  #compilerPromise: Promise<SchemaValidatorCompiler> | undefined;

  /**
   * The compiler, fetched once; every later call gets the same promise. A rejection drops
   * the memo, so a later call reaches a live loader.
   */
  public load(): Promise<SchemaValidatorCompiler> {
    this.#compilerPromise ??= this.#loadOnce();
    return this.#compilerPromise;
  }

  async #loadOnce(): Promise<SchemaValidatorCompiler> {
    try {
      return await importSchemaValidatorCompiler();
    } catch (loadError) {
      // The fetch may fail transiently, so the rejection is not cached: a form opened again
      // must re-ask. `useSchemaForm.ts` settles this rejection as `checker-unavailable`.
      this.#compilerPromise = undefined;
      throw loadError;
    }
  }
}

/** The real edge into the chunk, and the one place the specifier is written. */
async function importSchemaValidatorCompiler(): Promise<SchemaValidatorCompiler> {
  const { compileSchemaValidator } = await import("./json-schema-validator.js");
  return compileSchemaValidator;
}

/** The renderer's one loader. */
const schemaValidatorCompilerChunk: SchemaValidatorCompilerChunk =
  new SchemaValidatorCompilerChunk();

/** Fetch the schema compiler, and hand back the compiler itself. */
export function loadSchemaValidatorCompiler(): Promise<SchemaValidatorCompiler> {
  return schemaValidatorCompilerChunk.load();
}

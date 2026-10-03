// The schema compiler behind a loader: it and its library are a chunk of their own, fetched
// on the first compile. The promise is memoized because `import()` of a loaded module still
// returns a fresh promise that settles a turn later; measured, that turn had the accessibility
// tier audit a form still `compiling`. It rejects only when the chunk did not load, and
// `useSchemaForm.ts` settles that rejection as `checker-unavailable`.

import { MemoizedLoad } from "@renderer/lib/memoized-load.js";
import type { SchemaValidator } from "./json-schema-validator.js";

/**
 * What the loader hands back: the compiler, not a compiled validator. Compiling is
 * synchronous once the module is here and the schema is the caller's.
 */
export type SchemaValidatorCompiler = (inputSchema: unknown) => SchemaValidator;

/** The renderer's one loader of the schema compiler, fetched once however many forms ask. */
export const schemaValidatorCompilerLoader: MemoizedLoad<SchemaValidatorCompiler> =
  new MemoizedLoad(async () => {
    const { compileSchemaValidator } = await import("./json-schema-validator.js");
    return compileSchemaValidator;
  });

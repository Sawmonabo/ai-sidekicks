// The loader resolves to the module's own compiler, and it is the same function.
//
// WHAT THIS EXISTS TO CATCH is a wrapper that drifted into re-implementing what it defers
// to — a second compile path, a memo that answers with a stale function, a re-export that
// silently became something else. Identity is the whole assertion, because everything the
// compiler DOES is pinned next door and a second copy of those cases here would be two
// answers to what a validator is.
//
// AND THE CASES THAT ARE NOT ABOUT IDENTITY are about the MEMO, which is two claims and
// not one. A second call must answer the same compiler — a caller holding two would be
// compiling against two readings of one library — and it must answer the same PROMISE,
// which is the stronger and the load-bearing one: the module map holds the module, so a
// fresh `import()` is cheap, but it still settles a turn later than the caller's own
// settle, and a hook that starts its load inside a mount is measured by that turn. The
// second describe below covers what only an injected fetch can reach: the memo is dropped
// when a load rejects, so a transient failure does not outlive itself.

import { describe, expect, it } from "vitest";

import { compileSchemaValidator } from "./json-schema-check.js";
import {
  SchemaValidatorCompilerChunk,
  loadSchemaValidatorCompiler,
  type SchemaValidatorCompiler,
} from "./json-schema-check-loader.js";

/** A compiler that is only ever compared by identity. Never called. */
const STUB_COMPILER = (() => ({ status: "compiled" })) as unknown as SchemaValidatorCompiler;

describe("the schema compiler's loader", () => {
  it("resolves to the compiler the module beside it declares", async () => {
    await expect(loadSchemaValidatorCompiler()).resolves.toBe(compileSchemaValidator);
  });

  it("answers the same compiler twice, whichever call gets there first", async () => {
    const [first, second] = await Promise.all([
      loadSchemaValidatorCompiler(),
      loadSchemaValidatorCompiler(),
    ]);

    expect(first).toBe(second);
  });

  it("answers ONE promise, so a caller inside a render round waits for one turn", () => {
    // Promise identity is the observable, `schema-form-mounts.test.ts`'s reading of the
    // same claim. Two distinct promises are two entries into the module map, and the
    // second one is what a mounting form actually waits on: the map has the MODULE, so
    // the fetch is cheap, but the promise is fresh and settles a turn later than the
    // caller's own settle. That turn is the whole defect — an accessibility mount audited
    // a form with no verdict, and three test supports raced their file's first import.
    expect(loadSchemaValidatorCompiler()).toBe(loadSchemaValidatorCompiler());
  });

  it("hands back a compiler that compiles, rather than a name that resolves", async () => {
    // The identity assertions above hold over an export that is a function of the right
    // shape and nothing more; this is what makes them about the validator.
    const compile = await loadSchemaValidatorCompiler();

    expect(compile({ type: "object", properties: { title: { type: "string" } } }).status).toBe(
      "compiled",
    );
  });
});

describe("the compiler chunk's memo", () => {
  it("negative control: two chunks do not share one memo", () => {
    // Without this the door's own case above would pass against a module-level promise,
    // which is the shared state the class form exists to avoid.
    expect(new SchemaValidatorCompilerChunk().load()).not.toBe(
      new SchemaValidatorCompilerChunk().load(),
    );
  });

  it("a load that REJECTED is asked again, rather than answered from the memo", async () => {
    let fetchCount = 0;
    const chunk = new SchemaValidatorCompilerChunk(async () => {
      fetchCount += 1;
      if (fetchCount === 1) {
        throw new Error("Failed to fetch dynamically imported module: json-schema-check.js");
      }
      return STUB_COMPILER;
    });

    // A chunk that did not arrive is not a chunk that cannot: the fetch fails
    // transiently, and a memoised rejection would leave every later form for the life of
    // the window holding a failure a second request would not have reproduced.
    await expect(chunk.load()).rejects.toThrow("Failed to fetch");

    await expect(chunk.load()).resolves.toBe(STUB_COMPILER);
    expect(fetchCount).toBe(2);
  });

  it("negative control: a chunk that keeps failing keeps failing", async () => {
    // Without this the retry above would pass against a memo that dropped nothing, on a
    // second call that happened to resolve for reasons of its own.
    const chunk = new SchemaValidatorCompilerChunk(() =>
      Promise.reject(new Error("the chunk is gone")),
    );

    await expect(chunk.load()).rejects.toThrow("the chunk is gone");
    await expect(chunk.load()).rejects.toThrow("the chunk is gone");
  });
});

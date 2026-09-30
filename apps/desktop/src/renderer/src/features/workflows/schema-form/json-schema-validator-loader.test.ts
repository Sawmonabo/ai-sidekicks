// The loader resolves to the module's own compiler, the same function, and memoizes it. A
// wrapper that drifted into a second compile path or a stale memo fails on identity; what the
// compiler does is pinned in `json-schema-validator.test.ts`. A second call must answer the
// same promise, not just the same compiler, because a fresh `import()` settles a turn later.
// The second describe covers what only an injected fetch reaches: a rejection drops the memo.

import { describe, expect, it } from "vitest";

import { compileSchemaValidator } from "./json-schema-validator.js";
import {
  SchemaValidatorCompilerChunk,
  loadSchemaValidatorCompiler,
  type SchemaValidatorCompiler,
} from "./json-schema-validator-loader.js";

/** A compiler that is only ever compared by identity. */
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
    // Promise identity is the observable (`schema-form-mounts.test.ts` reads the same claim):
    // a fresh promise settles a turn later than the caller's settle. That turn had an
    // accessibility mount audit a form with no verdict and test supports race their first import.
    expect(loadSchemaValidatorCompiler()).toBe(loadSchemaValidatorCompiler());
  });

  it("hands back a compiler that compiles, rather than a name that resolves", async () => {
    // Makes the identity assertions above about the validator, not just any function.
    const compile = await loadSchemaValidatorCompiler();

    expect(compile({ type: "object", properties: { title: { type: "string" } } }).status).toBe(
      "compiled",
    );
  });
});

describe("the compiler chunk's memo", () => {
  it("negative control: two chunks do not share one memo", () => {
    // Without this the one-promise case would pass against a module-level promise.
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

    // A transient fetch failure must not be memoized for the life of the window.
    await expect(chunk.load()).rejects.toThrow("Failed to fetch");

    await expect(chunk.load()).resolves.toBe(STUB_COMPILER);
    expect(fetchCount).toBe(2);
  });

  it("negative control: a chunk that keeps failing keeps failing", async () => {
    // Without this the retry above could pass on a second call that resolved on its own.
    const chunk = new SchemaValidatorCompilerChunk(() =>
      Promise.reject(new Error("the chunk is gone")),
    );

    await expect(chunk.load()).rejects.toThrow("the chunk is gone");
    await expect(chunk.load()).rejects.toThrow("the chunk is gone");
  });
});

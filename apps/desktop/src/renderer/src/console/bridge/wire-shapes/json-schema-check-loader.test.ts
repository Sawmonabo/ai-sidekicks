// The loader resolves to the module's own compiler, and it is the same function.
//
// WHAT THIS EXISTS TO CATCH is a wrapper that drifted into re-implementing what it defers
// to — a second compile path, a memo that answers with a stale function, a re-export that
// silently became something else. Identity is the whole assertion, because everything the
// compiler DOES is pinned next door and a second copy of those cases here would be two
// answers to what a validator is.
//
// AND ONE CASE THAT IS NOT ABOUT IDENTITY. The deferral is only worth anything if the
// module map is the memo the loader's header claims it is, so a second call must answer
// the same function rather than a fresh one — a caller holding two would be compiling
// against two readings of one library.

import { describe, expect, it } from "vitest";

import { compileSchemaValidator } from "./json-schema-check.js";
import { loadSchemaValidatorCompiler } from "./json-schema-check-loader.js";

describe("the schema compiler's loader", () => {
  it("resolves to the compiler the module beside it declares", async () => {
    await expect(loadSchemaValidatorCompiler()).resolves.toBe(compileSchemaValidator);
  });

  it("answers the same compiler twice, because the module map is the memo", async () => {
    const [first, second] = await Promise.all([
      loadSchemaValidatorCompiler(),
      loadSchemaValidatorCompiler(),
    ]);

    expect(first).toBe(second);
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

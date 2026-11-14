// The window's contract types are the service's: the committed generated folder is what the
// current Rust contracts generate, byte for byte. A Rust contract changed without regenerating, or
// a generated file edited by hand, fails here.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { GENERATED_FOLDER_PATH, generatedFiles } from "../generated-files.ts";

/** The emit compiles the contracts' example on a cold cache, which takes minutes. */
const EMIT_TIMEOUT_MS = 600_000;

describe("the committed generated folder", () => {
  it(
    "holds exactly the files the current Rust contracts generate",
    async () => {
      const generated = await generatedFiles();
      const committed = readdirSync(GENERATED_FOLDER_PATH, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => join(entry.parentPath, entry.name).slice(GENERATED_FOLDER_PATH.length + 1));

      expect([...committed].sort()).toStrictEqual([...generated.keys()].sort());
      const differing = [...generated].filter(
        ([path, source]) => readFileSync(join(GENERATED_FOLDER_PATH, path), "utf8") !== source,
      );
      expect(differing.map(([path]) => path)).toStrictEqual([]);
    },
    EMIT_TIMEOUT_MS,
  );
});

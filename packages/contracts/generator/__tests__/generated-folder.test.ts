// The window's contract types are the service's. The committed generated folder is what the
// current Rust contracts generate, byte for byte: a Rust contract changed without regenerating, or
// a generated file edited by hand, fails here. And where a contract writes its wire form by hand,
// what serde writes is what that schema states: a value the Rust side writes for each such type
// passes its schema, so a hand-written serializer and its schema cannot drift apart.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { ValidateFunction } from "ajv/dist/2020.js";
import { beforeAll, describe, expect, it } from "vitest";

import { SCHEMA_FORMATS, repeatsItemKey, wireByteLength } from "../../src/schema-check.ts";
import type { ContractEmit, SerializerSample } from "../emit-folder.ts";
import { GENERATED_FOLDER_PATH, generatedFiles, runContractEmit } from "../generated-files.ts";
import { createCheckCompiler, type CheckCompiler } from "../schema-checks.ts";

/**
 * The emit compiles the contracts' example on a cold cache, which takes minutes; generating the
 * folder and compiling every check a sample reaches each take far less, under the same bound.
 */
const GENERATION_TIMEOUT_MS = 600_000;

/** Why `sample` fails its schema, or nothing when it passes. */
function sampleFault(compiler: CheckCompiler, sample: SerializerSample): string | undefined {
  const written = `${sample.type} wrote ${JSON.stringify(sample.value)}`;
  let check: ValidateFunction;
  try {
    check = compiler.ajv.compile(sample.schema);
  } catch (error) {
    return `${written}, whose schema does not compile: ${String(error)}`;
  }
  const attachments = sample.attachments.map((bytes) => Uint8Array.from(bytes));
  return check.call({ attachments }, sample.value)
    ? undefined
    : `${written}, which its schema refuses: ${JSON.stringify(check.errors)}`;
}

describe("the window's contract types", () => {
  let emit: ContractEmit;
  beforeAll(() => {
    emit = runContractEmit();
  }, GENERATION_TIMEOUT_MS);

  it(
    "are the committed generated folder, exactly the files the current Rust contracts generate",
    async () => {
      const generated = await generatedFiles(emit);
      const committed = readdirSync(GENERATED_FOLDER_PATH, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => join(entry.parentPath, entry.name).slice(GENERATED_FOLDER_PATH.length + 1));

      expect([...committed].sort()).toStrictEqual([...generated.keys()].sort());
      const differing = [...generated].filter(
        ([path, source]) => readFileSync(join(GENERATED_FOLDER_PATH, path), "utf8") !== source,
      );
      expect(differing.map(([path]) => path)).toStrictEqual([]);
    },
    GENERATION_TIMEOUT_MS,
  );

  it(
    "take what serde writes for every type whose serializer or schema is hand-written",
    () => {
      // A compiler whose checks run in this process; the generation's writes its checks out.
      const compiler = createCheckCompiler(emit.modules, () => [], {
        formats: SCHEMA_FORMATS,
        wireByteLength,
        repeatsItemKey,
      });
      const faults = [
        ...emit.serializerSamples.faults.map(({ type, fault }) => `${type}: ${fault}`),
        ...emit.serializerSamples.samples.flatMap((sample) => sampleFault(compiler, sample) ?? []),
      ];

      expect(emit.serializerSamples.samples.length).toBeGreaterThan(0);
      expect(faults).toStrictEqual([]);
    },
    GENERATION_TIMEOUT_MS,
  );
});

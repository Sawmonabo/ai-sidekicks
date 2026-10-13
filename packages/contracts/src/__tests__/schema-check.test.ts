// The parity corpus holds every input the Zod schemas these checks replace met in this package's
// tests, with Zod's verdict. Each module's generated check must give the same verdict, except on
// the inputs the corpus lists as expected differences, each with its reason.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import { expect, it } from "vitest";

const CORPUS_ROOT = fileURLToPath(
  new URL("../../../../crates/sidekicks-contracts/tests/fixtures/parity/", import.meta.url),
);
const MODULE_ROOT = fileURLToPath(new URL("../", import.meta.url));
/** The longest stretch of an input a failure quotes. */
const QUOTED_INPUT_LENGTH = 300;

/**
 * One corpus line: the JSON value as `input`, or, where that value holds a lone surrogate, which
 * serde_json refuses to read, its JSON text as `inputText`.
 */
type CorpusEntry = ({ readonly input: unknown } | { readonly inputText: string }) & {
  readonly schema: string;
  readonly accepted: boolean;
  readonly note?: string;
};

/** A listed difference, naming its input by the SHA-256 of the input's JSON text. */
interface ExpectedDifference {
  readonly schema: string;
  readonly side: "ajv" | "rust";
  readonly reason: string;
  readonly inputSha256: string;
}

/** The input's JSON text exactly as the corpus line holds it. */
function inputTextOf(entry: CorpusEntry): string {
  return "inputText" in entry ? entry.inputText : JSON.stringify(entry.input);
}

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(join(CORPUS_ROOT, name), "utf8")) as T;
}

function corpusFiles(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? corpusFiles(join(folder, entry.name))
      : entry.name.endsWith(".jsonl.gz")
        ? [join(folder, entry.name)]
        : [],
  );
}

/** The generated check a corpus key names: `<module>#<Name>Schema` is `validate<Name>`. */
function checkNameOf(key: string, renames: Readonly<Record<string, string>>): string {
  const typeName = renames[key] ?? key.slice(key.indexOf("#") + 1).replace(/Schema$/u, "");
  return `validate${typeName[0]!.toUpperCase()}${typeName.slice(1)}`;
}

it("gives Zod's verdict on every parity corpus input", async () => {
  const expected = readJson<ExpectedDifference[]>("expected-differences.json");
  const renames = readJson<Record<string, string>>("check-names.json");
  const aliases = readJson<Record<string, string[]>>("aliases.json");
  const unmatched = new Map(
    expected
      .filter((difference) => difference.side === "ajv")
      .map((difference) => [`${difference.schema} ${difference.inputSha256}`, difference]),
  );

  // Every key with its inputs: a schema's own, and each alias export reading the same inputs.
  const entriesByKey = new Map<string, CorpusEntry[]>();
  for (const file of corpusFiles(CORPUS_ROOT)) {
    const module = relative(CORPUS_ROOT, file).replace(/\.jsonl\.gz$/u, "");
    for (const line of gunzipSync(readFileSync(file)).toString("utf8").split("\n")) {
      if (line === "") {
        continue;
      }
      const entry = JSON.parse(line) as CorpusEntry;
      for (const key of [
        `${module}#${entry.schema}`,
        ...(aliases[`${module}#${entry.schema}`] ?? []),
      ]) {
        const entries = entriesByKey.get(key) ?? [];
        entries.push(entry);
        entriesByKey.set(key, entries);
      }
    }
  }

  const faults: string[] = [];
  const modules = new Map<string, Record<string, unknown> | undefined>();
  let checkedInputs = 0;
  for (const [key, entries] of entriesByKey) {
    const module = key.slice(0, key.indexOf("#"));
    if (!modules.has(module)) {
      try {
        modules.set(
          module,
          (await import(join(MODULE_ROOT, `${module}.ts`))) as Record<string, unknown>,
        );
      } catch (error) {
        modules.set(module, undefined);
        faults.push(`${module}: the generated module does not load: ${String(error)}`);
      }
    }
    const generated = modules.get(module);
    if (generated === undefined) {
      continue;
    }
    const name = checkNameOf(key, renames);
    const check = generated[name];
    if (typeof check !== "function") {
      faults.push(`${key}: ${module} has no check ${name}`);
      continue;
    }
    for (const entry of entries) {
      checkedInputs++;
      const text = inputTextOf(entry);
      if ((check as (value: unknown) => boolean)(JSON.parse(text)) === entry.accepted) {
        continue;
      }
      const digest = createHash("sha256").update(text).digest("hex");
      if (!unmatched.delete(`${key} ${digest}`)) {
        faults.push(
          `${key}: Zod ${entry.accepted ? "accepts" : "refuses"} and the check does not: ` +
            text.slice(0, QUOTED_INPUT_LENGTH),
        );
      }
    }
  }
  for (const difference of unmatched.values()) {
    faults.push(
      `${difference.schema}: a listed difference no longer differs (${difference.reason})`,
    );
  }

  expect(faults).toEqual([]);
  expect(checkedInputs).toBeGreaterThan(0);
});

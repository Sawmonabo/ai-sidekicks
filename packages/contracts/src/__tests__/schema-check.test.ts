// The parity corpus holds every input the Zod schemas these checks replace met in this package's
// tests, with Zod's verdict. Each module's generated check must give the same verdict, except on
// the inputs the corpus lists as expected differences, each with its reason.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

const CORPUS_ROOT = fileURLToPath(
  new URL("../../../../crates/sidekicks-contracts/tests/fixtures/parity/", import.meta.url),
);
const MODULE_ROOT = fileURLToPath(new URL("../", import.meta.url));
/** The longest stretch of an input a failure quotes. */
const QUOTED_INPUT_LENGTH = 300;

interface CorpusEntry {
  readonly schema: string;
  readonly accepted: boolean;
  readonly note?: string;
  readonly input: unknown;
}

interface ExpectedDifference {
  readonly schema: string;
  readonly side: "ajv" | "rust";
  readonly reason: string;
  readonly input: unknown;
}

/** JSON with every object's keys sorted, so two equal inputs compare equal as text. */
function canonicalJson(value: unknown): string {
  const sorted = (node: unknown): unknown =>
    Array.isArray(node)
      ? node.map(sorted)
      : node !== null && typeof node === "object"
        ? Object.fromEntries(
            Object.keys(node)
              .sort()
              .map((key) => [key, sorted((node as Record<string, unknown>)[key])]),
          )
        : node;
  return JSON.stringify(sorted(value));
}

function corpusFiles(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? corpusFiles(join(folder, entry.name))
      : entry.name.endsWith(".jsonl")
        ? [join(folder, entry.name)]
        : [],
  );
}

/** The generated check a corpus key names: `<module>#<Name>Schema` is `validate<Name>`. */
function checkNameOf(
  exportName: string,
  renames: Readonly<Record<string, string>>,
  key: string,
): string {
  const typeName = renames[key] ?? exportName.replace(/Schema$/u, "");
  return `validate${typeName[0]!.toUpperCase()}${typeName.slice(1)}`;
}

it("gives Zod's verdict on every parity corpus input", async () => {
  const expected = JSON.parse(
    readFileSync(join(CORPUS_ROOT, "expected-differences.json"), "utf8"),
  ) as ExpectedDifference[];
  const renames = JSON.parse(readFileSync(join(CORPUS_ROOT, "check-names.json"), "utf8")) as Record<
    string,
    string
  >;
  const unmatched = new Map(
    expected
      .filter((difference) => difference.side === "ajv")
      .map((difference) => [`${difference.schema} ${canonicalJson(difference.input)}`, difference]),
  );
  const entriesByModule = new Map<string, CorpusEntry[]>();
  for (const file of corpusFiles(CORPUS_ROOT)) {
    const module = relative(CORPUS_ROOT, file).replace(/(?:\.\d+)?\.jsonl$/u, "");
    const entries = readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as CorpusEntry);
    entriesByModule.set(module, [...(entriesByModule.get(module) ?? []), ...entries]);
  }

  const faults: string[] = [];
  let checkedInputs = 0;
  for (const [module, entries] of entriesByModule) {
    let generated: Record<string, unknown>;
    try {
      generated = (await import(join(MODULE_ROOT, `${module}.ts`))) as Record<string, unknown>;
    } catch (error) {
      faults.push(`${module}: the generated module does not load: ${String(error)}`);
      continue;
    }
    const missing = new Set<string>();
    for (const entry of entries) {
      const key = `${module}#${entry.schema}`;
      const name = checkNameOf(entry.schema, renames, key);
      const check = generated[name];
      if (typeof check !== "function") {
        missing.add(`${key}: ${module} has no check ${name}`);
        continue;
      }
      checkedInputs++;
      if ((check as (value: unknown) => boolean)(entry.input) === entry.accepted) {
        continue;
      }
      const differenceKey = `${key} ${canonicalJson(entry.input)}`;
      if (!unmatched.delete(differenceKey)) {
        faults.push(
          `${key}: Zod ${entry.accepted ? "accepts" : "refuses"} and the check does not: ` +
            JSON.stringify(entry.input).slice(0, QUOTED_INPUT_LENGTH),
        );
      }
    }
    faults.push(...missing);
  }
  for (const difference of unmatched.values()) {
    faults.push(
      `${difference.schema}: a listed difference no longer differs (${difference.reason})`,
    );
  }

  expect(checkedInputs).toBeGreaterThan(0);
  expect(faults).toEqual([]);
});

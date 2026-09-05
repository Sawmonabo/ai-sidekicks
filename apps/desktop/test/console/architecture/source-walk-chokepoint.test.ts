// Every source-text gate reads the same tree, and the build says so.
//
// WHY THIS FILE EXISTS. Five gates in this directory make claims of the form "no
// module in the console does X". Each claim is only as good as the SET it quantifies
// over, and that set is a directory walk with an opinion about what counts as source.
// Written per gate, those opinions drift silently: before this chokepoint there were
// three copies plus the shared helper, and they already disagreed — two excluded
// `.test-support.*` and one did not, so `bridge/fixture-bridge.test-support.ts` was
// inside one gate's universe and outside another's, with nothing anywhere reporting
// the difference. A gate that scans a smaller tree than its sentence claims is not a
// weaker gate; it is a gate that reports clean for the wrong reason.
//
// So `test/console/console-source-modules.ts` owns the walk, its `tests` option
// expresses the one legitimate divergence, and this file is what keeps a sixth walk
// from appearing beside it. It is the same posture the timer and byte-scaling
// chokepoints take toward the console's own source: name the one module that may do
// the thing, and assert nothing else does.
//
// THE INSTRUMENT IS SOURCE TEXT, and it has to be: "this gate draws its module set
// from the shared walk" is a claim about how a test file is written, which no type
// and no runtime assertion inside those tests can reach.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CONSOLE_DIRECTORY,
  CONSOLE_SOURCE_ROOTS,
  consoleSourceModules,
  moduleNamed,
  readConsoleSourceModule,
} from "../console-source-modules.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ARCHITECTURE_TIER_DIRECTORY = HERE;
const SHARED_WALK_MODULE = resolve(HERE, "..", "console-source-modules.ts");

/**
 * How a module shows it walked a directory itself.
 *
 * `readdirSync` is the only spelling the tier has ever used and the only one the two
 * replaced copies used. `readdir(` covers the promise form, which nothing here writes
 * yet and which is the shape a sixth walk would most plausibly arrive as.
 */
const DIRECTORY_WALK_FORMS: readonly string[] = ["readdirSync(", "readdir("];

/** How a module shows it drew its set from the shared walk instead. */
const SHARED_WALK_IMPORT = "console-source-modules.js";

/**
 * The one gate that names the forms above, which is this one.
 *
 * A chokepoint's own declaration of what it forbids is the one place the forbidden
 * text has to appear, and the byte-scaling gate next door draws the same line the
 * same way. The claim below asserts this file still TRIPS the needles, so the
 * admission cannot outlive its cause: a rename of `readdirSync` would leave a
 * constant admitting a file that no longer matches, and the clean result above would
 * stop meaning anything.
 */
const FORM_DECLARING_GATE = "source-walk-chokepoint.test.ts";

/** Every way `source` shows it walked a directory of its own, or `[]`. */
function directoryWalkSignatures(source: string): readonly string[] {
  return DIRECTORY_WALK_FORMS.filter((form) => source.includes(form));
}

/** Every gate in this directory, by file name. */
function architectureGateFileNames(): readonly string[] {
  return consoleSourceModules({ roots: [ARCHITECTURE_TIER_DIRECTORY], tests: true })
    .map((module) => module.relativePath)
    .filter((name) => name.endsWith(".test.ts"))
    .sort();
}

function readArchitectureGate(fileName: string): string {
  return readFileSync(join(ARCHITECTURE_TIER_DIRECTORY, fileName), "utf8");
}

describe("source-walk chokepoint — one walk under every source-text claim", () => {
  const gates = architectureGateFileNames();

  it("finds the architecture tier to scan at all", () => {
    // Without this a wrong directory would scan nothing and both claims below would
    // pass over the empty set.
    expect(gates.length).toBeGreaterThan(8);
    expect(gates).toContain("timer-chokepoint.test.ts");
    expect(gates).toContain("source-walk-chokepoint.test.ts");
  });

  it("no gate walks a directory of its own", () => {
    const offenders = gates
      .filter((gate) => gate !== FORM_DECLARING_GATE)
      .map((gate) => ({ gate, signatures: directoryWalkSignatures(readArchitectureGate(gate)) }))
      .filter((entry) => entry.signatures.length > 0)
      .map((entry) => `${entry.gate}: ${entry.signatures.join(", ")}`);
    expect(offenders).toStrictEqual([]);
  });

  it("negative control: the one admitted gate still trips the needles", () => {
    // See `FORM_DECLARING_GATE`. Without this the admission is a hole rather than a
    // declaration: a renamed walk API would leave every needle matching nothing
    // anywhere, and the clean result above would be clean for that reason instead.
    expect(directoryWalkSignatures(readArchitectureGate(FORM_DECLARING_GATE))).toStrictEqual([
      ...DIRECTORY_WALK_FORMS,
    ]);
  });

  it("every gate that reads source text draws its set from the shared walk", () => {
    // The other direction, and it is not the same claim: a gate could avoid
    // `readdirSync` by hard-coding a list of paths, which is a fifth opinion about
    // what counts as source wearing a different shape. The gates that read source are
    // exactly the ones that name the reader, so the set is derived rather than listed.
    const readers = gates.filter((gate) =>
      readArchitectureGate(gate).includes("readConsoleSourceModule"),
    );
    expect(readers.length).toBeGreaterThan(3);
    const offenders = readers.filter(
      (gate) => !readArchitectureGate(gate).includes(SHARED_WALK_IMPORT),
    );
    expect(offenders).toStrictEqual([]);
  });

  it("negative control: the predicate reads a walk and not a mention of one", () => {
    // Both sides of the line, against the predicate rather than against whichever
    // gate happens to name a walk in prose today — this file's own header does.
    expect(
      directoryWalkSignatures("const entries = readdirSync(root, { recursive: true });"),
    ).toStrictEqual(["readdirSync("]);
    expect(directoryWalkSignatures("await readdir(root, { recursive: true });")).toStrictEqual([
      "readdir(",
    ]);
    // Each needle carries its open paren, so a header explaining why a gate does NOT
    // walk is not an offence — two of them say exactly that about themselves.
    expect(
      directoryWalkSignatures("// this file used to carry its own `readdirSync`"),
    ).toStrictEqual([]);
    expect(
      directoryWalkSignatures("const modules = consoleSourceModules({ tests: true });"),
    ).toStrictEqual([]);
  });

  it("negative control: the shared walk itself is the one module that walks", () => {
    // The clean result above is only meaningful if the needles match real code, and
    // the one place they must match is the module that owns the walk. It is outside
    // this directory, so it is not an offender — and asserting it still trips turns a
    // renamed API into a red gate rather than a silent hole.
    expect(directoryWalkSignatures(readFileSync(SHARED_WALK_MODULE, "utf8"))).toContain(
      "readdirSync(",
    );
  });
});

describe("source-walk chokepoint — the walk answers what its options say", () => {
  it("excludes tests by default and admits them on request", () => {
    const production = consoleSourceModules({ roots: [CONSOLE_DIRECTORY] });
    const withTests = consoleSourceModules({ roots: [CONSOLE_DIRECTORY], tests: true });
    expect(production.length).toBeGreaterThan(20);
    expect(withTests.length).toBeGreaterThan(production.length);
    expect(production.map((module) => module.displayPath)).not.toContain(
      "console/bridge/fixture-bridge.test-support.ts",
    );
    expect(withTests.map((module) => module.displayPath)).toContain(
      "console/bridge/fixture-bridge.test-support.ts",
    );
    // The divergence that made the two hand-rolled walks disagree, asserted as one
    // answer: `.test-support.*` and `.test.*` are the same class to this walk, so no
    // caller can end up with one and not the other.
    expect(withTests.map((module) => module.displayPath)).toContain("console/core/instant.test.ts");
  });

  it("never admits a declaration file on either setting", () => {
    for (const tests of [false, true]) {
      expect(
        consoleSourceModules({ tests }).filter((module) => module.displayPath.endsWith(".d.ts")),
      ).toStrictEqual([]);
    }
  });

  it("defaults to both console roots, and a missing root contributes nothing", () => {
    expect(CONSOLE_SOURCE_ROOTS).toContain(CONSOLE_DIRECTORY);
    expect(consoleSourceModules().length).toBeGreaterThanOrEqual(
      consoleSourceModules({ roots: [CONSOLE_DIRECTORY] }).length,
    );
  });

  it("names the module a caller asked for, and says which name was not found", () => {
    const modules = consoleSourceModules({ roots: [CONSOLE_DIRECTORY] });
    expect(moduleNamed(modules, "console/core/instant.ts").displayPath).toBe(
      "console/core/instant.ts",
    );
    expect(readConsoleSourceModule(moduleNamed(modules, "console/core/instant.ts"))).toContain(
      "parseInstant",
    );
    expect(() => moduleNamed(modules, "console/core/absent.ts")).toThrow(
      "the scan did not reach console/core/absent.ts",
    );
    expect(() => moduleNamed(modules, "console/core/absent.ts", "the reader")).toThrow(
      "the scan did not reach the reader at console/core/absent.ts",
    );
  });
});

// A backticked path claim names a file that exists.
//
// WHAT THIS CLOSES. Three module-move PRs in a row each left a wave of header comments
// naming a module at the path it used to sit at — the console cleanup needed a whole
// sweep lane of its own, and one develop merge left 122 such sites across 98 files that
// only an adversarial reader found. Every one read correctly and pointed at nothing.
// None of the package's other gates can see them: the compiler resolves specifiers,
// `knip` resolves imports, `dependency-cruiser` resolves edges, and a path written in
// prose is not any of the three. The next move now fails here instead.
//
// THE SUBJECT IS EVERY TREE A PERSON TYPES INTO — `src/`, `test/`, `build/`, and
// `scripts/` through the shared walk's `DESKTOP_AUTHORED_ROOTS`, plus the budget
// document, whose prose fields name harnesses and suites by path and are read by no
// other tripwire at all. The reading is `path-claims.ts` beside this file, so every
// predicate below is driven against planted text as well as against the real tree.
//
// THE EXCLUSIONS ARE THREE CLASSES AND NO LIST. A glob is a pattern rather than a
// location; a `node_modules/` path or a `@scope/` specifier names somebody else's tree;
// and a string a sibling suite plants as a deliberately-absent foil is that suite's own
// negative control, which this gate would otherwise demand be deleted. There is no
// allowlist file and no per-site exemption, because the moment one exists the next
// stale claim is added to it instead of being fixed.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  consoleSourceModules,
  DESKTOP_AUTHORED_ROOTS,
  DESKTOP_PACKAGE_ROOT,
  readConsoleSourceModule,
  RENDERER_SOURCE_ROOT,
} from "../console-source-modules.js";
import {
  describePathClaim,
  foilStringsIn,
  PathClaimResolver,
  pathClaimsIn,
  pathClaimSpansIn,
  unresolvedPathClaims,
  type PathClaim,
  type PathClaimSubject,
} from "./path-claims.js";

/**
 * The budget this file states rather than inherits.
 *
 * One parse of every hand-written module in the package, plus a directory read per
 * resolution base. The sibling chokepoint records why a number here is stated at all:
 * the same pass measured alone is under a second and under this tier's five-project
 * concurrency was measured at six, so what a budget guards is a pass that never
 * settles rather than a slow one.
 */
const PACKAGE_PARSE_ALLOWANCE_MS = 30_000;

vi.setConfig({ testTimeout: PACKAGE_PARSE_ALLOWANCE_MS });

/**
 * The foils this file plants, declared where the exclusion class can read them.
 *
 * A gate whose whole claim is that a path resolves has to write one that does not, and
 * writing it anywhere else would make this file its own first offender. `path-claims.ts`
 * subtracts the strings of every `*_FOILS` export in a test module, so the plant is
 * admitted BY THE MECHANISM the sibling suites are admitted by rather than by an
 * exception carved for this one — which is also what proves that mechanism works
 * against a real tree and not only against the corpus below.
 *
 * The second is a CASING foil and not a second missing module: `sessions/` exists and
 * `SessionsPane.tsx` is really in it, so on the authoring machine's case-insensitive
 * volume the path is reachable and on a CI runner it is not.
 */
export const PATH_CLAIM_FOILS: readonly string[] = [
  "console/there-is-no-such-family/absent-module.ts",
  "console/Sessions/pane/SessionsPane.tsx",
];

/** The budget document, the one file this gate reads that is not a module. */
const BUDGET_DOCUMENT = join(DESKTOP_PACKAGE_ROOT, "test", "console", "budget", "budgets.json");

/** What a failure names the budget document by, on the package-relative convention. */
const BUDGET_DISPLAY_PATH = "test/console/budget/budgets.json";

/** The repository, which is what a `docs/…` or `apps/desktop/…` claim resolves under. */
const REPOSITORY_ROOT = resolve(DESKTOP_PACKAGE_ROOT, "..", "..");

/**
 * Every file this gate reads: the package's modules, and the budget document.
 *
 * The modules come from the shared walk with `{ tests: true }`, because a stale claim
 * in a suite's header misleads exactly as much as one in a shipped module's and the
 * `.test-support.*` half is where a header is most often copied along with the helper
 * it describes. The budget document is appended by name rather than walked — it is one
 * file, and teaching the walk about `.json` would hand every other source-text gate a
 * document it would parse as TypeScript.
 */
function pathClaimSubjects(): readonly PathClaimSubject[] {
  const modules = consoleSourceModules({ roots: DESKTOP_AUTHORED_ROOTS, tests: true }).map(
    (module) => ({
      displayPath: module.displayPath,
      source: readConsoleSourceModule(module),
      ownDirectory: dirname(module.absolutePath),
    }),
  );
  return [
    ...modules,
    {
      displayPath: BUDGET_DISPLAY_PATH,
      source: readFileSync(BUDGET_DOCUMENT, "utf8"),
      ownDirectory: dirname(BUDGET_DOCUMENT),
    },
  ];
}

/**
 * The resolver this gate holds the tree to: the repository as the ceiling, the console
 * and the renderer as the two bases no ancestry reaches.
 *
 * Three roots this package's prose measures from that a claiming file cannot always
 * climb to: the console (`seats/pane-chrome.css`), the renderer (`console/core/…`), and
 * the console test tier, which every module naming the gate that holds it to a rule
 * writes from — `architecture/barrel-census.test.ts`, `budget/measured-by.test.ts`.
 * The console and renderer anchors come from the shared walk rather than being spelled
 * again, so a root that moves takes them with it.
 *
 * The ceiling is the repository because that is where a claim like
 * `docs/plans/023-desktop-shell-and-renderer.md` or `apps/desktop/AGENTS.md` is written
 * from, and because a base above it would read a path out of whatever directory this
 * checkout happens to sit in.
 */
function pathClaimResolver(): PathClaimResolver {
  return new PathClaimResolver(REPOSITORY_ROOT, [
    join(RENDERER_SOURCE_ROOT, "console"),
    RENDERER_SOURCE_ROOT,
    join(DESKTOP_PACKAGE_ROOT, "test", "console"),
  ]);
}

/** Every foil string the package's test modules declare, this file's own included. */
function declaredFoilStrings(subjects: readonly PathClaimSubject[]): ReadonlySet<string> {
  return new Set(
    subjects
      .filter((subject) => subject.displayPath !== BUDGET_DISPLAY_PATH)
      .flatMap((subject) => foilStringsIn(subject.displayPath, subject.source)),
  );
}

describe("every backticked path claim names a file", () => {
  const subjects = pathClaimSubjects();
  const foils = declaredFoilStrings(subjects);
  const resolver = pathClaimResolver();
  const claims = subjects.flatMap((subject) => pathClaimsIn(subject, foils));

  it("reads the whole package, and finds claims in it", () => {
    // The vacuity half, in both directions. A wrong root set would scan nothing; a
    // grammar that matched nothing would report clean over any tree at all. Both
    // floors sit well under the readings taken while this was written — 3 045 files
    // carrying 2 651 claims — so they fail on a reader that broke rather than on a
    // tree that grew, and neither can be met by a scan that reached one directory.
    expect(subjects.length).toBeGreaterThan(2_000);
    expect(claims.length).toBeGreaterThan(1_500);
    expect(subjects.map((subject) => subject.displayPath)).toEqual(
      expect.arrayContaining([
        "src/renderer/src/console/families.ts",
        "test/console/console-source-modules.ts",
        "scripts/budget/measure-bundle.mts",
        "build/assert-webprefs.ts",
        BUDGET_DISPLAY_PATH,
      ]),
    );
  });

  it("has no claim that resolves under none of its bases", () => {
    expect(unresolvedPathClaims(subjects, resolver, foils).map(describePathClaim)).toStrictEqual(
      [],
    );
  });

  it("reads the budget document's prose, which no other tripwire scans", () => {
    // Its own case because the JSON arm is a different reader from the parse, and a
    // regression there would hide inside the whole-package result above.
    const budget = subjects.find((subject) => subject.displayPath === BUDGET_DISPLAY_PATH);
    expect(budget).toBeDefined();
    expect(pathClaimsIn(budget as PathClaimSubject, foils).length).toBeGreaterThan(0);
  });

  it("negative control: it reports a planted claim that names nothing, and clears its neighbour", () => {
    // Without this the clean result above would mean nothing — a reader that matched
    // no token reports clean over a tree of pure fiction. Both plants are written the
    // way the defect is written in the wild: a path in a header comment, and one
    // inside a failure message a gate composes.
    const planted: PathClaimSubject = {
      displayPath: "src/renderer/src/console/sessions/sessions-store.ts",
      source: [
        "// Folded by `console/there-is-no-such-family/absent-module.ts`, which moved.",
        "// The seat it fills is `seats/pane-chrome.css`.",
        'export const advice = "read `console/there-is-no-such-family/absent-module.ts` first";',
        "",
      ].join("\n"),
      ownDirectory: join(RENDERER_SOURCE_ROOT, "console", "sessions"),
    };
    const reported = unresolvedPathClaims([planted], resolver).map(describePathClaim);
    expect(reported).toStrictEqual([
      "src/renderer/src/console/sessions/sessions-store.ts:1 → console/there-is-no-such-family/absent-module.ts",
      "src/renderer/src/console/sessions/sessions-store.ts:3 → console/there-is-no-such-family/absent-module.ts",
    ]);
  });

  it("negative control: a casing that only a case-insensitive volume resolves is reported", () => {
    // The failure class a naive `existsSync` cannot see and CI can: `sessions/` and
    // `SessionsPane.tsx` both exist, so this path opens on the authoring machine and
    // does not on the runner.
    const planted: PathClaimSubject = {
      displayPath: "src/renderer/src/console/frame/ConsoleRoot.tsx",
      source: "// Mounts `console/Sessions/pane/SessionsPane.tsx`.\n",
      ownDirectory: join(RENDERER_SOURCE_ROOT, "console", "frame"),
    };
    expect(unresolvedPathClaims([planted], resolver).map(describePathClaim)).toStrictEqual([
      "src/renderer/src/console/frame/ConsoleRoot.tsx:1 → console/Sessions/pane/SessionsPane.tsx",
    ]);
  });

  it("positive control: a token reachable only from the console base resolves", () => {
    // The bases are a fallback chain, and a chain that stopped at the file's own
    // directory would report every console-relative claim in the package. This path
    // exists under `src/renderer/src/console/` and under nothing else on the list,
    // and the claiming file is deliberately in another tree entirely.
    const planted: PathClaimSubject = {
      displayPath: "test/console/architecture/some-gate.test.ts",
      source: "// The chrome is `seats/pane-chrome.css`, and the sheet is its own.\n",
      ownDirectory: join(DESKTOP_PACKAGE_ROOT, "test", "console", "architecture"),
    };
    expect(unresolvedPathClaims([planted], resolver)).toStrictEqual([]);
  });

  it("refuses a glob, a package specifier, a dependency path, and a wrapped sentence", () => {
    // The exclusion classes, driven as one corpus so a narrowing of any of them turns
    // this red. Each names something that does not exist on disk, so a class silently
    // dropped is reported by the case above rather than passing unnoticed.
    const planted: PathClaimSubject = {
      displayPath: "test/console/architecture/some-other-gate.test.ts",
      source: [
        "// Claims every `console/**/*.test.ts` in the tree.",
        "// Reads `@ai-sidekicks/contracts/src/nothing-here.ts` and",
        "// `node_modules/typescript/lib/absent.ts`, and mentions",
        "// `see console/absent/thing.ts` in passing.",
        "",
      ].join("\n"),
      ownDirectory: join(DESKTOP_PACKAGE_ROOT, "test", "console", "architecture"),
    };
    expect(pathClaimsIn(planted)).toStrictEqual([]);
  });

  it("reads a comment, a literal, and a template, and no other text", () => {
    // The span reader, exercised where the parse is the only instrument that can tell
    // the three apart from the code around them. The bare identifier and the divisions
    // are what a text scan for backticks would have to be right about and is not.
    const source = [
      "// A `core/clock.ts` claim in a comment.",
      'const message = "and `tokens/glyphs.ts` in a literal";',
      "const composed = `beside `+`primitives/accent-fill.ts` in a template`;",
      "const ratio = width / height / 2;",
      "",
    ].join("\n");
    const found = pathClaimsIn({
      displayPath: "src/renderer/src/console/core/probe.ts",
      source,
      ownDirectory: join(RENDERER_SOURCE_ROOT, "console", "core"),
    });
    expect(found.map((claim: PathClaim) => `${String(claim.line)}:${claim.path}`)).toStrictEqual([
      "1:core/clock.ts",
      "2:tokens/glyphs.ts",
      "3:primitives/accent-fill.ts",
    ]);
  });

  it("carries a `:NNN` cite and an `#anchor` through to the resolved path", () => {
    // Both locator forms appear in this package's prose, and a reader that took them
    // as part of the file name would report every cited document as missing.
    const found = pathClaimsIn({
      displayPath: "test/console/architecture/some-cite.test.ts",
      source:
        "// See `seats/pane-chrome.css:12` and `docs/plans/023-desktop-shell-and-renderer.md#scope`.\n",
      ownDirectory: join(DESKTOP_PACKAGE_ROOT, "test", "console", "architecture"),
    });
    expect(found.map((claim: PathClaim) => claim.path)).toStrictEqual([
      "seats/pane-chrome.css",
      "docs/plans/023-desktop-shell-and-renderer.md",
    ]);
  });

  it("negative control: the foil reader takes a `*_FOILS` export and nothing beside it", () => {
    // The exclusion is keyed on the export NAME, so the class cannot be taken by
    // writing a stale claim into a differently-named constant. Both shapes the tier
    // writes are driven: a flat list, and a table of objects.
    const source = [
      'export const SAMPLE_FOILS = ["console/absent/one.ts", { path: "console/absent/two.ts" }];',
      'const NOT_A_FOIL_LIST = ["console/absent/three.ts"];',
      'export const SAMPLE_PATHS = ["console/absent/four.ts"];',
      "",
    ].join("\n");
    expect(foilStringsIn("test/console/architecture/foil-probe.test.ts", source)).toStrictEqual([
      "console/absent/one.ts",
      "console/absent/two.ts",
    ]);
  });

  it("reads the package's own declared foils, this file's included", () => {
    // The subtraction is only as real as the set it reads: an empty one would make
    // the exclusion class dead code while every case above still passed.
    expect(foils.size).toBeGreaterThan(0);
    for (const foil of PATH_CLAIM_FOILS) {
      expect(foils).toContain(foil);
    }
  });

  it("reads a JSON document as one span and a module through the parse", () => {
    // The two arms of the span reader, side by side, because the JSON arm is chosen
    // by extension and a module that ended in `.json` would be read as prose.
    expect(pathClaimSpansIn("budgets.json", '{ "note": "`core/clock.ts`" }')).toStrictEqual([
      { start: 0, text: '{ "note": "`core/clock.ts`" }' },
    ]);
    expect(pathClaimSpansIn("probe.ts", "const value = 1;\n").length).toBe(0);
  });
});

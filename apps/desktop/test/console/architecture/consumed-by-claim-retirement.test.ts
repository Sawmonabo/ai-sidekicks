// A `// Consumed by` line above a declaration is deleted by the PR that consumes it.
//
// THE MARKER HAS THREE PLACEMENTS AND ONLY TWO OF THEM HAD A GATE. `apps/desktop`
// AGENTS.md gives a symbol published ahead of its reader one claim written in two
// places: the `@consumedBy T-023p-1C-<n>` JSDoc tag on the barrel's own export
// specifier wherever the dead-code gate needs its exemption, or the `// Consumed by
// T-023p-1C-<n>` line on that specifier wherever it does not — and the same line
// written above the DECLARATION, "so the symbol names its consumer where a reader meets
// it". knip's `--treat-tag-hints-as-errors` retires the tag the moment a consumer
// lands, and `barrel-census.test.ts` retires the door specifier's line under its
// `claim-outlived-its-consumer` finding. Nothing retired the third, and fourteen of
// them were standing over symbols a production module already imported — one over
// `ConsolePaneContext`, which every pane body in the console takes.
//
// WHY THAT ROT IS WORSE THAN AN UNUSED COMMENT. The marker is what decides whether a
// symbol is early or dead — no reader and no marker means delete, a marker means leave
// it until the task arrives — so one saying "nothing reads this yet" over a symbol
// twelve modules read leads the next reader to delete a live seam or keep a dead one.
//
// THE RULE, for every `// Consumed by` LINE comment leading a top-level declaration in
// `console/`: a production module OUTSIDE the declaring family importing the name fails
// it, and nothing else does. A sibling deep-import is not the event the marker names —
// AGENTS.md retires it "in the PR that imports the symbol THROUGH THE DOOR", and the
// console DAG makes those one set, since `console-view-family-isolation` and the
// layering rules leave a cross-family reader no route except the family door.
//
// THE INSTRUMENT IS THE PARSER, for two questions. Which declaration a comment leads is
// trivia attachment, which no regular expression can answer — a `//` line inside a
// string reads identically to one above an `export` — so claims come off
// `parseSourceText`, the tier's one parse home. Who consumes a symbol is which module a
// specifier names and which door it travels through, which `barrel-census.ts` answers
// for the door-side rule, so this gate takes `productionReadersByIdentity` rather than
// resolving specifiers again: two resolvers are two answers. The walk under both is the
// shared one, so `source-walk-chokepoint.test.ts` sees no second opinion on source.

import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  CONSOLE_DIRECTORY,
  DESKTOP_PACKAGE_ROOT,
  consoleSourceModules,
  readConsoleSourceModule,
  toPosixSeparators,
} from "../console-source-modules.js";
import { parseSourceText } from "../typescript-source.js";
import { productionReadersByIdentity } from "./barrel-census.js";
import type { CensusModule } from "./barrel-syntax.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const TEST_CONSOLE_ROOT = resolve(HERE, "..");
const RENDERER_SOURCE_ROOT = resolve(CONSOLE_DIRECTORY, "..");

/** Where a console module sits in this census, and in a failure message. */
const CONSOLE_PREFIX = "src/renderer/src/console/";

/**
 * The two roots holding every module able to consume a console symbol — the pair
 * `barrel-census.test.ts` scans, for its reasons: the composition root above the
 * families imports them, and a symbol only the tiers reach awaits its consumer still.
 */
const CENSUS_ROOTS: readonly string[] = [RENDERER_SOURCE_ROOT, TEST_CONSOLE_ROOT];

/**
 * What the two parse passes cost, stated rather than left to vitest's default. This file
 * reads the console twice — the trivia above every declaration, then the shared consumer
 * reading — and `barrel-census.test.ts` measured one pass at ~2.8 s alone and ~13 s under
 * the aggregate gate's concurrency, so the hook is sized to twice the worst of those and
 * a case, comparing a reading already finished, is deliberately not.
 */
const CONSOLE_READING_ALLOWANCE_MS = 30_000;
const COMPARISON_ALLOWANCE_MS = 10_000;

vi.setConfig({ testTimeout: COMPARISON_ALLOWANCE_MS, hookTimeout: CONSOLE_READING_ALLOWANCE_MS });

/** One `// Consumed by` line and the declaration it stands over. */
interface DeclarationClaim {
  readonly modulePath: string;
  /** One-based, so a failure names the line an editor opens on. */
  readonly line: number;
  /** Every name the declaration below the marker introduces. */
  readonly declaredNames: readonly string[];
}

/** A claim the rule fails, and the readers that retired it. */
interface ClaimFinding {
  readonly modulePath: string;
  readonly line: number;
  readonly declaredName: string;
  readonly readers: readonly string[];
}

/**
 * The family a console module belongs to, `null` for a composition root directly under
 * `console/` and for every module outside it — deliberately OUTSIDE every family, a root
 * registrar reading a seat being the cross-family consumer a marker names.
 */
function consoleFamilyOf(modulePath: string): string | null {
  if (!modulePath.startsWith(CONSOLE_PREFIX)) {
    return null;
  }
  const withinConsole = modulePath.slice(CONSOLE_PREFIX.length);
  const separator = withinConsole.indexOf("/");
  return separator === -1 ? null : withinConsole.slice(0, separator);
}

/** Whether `readerPath` is a module the declaring family owns. */
function readsFromInsideTheFamily(declaringPath: string, readerPath: string): boolean {
  const declaringFamily = consoleFamilyOf(declaringPath);
  return declaringFamily !== null && consoleFamilyOf(readerPath) === declaringFamily;
}

/** Every name one top-level statement introduces, or none for a statement that declares nothing. */
function declaredNamesOf(statement: ts.Statement): readonly string[] {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap((declaration) =>
      ts.isIdentifier(declaration.name) ? [declaration.name.text] : [],
    );
  }
  if (
    ts.isFunctionDeclaration(statement) ||
    ts.isClassDeclaration(statement) ||
    ts.isInterfaceDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement) ||
    ts.isEnumDeclaration(statement)
  ) {
    return statement.name === undefined ? [] : [statement.name.text];
  }
  return [];
}

/**
 * Every `// Consumed by` line standing over a declaration in one module.
 *
 * LINE COMMENTS ONLY, and the exclusion is the point: the `@consumedBy` JSDoc tag is
 * knip's exemption and knip's own hint retires it, so reading block comments here would
 * report a second time on a claim that already has an owner. A marker leading a
 * statement that declares nothing — a door's prose, or one written against an
 * `export { … }` specifier — is `barrel-census.ts`'s for that same reason.
 */
function declarationClaimsIn(module: CensusModule): readonly DeclarationClaim[] {
  const sourceFile = parseSourceText(module.path, module.source);
  const claims: DeclarationClaim[] = [];
  for (const statement of sourceFile.statements) {
    const declaredNames = declaredNamesOf(statement);
    if (declaredNames.length === 0) {
      continue;
    }
    const markers = (ts.getLeadingCommentRanges(module.source, statement.pos) ?? []).filter(
      (range) =>
        range.kind === ts.SyntaxKind.SingleLineCommentTrivia &&
        module.source.slice(range.pos, range.end).includes("Consumed by"),
    );
    for (const marker of markers) {
      claims.push({
        modulePath: module.path,
        line: sourceFile.getLineAndCharacterOfPosition(marker.pos).line + 1,
        declaredNames,
      });
    }
  }
  return claims;
}

/** Every claim the module set carries, in walk order, console production modules only. */
function declarationClaims(modules: readonly CensusModule[]): readonly DeclarationClaim[] {
  return modules
    .filter((module) => !module.isTest && module.path.startsWith(CONSOLE_PREFIX))
    .flatMap((module) => declarationClaimsIn(module));
}

/** Everything the cases below ask, answered off ONE reading of the module set. */
interface ClaimReading {
  readonly claims: readonly DeclarationClaim[];
  readonly readersByIdentity: ReadonlyMap<string, readonly string[]>;
  readonly findings: readonly ClaimFinding[];
}

/** Every claim the rule fails, in walk order. */
function claimFindings(
  claims: readonly DeclarationClaim[],
  readersByIdentity: ReadonlyMap<string, readonly string[]>,
): readonly ClaimFinding[] {
  const findings: ClaimFinding[] = [];
  for (const claim of claims) {
    for (const declaredName of claim.declaredNames) {
      const readers = (readersByIdentity.get(`${claim.modulePath}#${declaredName}`) ?? []).filter(
        (reader) => !readsFromInsideTheFamily(claim.modulePath, reader),
      );
      if (readers.length > 0) {
        findings.push({ modulePath: claim.modulePath, line: claim.line, declaredName, readers });
      }
    }
  }
  return findings;
}

/** What a failure reads as: one line per claim, naming what has to move. */
function findingLines(findings: readonly ClaimFinding[]): readonly string[] {
  return findings.map(
    (finding) =>
      `${finding.modulePath}:${finding.line} :: ${finding.declaredName} — already imported by ` +
      `${finding.readers.join(", ")}; delete the marker`,
  );
}

/** The console and the tiers that read it, keyed as the shared consumer reading keys them. */
function consoleCensusModules(): readonly CensusModule[] {
  return consoleSourceModules({ roots: CENSUS_ROOTS, tests: true }).map((module) => ({
    path: toPosixSeparators(relative(DESKTOP_PACKAGE_ROOT, module.absolutePath)),
    source: readConsoleSourceModule(module),
    isTest:
      module.directory === TEST_CONSOLE_ROOT ||
      /\.test(-support)?\.tsx?$/.test(module.relativePath),
  }));
}

/**
 * The one reading this file pays for, behind a throwing accessor — on
 * `barrel-census.test.ts`'s reasoning: a mutable binding a hook fills is reachable from a
 * case that runs first, and `undefined` there reads as a clean console nobody looked at.
 */
class ClaimCensus {
  #reading: ClaimReading | undefined;

  public read(modules: readonly CensusModule[]): void {
    const readersByIdentity = productionReadersByIdentity(modules);
    const claims = declarationClaims(modules);
    const findings = claimFindings(claims, readersByIdentity);
    this.#reading = { claims, readersByIdentity, findings };
  }

  public get reading(): ClaimReading {
    if (this.#reading === undefined) {
      throw new Error("the claim census was read by a case before the hook that fills it ran");
    }
    return this.#reading;
  }
}

describe("consumed-by claims — every declaration marker still awaits its consumer", () => {
  const modules = consoleCensusModules();
  const census = new ClaimCensus();

  beforeAll(() => {
    census.read(modules);
  });

  it("negative control: a case reaching the reading before the hook says so", () => {
    expect(() => new ClaimCensus().reading).toThrowError(/before the hook/);
  });

  it("finds the console and the tiers that read it", () => {
    // Without a floor a wrong root scans nothing and every claim passes over the empty set.
    expect(modules.filter((module) => module.path.startsWith(CONSOLE_PREFIX)).length) //
      .toBeGreaterThan(50);
    expect(modules.filter((module) => module.isTest).length).toBeGreaterThan(50);
  });

  it("reads a claim count no hand-maintained list could hold", () => {
    expect(census.reading.claims.length).toBeGreaterThan(10);
    expect(census.reading.claims.every((claim) => claim.declaredNames.length > 0)).toBe(true);
  });

  it("finds claims whose only production readers are their own family, so the scope bites", () => {
    // The family scoping separates "a sibling builds with it" from "the door handed it
    // to someone", and both halves need members or the rule is vacuous or absolute.
    const { claims, readersByIdentity } = census.reading;
    const withSiblingReaderOnly = claims.filter((claim) =>
      claim.declaredNames.some((declaredName) => {
        const readers = readersByIdentity.get(`${claim.modulePath}#${declaredName}`) ?? [];
        return (
          readers.length > 0 &&
          readers.every((reader) => readsFromInsideTheFamily(claim.modulePath, reader))
        );
      }),
    );
    expect(withSiblingReaderOnly.length).toBeGreaterThan(0);
  });

  it("no declaration marker stands over a symbol production already imports", () => {
    expect(findingLines(census.reading.findings)).toStrictEqual([]);
  });
});

/** The rule over one hand-written module set, read the way the hook reads the console. */
function plantedFindings(modules: readonly CensusModule[]): readonly ClaimFinding[] {
  return claimFindings(declarationClaims(modules), productionReadersByIdentity(modules));
}

/** A module set written by hand to fail, so the rule is exercised without the console. */
function plantedModules(reader: CensusModule | undefined): readonly CensusModule[] {
  const declaring: CensusModule = {
    path: `${CONSOLE_PREFIX}seats/planted-seat.ts`,
    source:
      "// Consumed by T-023p-1C-9\nexport interface PlantedSeat {\n  readonly kind: string;\n}",
    isTest: false,
  };
  const door: CensusModule = {
    path: `${CONSOLE_PREFIX}seats/index.ts`,
    source: 'export { type PlantedSeat } from "./planted-seat.js";\n',
    isTest: false,
  };
  return reader === undefined ? [declaring, door] : [declaring, door, reader];
}

/** One module taking `PlantedSeat` and building with it, from wherever it is placed. */
function plantedReader(path: string, specifier: string, isTest = false): CensusModule {
  return {
    path,
    source: [
      `import { type PlantedSeat } from "${specifier}";`,
      "export const seats: readonly PlantedSeat[] = [];",
    ].join("\n"),
    isTest,
  };
}

describe("consumed-by claims — the rule, over corpora written by hand to fail", () => {
  it("negative control: a marker over a symbol another family imports is a finding", () => {
    const findings = plantedFindings(
      plantedModules(
        plantedReader(`${CONSOLE_PREFIX}workspace/PlantedSidebar.ts`, "../seats/index.js"),
      ),
    );
    expect(findingLines(findings)).toStrictEqual([
      `${CONSOLE_PREFIX}seats/planted-seat.ts:1 :: PlantedSeat — already imported by ` +
        `${CONSOLE_PREFIX}workspace/PlantedSidebar.ts; delete the marker`,
    ]);
  });

  it("a marker whose only reader is a sibling in its own family is not a finding", () => {
    const findings = plantedFindings(
      plantedModules(
        plantedReader(`${CONSOLE_PREFIX}seats/planted-sibling.ts`, "./planted-seat.js"),
      ),
    );
    expect(findingLines(findings)).toStrictEqual([]);
  });

  it("a marker whose only reader is a test is not a finding", () => {
    // The whole reason the marker class exists: a symbol reached only by the suite
    // covering it is exactly the state knip cannot report and the claim is for.
    const findings = plantedFindings(
      plantedModules(
        plantedReader(`${CONSOLE_PREFIX}seats/planted-seat.test.ts`, "./planted-seat.js", true),
      ),
    );
    expect(findingLines(findings)).toStrictEqual([]);
  });

  it("a marker with no reader at all is not a finding", () => {
    expect(findingLines(plantedFindings(plantedModules(undefined)))).toStrictEqual([]);
  });

  it("negative control: the reading attributes the marker to the declaration below it", () => {
    const module: CensusModule = {
      path: `${CONSOLE_PREFIX}seats/planted-shapes.ts`,
      source: [
        "// Consumed by T-023p-1C-9",
        "export const PLANTED_CAP = 4;",
        "",
        "// Consumed by T-023p-1C-9",
        "export type PlantedKind = string;",
        "",
        "// Consumed by T-023p-1C-9",
        "export function plantedRead(): void {}",
        "",
        "// Consumed by T-023p-1C-9",
        "export class PlantedStore {}",
      ].join("\n"),
      isTest: false,
    };
    expect(declarationClaimsIn(module)).toStrictEqual([
      { modulePath: module.path, line: 1, declaredNames: ["PLANTED_CAP"] },
      { modulePath: module.path, line: 4, declaredNames: ["PlantedKind"] },
      { modulePath: module.path, line: 7, declaredNames: ["plantedRead"] },
      { modulePath: module.path, line: 10, declaredNames: ["PlantedStore"] },
    ]);
  });

  it("negative control: the reading takes a marker and not a mention of one", () => {
    const module: CensusModule = {
      path: `${CONSOLE_PREFIX}seats/planted-prose.ts`,
      source: [
        "/** Consumed by T-023p-1C-9 — a JSDoc tag's half, which knip's own hint retires. */",
        "export const FIRST = 1;",
        "",
        'export const NOTE = "// Consumed by T-023p-1C-9";',
        "",
        "// Consumed by T-023p-1C-9 — over a re-export, which the barrel census reads.",
        'export { PLANTED } from "./planted-seat.js";',
      ].join("\n"),
      isTest: false,
    };
    expect(declarationClaimsIn(module)).toStrictEqual([]);
  });
});

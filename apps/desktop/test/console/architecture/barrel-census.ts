// The census the barrel gate next door runs: what a console door publishes, where
// each name is declared, and which of those specifiers nothing but a test reaches.
//
// A MODEL BESIDE ITS GATE, not a shared helper. It has one consumer —
// `barrel-census.test.ts` — and it lives here because the gate reads the real console
// while its controls read corpora written by hand to fail, and a rule that cannot be
// handed a corpus is a rule only its own tree can exercise. The module set arrives as
// a parameter for exactly that reason; the walk that produces the real one stays in
// the gate, where `source-walk-chokepoint.test.ts` can see it.
//
// THE RULE, and `barrel-syntax.ts` beside it is the READING. Nothing here touches a
// syntax tree: it is handed the door specifiers, the reaches, and the claim on each
// name, and it decides which of them fail. The two jobs fail in two ways — a reading
// defect drops a clause out of the universe, a rule defect judges the universe
// wrongly — and neither module can hide the other's.

import { posix } from "node:path";

import { readModuleSyntax, type CensusModule, type ModuleSyntax } from "./barrel-syntax.js";

/** One `export { name } from "./module.js"` entry in a barrel. */
export interface BarrelSpecifier {
  readonly barrelPath: string;
  /** The name the barrel publishes. */
  readonly exportedName: string;
  /** The name the module it comes from declares, which an alias makes different. */
  readonly localName: string;
  /**
   * The module the specifier resolves to.
   *
   * `null` where it leaves the module set, and equally where the clause names no
   * module at all — in both cases the name's declaring identity is this door itself,
   * because there is nowhere further to follow it to.
   */
  readonly fromPath: string | null;
  /** Whether the specifier names the task that will import it, in either form. */
  readonly claimed: boolean;
}

/** Why a specifier fails: nothing reads it, or its claim outlived its reader. */
export type CensusFindingReason = "unclaimed" | "claim-outlived-its-consumer";

/** A specifier the rule fails, and what about it fails. */
export interface CensusFinding {
  readonly reason: CensusFindingReason;
  readonly barrelPath: string;
  readonly exportedName: string;
  /**
   * The test modules importing it THROUGH this barrel — what a disposition moves.
   *
   * Through this barrel, and not every test reading the symbol: a co-located test
   * already importing the module that declares it is where a disposition sends the
   * others, so listing it among the offenders would name the destination as a
   * problem.
   */
  readonly testOnlyImporters: readonly string[];
}

/** One import or re-export edge between two modules in the set. */
interface ImportEdge {
  readonly importerPath: string;
  readonly isTest: boolean;
  readonly targetPath: string;
  /** The names taken, or `"namespace"` for `import * as`. */
  readonly names: readonly string[] | "namespace";
  /** Whether the edge republishes the names rather than using them. */
  readonly forwarded: boolean;
}

/** How many doors a symbol may travel through before the resolver calls it a cycle. */
const MAX_DOOR_HOPS = 8;

/** A console family door or sub-module door. */
export function isConsoleBarrel(path: string): boolean {
  return path.includes("/console/") && path.endsWith("/index.ts");
}

/** Every barrel specifier in the module set, in walk order. */
export function barrelSpecifiers(modules: readonly CensusModule[]): readonly BarrelSpecifier[] {
  return specifiersOf(readModuleSyntax(modules));
}

/**
 * Every console door that publishes nothing it did not declare itself.
 *
 * DERIVED FROM THE PARSED DOOR, and it was a hand-maintained list of two until this
 * became one. Every view family's door is a composition site — it registers a surface
 * or a pane against a registry it is handed, which is a CALL — so every family
 * landing appended its own path to that list, in its own branch, in the same three
 * lines. Four branches editing one list is a conflict by construction, and the list
 * was the only thing standing between the census's per-door claim and a quantifier.
 *
 * The reading is the door's own text: a door forwards if it carries a re-export — an
 * `export … from` line, or a set its text does not enumerate — and forwards nothing
 * if every name it publishes is declared in place. That is a DIFFERENT reading from
 * the specifier census next to it, which is what makes the claim that compares them
 * worth making: the defect it was written for is a clause reader that drops a door
 * line, and a dropped clause still leaves the statement this reads.
 */
export function doorsThatForwardNothing(modules: readonly CensusModule[]): readonly string[] {
  return readModuleSyntax(modules)
    .filter((module) => isConsoleBarrel(module.path) && !forwardsAnything(module))
    .map((module) => module.path)
    .sort();
}

/** Whether a module republishes any name it did not declare. */
function forwardsAnything(module: ModuleSyntax): boolean {
  return (
    module.forwardsUnnamedSet ||
    module.reaches.some((reach) => reach.forwarded && reach.moduleSpecifier !== undefined)
  );
}

/**
 * Every barrel forwarding a set its own text does not name.
 *
 * A specifier inside `export * from` could be neither censused nor tagged, so a
 * clean census means less than it says wherever one appears.
 */
export function starReexportingBarrels(modules: readonly CensusModule[]): readonly string[] {
  return readModuleSyntax(modules)
    .filter((module) => isConsoleBarrel(module.path) && module.forwardsUnnamedSet)
    .map((module) => module.path);
}

/** Every specifier the gate's rule fails, in walk order. */
export function censusFindings(modules: readonly CensusModule[]): readonly CensusFinding[] {
  const syntax = readModuleSyntax(modules);
  const specifiers = specifiersOf(syntax);
  const specifiersByModule = new Map<string, BarrelSpecifier[]>();
  for (const entry of specifiers) {
    const forModule = specifiersByModule.get(entry.barrelPath) ?? [];
    forModule.push(entry);
    specifiersByModule.set(entry.barrelPath, forModule);
  }
  const productionIdentities = new Set<string>();
  const productionDoorReads = new Set<string>();
  const testImportersBySpecifier = new Map<string, Set<string>>();
  for (const edge of importEdges(syntax)) {
    if (edge.importerPath === edge.targetPath) {
      continue;
    }
    const takenNames =
      edge.names === "namespace"
        ? (specifiersByModule.get(edge.targetPath) ?? []).map((entry) => entry.exportedName)
        : edge.names;
    for (const name of takenNames) {
      if (edge.isTest) {
        if (isConsoleBarrel(edge.targetPath)) {
          const key = `${edge.targetPath}#${name}`;
          const importers = testImportersBySpecifier.get(key) ?? new Set<string>();
          importers.add(edge.importerPath);
          testImportersBySpecifier.set(key, importers);
        }
      } else if (!edge.forwarded) {
        productionIdentities.add(declaringIdentity(edge.targetPath, name, specifiersByModule));
        if (isConsoleBarrel(edge.targetPath)) {
          productionDoorReads.add(`${edge.targetPath}#${name}`);
        }
      }
    }
  }
  const findings: CensusFinding[] = [];
  for (const entry of specifiers) {
    const specifierKey = `${entry.barrelPath}#${entry.exportedName}`;
    const identity = declaringIdentity(entry.barrelPath, entry.exportedName, specifiersByModule);
    // The two failures, and they are opposite. An unclaimed specifier fails when NO
    // production module reads the symbol by any route, because a reader reaching the
    // module that declares it is still a reader. A claim fails when a production
    // module reads it THROUGH THIS DOOR, because that is the event the claim named:
    // `apps/desktop/AGENTS.md` retires the marker in the PR that imports the symbol,
    // and a claim standing after its consumer landed is the rot the tag's own hint
    // exists to prevent — a hint the dead-code gate cannot raise wherever it already
    // counts the specifier as referenced.
    //
    // A READER IS DECIDED BY WHAT THE EDGE DOES, NOT BY WHERE IT STARTS. A door that
    // writes `export { X } from` moves `X` and consumes nothing; a door that writes
    // `import { X }` and builds a table out of it is a consumer like any other module.
    // The rule asked only whether the importer was a barrel, which called both of them
    // forwarding — so `ConsolePaneDescriptor`, whose one production consumer is each
    // family's own door, stayed claimed with no reachable retiring event while knip,
    // counting the reference either way, failed the run on the unretirable tag.
    const failing = entry.claimed
      ? productionDoorReads.has(specifierKey)
      : !productionIdentities.has(identity);
    if (failing) {
      findings.push({
        reason: entry.claimed ? "claim-outlived-its-consumer" : "unclaimed",
        barrelPath: entry.barrelPath,
        exportedName: entry.exportedName,
        testOnlyImporters: [
          ...(testImportersBySpecifier.get(`${entry.barrelPath}#${entry.exportedName}`) ?? []),
        ].sort(),
      });
    }
  }
  return findings;
}

/** What a failure reads as: one line per specifier, naming what has to move. */
export function findingLines(findings: readonly CensusFinding[]): readonly string[] {
  return findings.map((finding) => {
    if (finding.reason === "claim-outlived-its-consumer") {
      return `${finding.barrelPath} :: ${finding.exportedName} — claimed, and already imported in production; delete the claim`;
    }
    const importers =
      finding.testOnlyImporters.length > 0
        ? finding.testOnlyImporters.join(", ")
        : "no importer at all";
    return `${finding.barrelPath} :: ${finding.exportedName} — reached only by ${importers}`;
  });
}

/** Every door line a console barrel publishes, resolved against the module set. */
function specifiersOf(modules: readonly ModuleSyntax[]): readonly BarrelSpecifier[] {
  const known = new Set(modules.map((module) => module.path));
  const specifiers: BarrelSpecifier[] = [];
  for (const module of modules) {
    if (!isConsoleBarrel(module.path)) {
      continue;
    }
    for (const door of module.doorSpecifiers) {
      // A clause naming no module of its own — a barrel republishing a name it
      // imported — is a door line like any other: it publishes a name, so it needs a
      // reader or a claim. A pattern that required `from "…"` could not see the line
      // at all, which is under-censusing wearing the shape of compliance.
      specifiers.push({
        barrelPath: module.path,
        exportedName: door.exportedName,
        localName: door.localName,
        fromPath: resolveSpecifier(module.path, door.moduleSpecifier, known),
        claimed: door.claimed,
      });
    }
  }
  return specifiers;
}

/** Every import and re-export edge that stays inside the module set. */
function importEdges(modules: readonly ModuleSyntax[]): readonly ImportEdge[] {
  const known = new Set(modules.map((module) => module.path));
  const edges: ImportEdge[] = [];
  for (const module of modules) {
    for (const reach of module.reaches) {
      const targetPath = resolveSpecifier(module.path, reach.moduleSpecifier, known);
      if (targetPath !== null) {
        edges.push({
          importerPath: module.path,
          isTest: module.isTest,
          targetPath,
          names: reach.names,
          forwarded: reach.forwarded,
        });
      }
    }
  }
  return edges;
}

/**
 * The module a relative specifier names, or `null` when it is outside the set.
 *
 * Resolved against the module set rather than the filesystem: that set is what every
 * claim quantifies over, so a specifier reaching a file the walk never saw has to
 * read as absent rather than as resolved.
 */
function resolveSpecifier(
  fromPath: string,
  specifier: string | undefined,
  known: ReadonlySet<string>,
): string | null {
  if (specifier === undefined || !specifier.startsWith(".")) {
    return null;
  }
  const base = posix.join(posix.dirname(fromPath), specifier).replace(/\.js$/, "");
  for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
    if (known.has(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Where a name is DECLARED, following every door it travels through.
 *
 * This is what makes "consumed through a different door" a pass: a family door and
 * the module that declares the name answer with one identity, so a reader of either
 * satisfies both.
 */
function declaringIdentity(
  modulePath: string,
  name: string,
  specifiersByModule: ReadonlyMap<string, readonly BarrelSpecifier[]>,
): string {
  let currentPath = modulePath;
  let currentName = name;
  for (let hop = 0; hop < MAX_DOOR_HOPS; hop += 1) {
    const forwarded = specifiersByModule
      .get(currentPath)
      ?.find((entry) => entry.exportedName === currentName);
    if (forwarded === undefined || forwarded.fromPath === null) {
      break;
    }
    currentPath = forwarded.fromPath;
    currentName = forwarded.localName;
  }
  return `${currentPath}#${currentName}`;
}

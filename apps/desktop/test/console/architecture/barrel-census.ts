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
// THE INSTRUMENT IS SOURCE TEXT, and it has to be: whether a name travels through a
// barrel or straight from the module that declares it is a property of the specifier
// someone wrote, which no type and no runtime value reports. The clause reading is
// the posture `bridge/growth-values/index.test.ts` established for its own census.

import { posix } from "node:path";

/** One module the census reads, keyed by its path from the package root. */
export interface CensusModule {
  readonly path: string;
  readonly source: string;
  readonly isTest: boolean;
}

/** One `export { name } from "./module.js"` entry in a barrel. */
export interface BarrelSpecifier {
  readonly barrelPath: string;
  /** The name the barrel publishes. */
  readonly exportedName: string;
  /** The name the module it comes from declares, which an alias makes different. */
  readonly localName: string;
  /** The module the specifier resolves to, or `null` when it leaves the module set. */
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
}

/** How many doors a symbol may travel through before the resolver calls it a cycle. */
const MAX_DOOR_HOPS = 8;

/**
 * The two forms a specifier names its future consumer in, both already in the tree.
 *
 * `@consumedBy` is the JSDoc tag `knip.json` admits as its one per-symbol exemption,
 * and it is what a specifier carries wherever the dead-code gate would otherwise
 * report the symbol. `// Consumed by` is the line comment `apps/desktop/AGENTS.md`
 * describes for the same claim where no exemption is being asked for — a tag knip
 * does not need is a tag `--treat-tag-hints-as-errors` fails the run on. This census
 * reads the CLAIM, so both forms answer it, and the rule below retires either one.
 */
const CLAIM_MARKERS: readonly string[] = ["@consumedBy", "Consumed by"];

const EXPORT_CLAUSE = /export\s+(?:type\s+)?\{([^}]*)\}\s*from\s*"([^"]+)"/g;
const IMPORT_CLAUSE = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*"([^"]+)"/g;
const NAMESPACE_IMPORT = /import\s+\*\s+as\s+[A-Za-z_$][\w$]*\s+from\s*"([^"]+)"/g;
const STAR_REEXPORT = /export\s+\*(?:\s+as\s+[A-Za-z_$][\w$]*)?\s+from\s*"([^"]+)"/g;

/**
 * One clause entry at a time: a comment, a comma, or a word.
 *
 * The comment arms come first so a tag naming several tasks — whose commas would
 * otherwise split one entry into three — is consumed whole.
 */
const CLAUSE_TOKEN = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|[A-Za-z_$][\w$]*|,/g;

/** A console family door or sub-module door. */
export function isConsoleBarrel(path: string): boolean {
  return path.includes("/console/") && path.endsWith("/index.ts");
}

/** Every barrel specifier in the module set, in walk order. */
export function barrelSpecifiers(modules: readonly CensusModule[]): readonly BarrelSpecifier[] {
  const known = new Set(modules.map((module) => module.path));
  const specifiers: BarrelSpecifier[] = [];
  for (const module of modules) {
    if (!isConsoleBarrel(module.path)) {
      continue;
    }
    for (const [, clauseBody, specifier] of module.source.matchAll(EXPORT_CLAUSE)) {
      const fromPath = resolveSpecifier(module.path, specifier ?? "", known);
      for (const entry of clauseEntries(clauseBody ?? "")) {
        specifiers.push({
          barrelPath: module.path,
          exportedName: entry.exported,
          localName: entry.local,
          fromPath,
          claimed: entry.claimed,
        });
      }
    }
  }
  return specifiers;
}

/**
 * Every barrel forwarding a set its own text does not name.
 *
 * A specifier inside `export * from` could be neither censused nor tagged, so a
 * clean census means less than it says wherever one appears.
 */
export function starReexportingBarrels(modules: readonly CensusModule[]): readonly string[] {
  return modules
    .filter((module) => isConsoleBarrel(module.path))
    .filter((module) => new RegExp(STAR_REEXPORT.source).test(module.source))
    .map((module) => module.path);
}

/** Every specifier the gate's rule fails, in walk order. */
export function censusFindings(modules: readonly CensusModule[]): readonly CensusFinding[] {
  const specifiers = barrelSpecifiers(modules);
  const specifiersByModule = new Map<string, BarrelSpecifier[]>();
  for (const entry of specifiers) {
    const forModule = specifiersByModule.get(entry.barrelPath) ?? [];
    forModule.push(entry);
    specifiersByModule.set(entry.barrelPath, forModule);
  }
  const productionIdentities = new Set<string>();
  const productionDoorReads = new Set<string>();
  const testImportersBySpecifier = new Map<string, Set<string>>();
  for (const edge of importEdges(modules)) {
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
      } else if (!isConsoleBarrel(edge.importerPath)) {
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

/** Every entry a clause lists, with the tag that precedes each one. */
function clauseEntries(
  clauseBody: string,
): readonly { readonly local: string; readonly exported: string; readonly claimed: boolean }[] {
  const entries: { local: string; exported: string; claimed: boolean }[] = [];
  let words: string[] = [];
  let claimed = false;
  const flush = (): void => {
    const named = words.filter((word) => word !== "type");
    const first = named[0];
    if (named.length === 1 && first !== undefined) {
      entries.push({ local: first, exported: first, claimed });
    } else if (named.length === 3 && named[1] === "as" && first !== undefined) {
      entries.push({ local: first, exported: named[2] ?? first, claimed });
    }
    words = [];
    claimed = false;
  };
  for (const [token] of clauseBody.matchAll(CLAUSE_TOKEN)) {
    if (token.startsWith("/")) {
      claimed = claimed || CLAIM_MARKERS.some((marker) => token.includes(marker));
    } else if (token === ",") {
      flush();
    } else {
      words.push(token);
    }
  }
  flush();
  return entries;
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
  specifier: string,
  known: ReadonlySet<string>,
): string | null {
  if (!specifier.startsWith(".")) {
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

/** Every import and re-export edge in the module set. */
function importEdges(modules: readonly CensusModule[]): readonly ImportEdge[] {
  const known = new Set(modules.map((module) => module.path));
  const edges: ImportEdge[] = [];
  for (const module of modules) {
    for (const pattern of [IMPORT_CLAUSE, EXPORT_CLAUSE]) {
      for (const [, clauseBody, specifier] of module.source.matchAll(pattern)) {
        const targetPath = resolveSpecifier(module.path, specifier ?? "", known);
        if (targetPath !== null) {
          edges.push({
            importerPath: module.path,
            isTest: module.isTest,
            targetPath,
            names: clauseEntries(clauseBody ?? "").map((entry) => entry.local),
          });
        }
      }
    }
    for (const [, specifier] of module.source.matchAll(NAMESPACE_IMPORT)) {
      const targetPath = resolveSpecifier(module.path, specifier ?? "", known);
      if (targetPath !== null) {
        edges.push({
          importerPath: module.path,
          isTest: module.isTest,
          targetPath,
          names: "namespace",
        });
      }
    }
  }
  return edges;
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

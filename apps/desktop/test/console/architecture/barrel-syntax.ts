// What one module's source SAYS: the names its doors publish, the claim written
// against each of them, and the names it takes from other modules.
//
// THE READING, beside `barrel-census.ts`'s RULE. They are two jobs and they fail in
// two ways: a reading defect drops a clause out of the universe, and a rule defect
// judges the universe wrongly — so the rule is handed plain data here, and no census
// question is ever asked of a syntax tree.
//
// THE INSTRUMENT IS THE TYPESCRIPT PARSER over source text. Source text, because
// whether a name travels through a barrel or straight from the module that declares
// it is a property of the specifier someone wrote, which no type and no runtime value
// reports. The parser rather than a regular expression, because both regex readings
// this replaces failed silently and in opposite directions: a clause body matched by
// `[^}]*` ends at the first brace INSIDE a comment, so a whole door line — every name
// in it — vanished from a census whose entire value is that it quantifies over all of
// them; and a hand-rolled tokenizer that cleared its claim flag on the comma read a
// comment written AFTER that comma as the next specifier's, which exempts a name
// nobody claimed while dropping the claim of the one that was. A clause that drops
// out reads exactly like a clause that is compliant, and neither the census nor its
// floor assertion could tell the two apart.

import ts from "typescript";

import { parseSourceText } from "../typescript-source.js";

/** One module the census reads, keyed by its path from the package root. */
export interface CensusModule {
  readonly path: string;
  readonly source: string;
  readonly isTest: boolean;
}

/** One name a door publishes, as the source spells it. */
export interface DoorSpecifier {
  /** The name the door publishes. */
  readonly exportedName: string;
  /** The name the module it comes from declares, which an alias makes different. */
  readonly localName: string;
  /** The module named after `from`, or `undefined` for a clause that names none. */
  readonly moduleSpecifier: string | undefined;
  /** Whether the comments decorating this name claim a task that will import it. */
  readonly claimed: boolean;
}

/** One reach into another module — a statement's, or an `import(…)`'s. */
export interface ModuleReach {
  readonly moduleSpecifier: string | undefined;
  /** The names taken, or `"namespace"` for `import * as`. */
  readonly names: readonly string[] | "namespace";
  /**
   * Whether the reach is a door line republishing the names rather than using them.
   *
   * The census needs the two apart, and nothing else here does. A barrel that writes
   * `export { X } from "./m.js"` MOVES `X`; a barrel that writes `import { X }` and
   * builds something out of it READS it — and a rule that could only ask whether the
   * importer was a barrel had to call both of them forwarding, which left every
   * symbol whose one production consumer is a family door permanently claimed: the
   * claim's retiring event was an import through the door that the rule refused to
   * count.
   *
   * The third form is `import { X } from "./m.js"` followed by `export { X }`, which
   * MOVES `X` in two statements rather than one. Reading the statement kind alone
   * called it a use, so a re-export chain written that way passed the door-forwarding
   * comparison AND retired the source door's claim. It is one reach per DISPOSITION
   * rather than per statement, so a clause that republishes some of what it took and
   * builds with the rest is read correctly on both halves.
   */
  readonly forwarded: boolean;
}

/** Everything the census asks of one module's text, read in a single parse. */
export interface ModuleSyntax {
  readonly path: string;
  readonly isTest: boolean;
  /** Every `export { … }` name, whether or not the module is a door. */
  readonly doorSpecifiers: readonly DoorSpecifier[];
  /** Every import, re-export, and `import(…)`, by the names the SOURCE module calls them. */
  readonly reaches: readonly ModuleReach[];
  /** Whether it re-exports a set its own text does not enumerate. */
  readonly forwardsUnnamedSet: boolean;
}

/**
 * The two forms a specifier names its future consumer in, both already in the tree.
 *
 * `@consumedBy` is the JSDoc tag `knip.json` admits as its one per-symbol exemption,
 * and it is what a specifier carries wherever the dead-code gate would otherwise
 * report the symbol. `// Consumed by` is the line comment `apps/desktop/AGENTS.md`
 * describes for the same claim where no exemption is being asked for — a tag knip
 * does not need is a tag `--treat-tag-hints-as-errors` fails the run on. The census
 * reads the CLAIM, so both forms answer it, and its rule retires either one.
 */
const CLAIM_MARKERS: readonly string[] = ["@consumedBy", "Consumed by"];

/** Read every module once, in walk order. */
export function readModuleSyntax(modules: readonly CensusModule[]): readonly ModuleSyntax[] {
  return modules.map(readOneModule);
}

function readOneModule(module: CensusModule): ModuleSyntax {
  // Through the tier's one parse home, which takes the grammar from the path it
  // is handed — most of this corpus is `.tsx`. A second `createSourceFile` here
  // would be a second set of parse options for the same question.
  const sourceFile = parseSourceText(module.path, module.source);
  const forwardedBindings = bindingsOnlyReexported(sourceFile);
  const doorSpecifiers: DoorSpecifier[] = [];
  const reaches: ModuleReach[] = [];
  let forwardsUnnamedSet = false;
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      reaches.push(...importReaches(statement, forwardedBindings));
      continue;
    }
    if (!ts.isExportDeclaration(statement)) {
      continue;
    }
    const clause = statement.exportClause;
    if (clause === undefined || ts.isNamespaceExport(clause)) {
      forwardsUnnamedSet = true;
      continue;
    }
    const moduleSpecifier = moduleSpecifierOf(statement);
    const named = namedExports(clause, sourceFile, moduleSpecifier);
    doorSpecifiers.push(...named);
    reaches.push({
      moduleSpecifier,
      names: named.map((door) => door.localName),
      forwarded: true,
    });
  }
  reaches.push(...deferredReaches(sourceFile));
  return {
    path: module.path,
    isTest: module.isTest,
    doorSpecifiers,
    reaches,
    forwardsUnnamedSet,
  };
}

/** Every name a `export { … }` clause lists, each with the claim written against it. */
function namedExports(
  clause: ts.NamedExports,
  sourceFile: ts.SourceFile,
  moduleSpecifier: string | undefined,
): readonly DoorSpecifier[] {
  const { elements } = clause;
  return elements.map((element, index) => ({
    exportedName: element.name.text,
    localName: element.propertyName?.text ?? element.name.text,
    moduleSpecifier,
    // A node's `pos` begins where the PREVIOUS token ended — after the comma — so
    // the next element's `pos`, or the list's own `end` for the last element, is
    // where a claim trailing THIS one starts.
    claimed: claimDecorates(element, elements[index + 1]?.pos ?? elements.end, sourceFile.text),
  }));
}

/**
 * Whether the comments decorating one specifier name the task that will import it.
 *
 * THREE READINGS, because the two placements the tree writes sit on opposite sides
 * of the specifier and one of them is on the far side of a comma. Which side a
 * comment falls on is the parser's own leading/trailing convention: a comment on the
 * line the specifier ends on trails it, and a comment on a line of its own leads
 * whatever follows. That is the convention whoever wrote the comment used, and
 * reading it any other way is what attributed a trailing claim to the NEXT specifier
 * and discarded one written against the last.
 *
 * A comment decorating no specifier — one sitting alone before the closing brace —
 * is reached by none of the three, so it claims nothing and the names around it stay
 * unclaimed. That direction is the safe one: the gate reports a specifier whose claim
 * it could not attribute, rather than exempting one nobody claimed.
 */
function claimDecorates(element: ts.ExportSpecifier, trailingFrom: number, text: string): boolean {
  const ranges = [
    ...(ts.getLeadingCommentRanges(text, element.pos) ?? []),
    ...(ts.getTrailingCommentRanges(text, element.end) ?? []),
    ...(ts.getTrailingCommentRanges(text, trailingFrom) ?? []),
  ];
  return ranges.some((range) => {
    const comment = text.slice(range.pos, range.end);
    return CLAIM_MARKERS.some((marker) => comment.includes(marker));
  });
}

/**
 * What an import statement takes, SPLIT BY WHAT THE MODULE DOES WITH IT.
 *
 * The names are what the SOURCE module calls each binding — the property name
 * wherever an alias makes the two different — because that is the name the census
 * resolves against the module that declares it.
 *
 * ONE STATEMENT CAN BE BOTH KINDS OF REACH, which is why this answers a list. A
 * barrel may take four names from a module, build a table out of one and republish
 * the other three, and `forwarded` is what the census rests its whole disposition
 * on: a name a module USES retires the source door's claim, and a name it MOVES does
 * not. Reading the statement kind alone called every such import a use, so the pair
 * `import { X } from "./m.js"; export { X };` — the re-export form written wherever
 * a door republishes a name it also has to name in a type position, or wherever a
 * clause carries no `from` — read as a production consumer of `X` and retired a
 * claim nothing had come to collect. Split per binding rather than per statement,
 * because a rule that had to judge the whole statement would have to be wrong about
 * one half of a mixed one.
 */
function importReaches(
  statement: ts.ImportDeclaration,
  forwardedBindings: ReadonlySet<string>,
): readonly ModuleReach[] {
  const bindings = statement.importClause?.namedBindings;
  if (bindings === undefined) {
    return [];
  }
  const moduleSpecifier = moduleSpecifierOf(statement);
  if (ts.isNamespaceImport(bindings)) {
    return [
      { moduleSpecifier, names: "namespace", forwarded: forwardedBindings.has(bindings.name.text) },
    ];
  }
  // Grouped by the LOCAL name, which is what an `export { … }` clause names, while
  // the reach carries the SOURCE name the census resolves with. An alias is exactly
  // where those two part, so reading either one for both jobs mis-attributes it.
  const used: string[] = [];
  const forwarded: string[] = [];
  for (const element of bindings.elements) {
    const sourceName = element.propertyName?.text ?? element.name.text;
    (forwardedBindings.has(element.name.text) ? forwarded : used).push(sourceName);
  }
  return [
    ...(used.length > 0 ? [{ moduleSpecifier, names: used, forwarded: false }] : []),
    ...(forwarded.length > 0 ? [{ moduleSpecifier, names: forwarded, forwarded: true }] : []),
  ];
}

/**
 * Every local binding a module republishes and does not otherwise read.
 *
 * The whole of "only locally re-exported": a name listed in an `export { … }` clause
 * that names no module of its own, and appearing nowhere else in the module. A
 * binding a module both republishes and BUILDS with is a production use as well, so
 * it stays out of this set and its reach stays a use.
 *
 * DELETION RATHER THAN A COUNT, and every identifier outside an import or export
 * statement deletes: a property name in `holder.X`, a shorthand key, a name in a
 * type position. Over-counting a reference is the safe direction — it leaves the
 * reach classified exactly as it was before this reading existed — while missing one
 * would call a real consumer a forward and re-open the claim the census retired.
 */
function bindingsOnlyReexported(sourceFile: ts.SourceFile): ReadonlySet<string> {
  const reexported = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isExportDeclaration(statement) || statement.moduleSpecifier !== undefined) {
      continue;
    }
    const { exportClause } = statement;
    if (exportClause !== undefined && ts.isNamedExports(exportClause)) {
      for (const element of exportClause.elements) {
        reexported.add(element.propertyName?.text ?? element.name.text);
      }
    }
  }
  if (reexported.size === 0) {
    return reexported;
  }
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      return;
    }
    if (ts.isIdentifier(node)) {
      reexported.delete(node.text);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return reexported;
}

/**
 * Every module an `import("…")` names, in both of the forms a lazy chunk writes.
 *
 * A STATEMENT WALK CANNOT SEE EITHER. Both are expressions nested arbitrarily deep —
 * the call inside a method body, the type inside a type argument — so the loop above
 * reads neither, and a door whose only reader is a lazy chunk's loader reads to the
 * census as a door no module imports at all. That is a reading defect of exactly the
 * kind this file exists to prevent: `workflows/pane/run/phase-graph/index.ts` is
 * reached through `import()` AND THROUGH NOTHING ELSE by construction — the whole
 * point of the split point — so the census would have reported the one door the
 * bundle budget requires as the one door nothing consumes.
 *
 * The names are `"namespace"`, exactly as `import * as` is: the call resolves to the
 * whole module object, and what a caller destructures off it is a property read on a
 * value rather than a name in a specifier. The type form counts too — `typeof
 * import(…)` is how a loader narrows the shape it hands back, and a reading that took
 * only the runtime half would still under-count a door reached only through a type.
 */
function deferredReaches(sourceFile: ts.SourceFile): readonly ModuleReach[] {
  const reaches: ModuleReach[] = [];
  const visit = (node: ts.Node): void => {
    const moduleSpecifier = deferredSpecifierOf(node);
    if (moduleSpecifier !== undefined) {
      reaches.push({ moduleSpecifier, names: "namespace", forwarded: false });
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return reaches;
}

/** The module one node names by `import(…)`, where it names one as a literal. */
function deferredSpecifierOf(node: ts.Node): string | undefined {
  if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
    const [specifier] = node.arguments;
    return specifier !== undefined && ts.isStringLiteralLike(specifier)
      ? specifier.text
      : undefined;
  }
  if (ts.isImportTypeNode(node)) {
    const { argument } = node;
    return ts.isLiteralTypeNode(argument) && ts.isStringLiteral(argument.literal)
      ? argument.literal.text
      : undefined;
  }
  return undefined;
}

/** The module a statement names, whichever quotation mark it was written with. */
function moduleSpecifierOf(
  statement: ts.ImportDeclaration | ts.ExportDeclaration,
): string | undefined {
  const specifier = statement.moduleSpecifier;
  return specifier !== undefined && ts.isStringLiteral(specifier) ? specifier.text : undefined;
}

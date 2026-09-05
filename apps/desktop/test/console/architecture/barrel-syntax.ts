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

/** One statement's reach into another module. */
export interface ModuleReach {
  readonly moduleSpecifier: string | undefined;
  /** The names taken, or `"namespace"` for `import * as`. */
  readonly names: readonly string[] | "namespace";
}

/** Everything the census asks of one module's text, read in a single parse. */
export interface ModuleSyntax {
  readonly path: string;
  readonly isTest: boolean;
  /** Every `export { … }` name, whether or not the module is a door. */
  readonly doorSpecifiers: readonly DoorSpecifier[];
  /** Every import and re-export, by the names the SOURCE module calls them. */
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
  const doorSpecifiers: DoorSpecifier[] = [];
  const reaches: ModuleReach[] = [];
  let forwardsUnnamedSet = false;
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      const reach = importReach(statement);
      if (reach !== undefined) {
        reaches.push(reach);
      }
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
    reaches.push({ moduleSpecifier, names: named.map((door) => door.localName) });
  }
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
 * What an import statement takes, or nothing where it binds no named symbol.
 *
 * The names are what the SOURCE module calls each binding — the property name
 * wherever an alias makes the two different — because that is the name the census
 * resolves against the module that declares it.
 */
function importReach(statement: ts.ImportDeclaration): ModuleReach | undefined {
  const bindings = statement.importClause?.namedBindings;
  if (bindings === undefined) {
    return undefined;
  }
  return {
    moduleSpecifier: moduleSpecifierOf(statement),
    names: ts.isNamespaceImport(bindings)
      ? "namespace"
      : bindings.elements.map((element) => element.propertyName?.text ?? element.name.text),
  };
}

/** The module a statement names, whichever quotation mark it was written with. */
function moduleSpecifierOf(
  statement: ts.ImportDeclaration | ts.ExportDeclaration,
): string | undefined {
  const specifier = statement.moduleSpecifier;
  return specifier !== undefined && ts.isStringLiteral(specifier) ? specifier.text : undefined;
}

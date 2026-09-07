// How a class is read, and what makes a name in it count.
//
// THE CENSUS BESIDE THE CLAIMS, on this tier's own `barrel-census.ts` /
// `source-walk-census.ts` shape: `read-triggers.test.ts` states the rule, pins the
// readings that exist, and plants the controls; this module is the reading. The two
// split when the file carrying both passed 400 lines.
//
// EVERY NAME HERE IS BOUND TO THE MODULE IT CAME FROM, and none is matched as text. A
// class declaring a field typed by a LOCAL `ConsoleBridge`, or constructing a local
// class it happened to call `ActController`, satisfied name-only predicates exactly as
// the real thing did — a gate that can be passed by naming something correctly is not
// a gate. `budget/module-bindings.ts` answers a neighbouring question and not this
// one: it reports WHETHER a module holds a name, and what is needed here is where the
// name came FROM, so the two share the parse and nothing else.
//
// AND A CLASS IS READ TOGETHER WITH WHAT IT EXTENDS. The three repos controllers each
// declared the scheduler construction, the snapshot, and both trigger members until
// those six pass-throughs were hoisted onto `store/act-controller-base.ts`; read as
// bare declarations afterwards, all three would have silently left the gate's subject
// set while behaving identically. So the walk follows the `extends` chain, bounded at
// four hops — each link resolved as a BINDING through the same import list, and through
// the family door's own re-export to the module that declares the base — and folds what
// every base declares into the subclass's census. The bound is `RESOLUTION_DEPTH_LIMIT`
// and it is a guard rather than a policy: no console class is more than one link deep
// today, and a chain that ran longer than four would be a cycle the parse cannot see.
// A base reached by name rather than by import is not followed at all.

import ts from "typescript";

import { forEachDescendant, parseSourceText } from "../typescript-source.js";

/** The member names this console gives to "what a surface reads off me". */
const READING_MEMBER_NAMES: ReadonlySet<string> = new Set(["snapshot", "readout"]);

/**
 * What constructing a scheduler LOOKS like, in the two shapes this console has.
 *
 * A reading either holds a `RefreshScheduler` itself or composes `store/act-controller.ts`,
 * which holds one for it — the primitive the repos family's three controllers were
 * collapsed into. What this gate is about is that a reading is REFRESHABLE, and one
 * that delegates its scheduler is refreshable in exactly the sense the rule means: it
 * still declares the trigger contract below.
 */
const SCHEDULER_HOLDERS: readonly string[] = ["RefreshScheduler", "ActController"];

/** The two members `ReadTriggerTarget` requires. Declared once, asserted as a pair. */
const TRIGGER_CONTRACT_MEMBERS: readonly string[] = ["triggeringEventKinds", "requestRead"];

/**
 * Where a name this gate keys on has to have COME FROM, as console module paths with
 * the extension dropped.
 *
 * The bridge family publishes `ConsoleBridge` through its door, from the module that
 * declares it, and from the provider that re-exports it; the store family publishes
 * the scheduler and the act primitive through its door, and its own modules take them
 * by their declaring specifiers. A name reached from anywhere else is a local.
 */
const BRIDGE_MODULES: ReadonlySet<string> = new Set([
  "console/bridge/index",
  "console/bridge/console-bridge",
  "console/bridge/BridgeProvider",
]);

const SCHEDULER_MODULES: ReadonlySet<string> = new Set([
  "console/store/index",
  "console/store/scheduling",
  "console/store/act-controller",
  "console/store/act-controller-base",
]);

/** How far the `extends` walk and the door hop will chase one name before giving up. */
const RESOLUTION_DEPTH_LIMIT = 4;

/**
 * Resolve one RELATIVE import specifier against the module that wrote it.
 *
 * Answers a console display path with the extension dropped, so `./scheduling.js` and
 * `../../store/index.js` both land on the path the walk keys its index by. A bare
 * specifier resolves to nothing, which is the right answer for a gate whose whole
 * subject is this tree.
 */
function resolveSpecifier(fromDisplayPath: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) {
    return undefined;
  }
  const segments = fromDisplayPath.split("/").slice(0, -1);
  for (const segment of specifier.split("/")) {
    if (segment === "." || segment === "") {
      continue;
    }
    if (segment === "..") {
      if (segments.pop() === undefined) {
        return undefined;
      }
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/").replace(/\.(?:js|jsx|ts|tsx)$/u, "");
}

/** Every name this module imports, mapped to the module path it came FROM. */
function importedModules(parsed: ts.SourceFile, displayPath: string): ReadonlyMap<string, string> {
  const bindings = new Map<string, string>();
  for (const statement of parsed.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    const module = resolveSpecifier(displayPath, statement.moduleSpecifier.text);
    const clause = statement.importClause;
    if (module === undefined || clause === undefined) {
      continue;
    }
    if (clause.name !== undefined) {
      bindings.set(clause.name.text, module);
    }
    const namedBindings = clause.namedBindings;
    if (namedBindings !== undefined && ts.isNamedImports(namedBindings)) {
      for (const element of namedBindings.elements) {
        bindings.set(element.name.text, module);
      }
    }
  }
  return bindings;
}

/** Whether this module took `name` from one of `modules`. Never a bare name match. */
function boundTo(
  bindings: ReadonlyMap<string, string>,
  name: string,
  modules: ReadonlySet<string>,
): boolean {
  const module = bindings.get(name);
  return module !== undefined && modules.has(module);
}

/** One class, judged against the rule — before its base class is folded in. */
export interface ReadingClassCensus {
  readonly displayPath: string;
  readonly className: string;
  readonly publishesReading: boolean;
  readonly holdsBridge: boolean;
  readonly holdsScheduler: boolean;
  /**
   * The member names this class declares itself. Carried rather than reduced to the
   * boolean below, because the fold needs the SET: a subclass declaring one required
   * member and a base declaring the other satisfy the contract together, which two
   * OR-ed booleans can neither say nor deny.
   */
  readonly declaredMembers: ReadonlySet<string>;
  readonly declaresTriggerContract: boolean;
  /** The class this one extends, where the name was imported. Never a name match. */
  readonly baseName: string | undefined;
  /** The module path {@link baseName} was imported from. */
  readonly baseModule: string | undefined;
}

/** One module of the scan, read once, keyed by the path an import resolves to. */
export interface ConsoleModuleText {
  readonly displayPath: string;
  readonly source: string;
}

function memberName(member: ts.ClassElement): string | undefined {
  const { name } = member;
  if (name === undefined) {
    return undefined;
  }
  return ts.isIdentifier(name) || ts.isPrivateIdentifier(name) ? name.text : undefined;
}

/**
 * Whether this member is the thing a surface reads: a method, a getter, or a property
 * holding an arrow — the three ways this console writes it — and never a plain data
 * field, which would make every object with a `snapshot` field a reading.
 */
function publishesReading(member: ts.ClassElement): boolean {
  const name = memberName(member);
  if (name === undefined || !READING_MEMBER_NAMES.has(name)) {
    return false;
  }
  if (ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member)) {
    return true;
  }
  return (
    ts.isPropertyDeclaration(member) &&
    member.initializer !== undefined &&
    ts.isArrowFunction(member.initializer)
  );
}

/**
 * Whether this class holds the daemon connection.
 *
 * Read off a declared TYPE and never off a field name, so a field called something
 * else still counts and one called `bridge` holding something else does not. Both a
 * property declaration and a constructor parameter count.
 */
function holdsBridge(
  declaration: ts.ClassDeclaration,
  bindings: ReadonlyMap<string, string>,
): boolean {
  if (!boundTo(bindings, "ConsoleBridge", BRIDGE_MODULES)) {
    return false;
  }
  let found = false;
  forEachDescendant(declaration, (descendant) => {
    if (
      (ts.isPropertyDeclaration(descendant) || ts.isParameter(descendant)) &&
      descendant.type !== undefined &&
      ts.isTypeReferenceNode(descendant.type) &&
      ts.isIdentifier(descendant.type.typeName) &&
      descendant.type.typeName.text === "ConsoleBridge"
    ) {
      found = true;
    }
  });
  return found;
}

/** Whether this class constructs one of the scheduler holders, BOUND to the store. */
function constructsScheduler(node: ts.Node, bindings: ReadonlyMap<string, string>): boolean {
  let found = false;
  forEachDescendant(node, (descendant) => {
    if (
      ts.isNewExpression(descendant) &&
      ts.isIdentifier(descendant.expression) &&
      SCHEDULER_HOLDERS.includes(descendant.expression.text) &&
      boundTo(bindings, descendant.expression.text, SCHEDULER_MODULES)
    ) {
      found = true;
    }
  });
  return found;
}

/** The imported class this one extends, if it extends an imported one at all. */
function extendedBase(
  declaration: ts.ClassDeclaration,
  bindings: ReadonlyMap<string, string>,
): { readonly name: string; readonly module: string } | undefined {
  for (const heritage of declaration.heritageClauses ?? []) {
    if (heritage.token !== ts.SyntaxKind.ExtendsKeyword) {
      continue;
    }
    for (const type of heritage.types) {
      if (!ts.isIdentifier(type.expression)) {
        continue;
      }
      const module = bindings.get(type.expression.text);
      if (module !== undefined) {
        return { name: type.expression.text, module };
      }
    }
  }
  return undefined;
}

/** Census one module's classes, from its source text alone. */
export function censusClasses(displayPath: string, source: string): readonly ReadingClassCensus[] {
  const parsed = parseSourceText(displayPath, source);
  const bindings = importedModules(parsed, displayPath);
  const census: ReadingClassCensus[] = [];
  forEachDescendant(parsed, (node) => {
    if (!ts.isClassDeclaration(node) || node.name === undefined) {
      return;
    }
    const declaredMembers = new Set(
      node.members
        .map((member) => memberName(member))
        .filter((name): name is string => name !== undefined),
    );
    const base = extendedBase(node, bindings);
    census.push({
      displayPath,
      className: node.name.text,
      publishesReading: node.members.some(publishesReading),
      holdsBridge: holdsBridge(node, bindings),
      holdsScheduler: constructsScheduler(node, bindings),
      declaredMembers,
      declaresTriggerContract: declaresTriggerContract(declaredMembers),
      baseName: base?.name,
      baseModule: base?.module,
    });
  });
  return census;
}

/** The pair, asserted together: a reading declares both members or neither counts. */
function declaresTriggerContract(declaredMembers: ReadonlySet<string>): boolean {
  return TRIGGER_CONTRACT_MEMBERS.every((member) => declaredMembers.has(member));
}

/**
 * The class the `extends` clause names, found where it is DECLARED.
 *
 * The hop through the family door is part of resolving the binding rather than a
 * second one: a cross-family import goes through `index.ts` by rule, so a base reached
 * that way is published by a re-export and declared one module on.
 */
function declaringCensus(
  index: ReadonlyMap<string, ConsoleModuleText>,
  module: string,
  className: string,
  depth: number,
): ReadingClassCensus | undefined {
  if (depth > RESOLUTION_DEPTH_LIMIT) {
    return undefined;
  }
  const entry = index.get(module);
  if (entry === undefined) {
    return undefined;
  }
  const declared = censusClasses(entry.displayPath, entry.source).find(
    (candidate) => candidate.className === className,
  );
  if (declared !== undefined) {
    return declared;
  }
  const parsed = parseSourceText(entry.displayPath, entry.source);
  for (const statement of parsed.statements) {
    if (
      !ts.isExportDeclaration(statement) ||
      statement.moduleSpecifier === undefined ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }
    const clause = statement.exportClause;
    if (
      clause === undefined ||
      !ts.isNamedExports(clause) ||
      !clause.elements.some((element) => element.name.text === className)
    ) {
      continue;
    }
    const next = resolveSpecifier(entry.displayPath, statement.moduleSpecifier.text);
    const found =
      next === undefined ? undefined : declaringCensus(index, next, className, depth + 1);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

/**
 * One class read together with what it extends.
 *
 * A subclass inherits its base's scheduler, its published reading, and whichever
 * trigger members the base declares, so the census the rule is applied to is the
 * union — and a controller that hoisted its pass-throughs onto a base stays as much a
 * subject of this gate as when it wrote them out.
 */
export function withInheritance(
  entry: ReadingClassCensus,
  index: ReadonlyMap<string, ConsoleModuleText>,
  depth = 0,
): ReadingClassCensus {
  const { baseName, baseModule } = entry;
  if (baseName === undefined || baseModule === undefined || depth > RESOLUTION_DEPTH_LIMIT) {
    return entry;
  }
  const declared = declaringCensus(index, baseModule, baseName, 0);
  if (declared === undefined) {
    return entry;
  }
  const base = withInheritance(declared, index, depth + 1);
  const declaredMembers = new Set([...entry.declaredMembers, ...base.declaredMembers]);
  return {
    ...entry,
    publishesReading: entry.publishesReading || base.publishesReading,
    holdsBridge: entry.holdsBridge || base.holdsBridge,
    holdsScheduler: entry.holdsScheduler || base.holdsScheduler,
    declaredMembers,
    declaresTriggerContract: declaresTriggerContract(declaredMembers),
  };
}

/** The classes the rule speaks about: they publish a reading AND they hold the wire. */
export function readingsIn(census: readonly ReadingClassCensus[]): readonly ReadingClassCensus[] {
  return census.filter((entry) => entry.publishesReading && entry.holdsBridge);
}

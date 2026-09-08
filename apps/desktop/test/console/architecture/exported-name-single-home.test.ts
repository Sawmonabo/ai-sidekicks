// One name, one home — the two shapes of that rule a parse can actually decide.
//
// `apps/desktop/AGENTS.md` §Shared code: "A helper used by two modules is hoisted on the
// second use. Never write it twice." Two audits found the same defect wearing two
// disguises, and neither had a mechanism.
//
// THE FIRST IS A HOOK NAME. Two modules exported `useSettlementAnnouncement` — the
// primitive taking one sentence, and the sidebar's taking three arguments and holding a
// second copy of the primitive's own announce-once latch. A reader who followed the name
// landed in whichever file their editor offered, and the two contracts disagreed about
// what the argument even was. A hook is the shape where this bites hardest: it is the
// unit a family imports by name across the DAG, and the console exports 250-odd of them,
// so a collision is a fork of a contract rather than a coincidence of vocabulary.
//
// THE SECOND IS A LITERAL WRITTEN TWICE IN ONE DIRECTORY. `CREATED_SESSION_ID` and
// `PARTICIPANT_ID` were each declared byte-identically by two sibling scaffolding
// modules, neither importing the other. That is the duplication the rule names exactly:
// two spellings of one fixture, and the day one moves the gate stays green while two
// suites answer for two different people.
//
// WHY THESE TWO SCOPES AND NOT "no exported name twice". Measured before it was written:
// the console's production modules carry 34 name collisions over 5,466 exported names,
// and most are deliberate — `Body` is fixed by `seats/lazy-body.ts` so every loader
// composes one specifier shape, and each fixture cast names the participants its own
// scenario seats. A gate quantified over all of them would be a gate with a long
// exemption list, which is a second home for the very decision it is meant to make. The
// two claims here were each measured to have exactly the offenders the fixing lane
// closes, and both fail on any new one.
//
// TESTS ARE IN SCOPE FOR THE LITERAL CLAIM AND OUT FOR THE HOOK CLAIM, which is not a
// hedge: the literal defect IS a scaffolding defect — both instances were `.test-support`
// modules — while a hook a test declares is that test's own probe and duplicates nothing.
// A co-located test's private, unexported constant is out of both: a case may write
// whatever literal it asserts against, which is why this reads EXPORTS.

import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  CONSOLE_DIRECTORY,
  consoleSourceModules,
  readConsoleSourceModule,
  toPosixSeparators,
} from "../console-source-modules.js";
import { parseSourceText } from "../typescript-source.js";

/** A floor under each scan, so a walk that reached nothing cannot pass by vacuity. */
const FEWEST_CONSOLE_MODULES = 400;

/** One exported declaration, as this gate compares them. */
interface ExportedDeclaration {
  readonly name: string;
  /** The initializer's own source text, for a literal; `undefined` for anything else. */
  readonly literalText: string | undefined;
  readonly displayPath: string;
}

/** Whether a name is a React hook, by the one rule React itself enforces. */
function isHookName(name: string): boolean {
  return /^use[A-Z]/u.test(name);
}

/** Every name one binding introduces, destructuring patterns included. */
function boundNamesOf(name: ts.BindingName, into: string[]): void {
  if (ts.isIdentifier(name)) {
    into.push(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) {
      boundNamesOf(element.name, into);
    }
  }
}

/**
 * Whether a statement carries `export`.
 *
 * Asked of the modifiers rather than of the text, because `export const` on one line is
 * one of four spellings a declaration takes and the other three are what a text scan
 * misses — the very class `typescript-source.ts` exists to end.
 */
function isExported(statement: ts.Statement): boolean {
  return (
    ts.canHaveModifiers(statement) &&
    ts
      .getModifiers(statement)
      ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true
  );
}

/** Every exported declaration one module makes, paired with its literal where it has one. */
function exportedDeclarationsIn(
  displayPath: string,
  sourceText: string,
): readonly ExportedDeclaration[] {
  const parsed = parseSourceText(displayPath, sourceText);
  const declarations: ExportedDeclaration[] = [];
  for (const statement of parsed.statements) {
    if (!isExported(statement)) {
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const names: string[] = [];
        boundNamesOf(declaration.name, names);
        const initializer = declaration.initializer;
        const literalText =
          initializer !== undefined &&
          (ts.isStringLiteralLike(initializer) || ts.isNumericLiteral(initializer))
            ? initializer.getText(parsed)
            : undefined;
        for (const name of names) {
          declarations.push({ name, literalText, displayPath });
        }
      }
      continue;
    }
    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name !== undefined
    ) {
      declarations.push({ name: statement.name.text, literalText: undefined, displayPath });
    }
  }
  return declarations;
}

/**
 * A barrel declares nothing, so it is not a home.
 *
 * A door's whole job is to re-export a name its family declared elsewhere, and counting
 * that as a second declaration would report every published symbol in the console.
 */
function isDoor(displayPath: string): boolean {
  return displayPath.endsWith("/index.ts");
}

/** The directory a display path sits in, spelled the one way this tier spells paths. */
function directoryOf(displayPath: string): string {
  const posixPath = toPosixSeparators(displayPath);
  return posixPath.slice(0, posixPath.lastIndexOf("/"));
}

/** Every exported declaration the claim is quantified over, read once. */
function scanConsole(options: { readonly tests: boolean }): readonly ExportedDeclaration[] {
  const modules = consoleSourceModules({
    roots: [CONSOLE_DIRECTORY],
    tests: options.tests,
  }).filter((module) => !isDoor(toPosixSeparators(module.displayPath)));
  expect(modules.length).toBeGreaterThan(FEWEST_CONSOLE_MODULES);
  return modules.flatMap((module) =>
    exportedDeclarationsIn(module.displayPath, readConsoleSourceModule(module)),
  );
}

/** Which modules declare each hook name, over the declarations given. */
function hookHomes(
  declarations: readonly ExportedDeclaration[],
): ReadonlyMap<string, readonly string[]> {
  const homes = new Map<string, string[]>();
  for (const declaration of declarations) {
    if (!isHookName(declaration.name)) {
      continue;
    }
    homes.set(declaration.name, [...(homes.get(declaration.name) ?? []), declaration.displayPath]);
  }
  return homes;
}

/** Which modules declare each `<directory>::<name>=<literal>` triple. */
function literalHomes(
  declarations: readonly ExportedDeclaration[],
): ReadonlyMap<string, readonly string[]> {
  const homes = new Map<string, string[]>();
  for (const declaration of declarations) {
    if (declaration.literalText === undefined) {
      continue;
    }
    const key = `${directoryOf(declaration.displayPath)} :: ${declaration.name} = ${declaration.literalText}`;
    homes.set(key, [...(homes.get(key) ?? []), declaration.displayPath]);
  }
  return homes;
}

/** The offenders a map holds, as the sentences a failure prints. */
function collisionsIn(homes: ReadonlyMap<string, readonly string[]>): readonly string[] {
  return [...homes]
    .filter(([, declaredBy]) => declaredBy.length > 1)
    .map(([subject, declaredBy]) => `${subject} — declared by ${declaredBy.join(", ")}`)
    .sort();
}

describe("exported hooks have one home", () => {
  it("no two console modules export the same hook name", () => {
    const homes = hookHomes(scanConsole({ tests: false }));
    // Non-vacuity: the console really does export hooks, so an empty map would be a
    // walk that read nothing rather than a tree that collides nowhere.
    expect(homes.size).toBeGreaterThan(100);
    expect(collisionsIn(homes)).toStrictEqual([]);
  });

  it("negative control: two modules exporting one hook name are both reported", () => {
    // The shape the sidebar and the primitive were in — same name, different arity —
    // driven through the real reader so what is proven is that THIS parse reports it.
    const planted = [
      ...exportedDeclarationsIn(
        "console/primitives/settlement-announcement.ts",
        "export function useSettlementAnnouncement(sentence: string | undefined): void {}\n",
      ),
      ...exportedDeclarationsIn(
        "console/workspace/sidebar/sidebar-column-reads.ts",
        "export function useSettlementAnnouncement(a: object, b: object, c: () => void): void {}\n",
      ),
    ];

    expect(collisionsIn(hookHomes(planted))).toStrictEqual([
      "useSettlementAnnouncement — declared by console/primitives/settlement-announcement.ts, console/workspace/sidebar/sidebar-column-reads.ts",
    ]);
  });

  it("negative control: a name that is not a hook is not the subject of this claim", () => {
    // Without this the gate would be the all-names census the header rejects, and the
    // deliberate `Body` convention would fail it on seventeen modules.
    const planted = [
      ...exportedDeclarationsIn(
        "console/ledger/pane/timeline-pane-body.ts",
        "export function Body(): null { return null; }\n",
      ),
      ...exportedDeclarationsIn(
        "console/runs/pane/runs-pane-body.ts",
        "export function Body(): null { return null; }\n",
      ),
    ];

    expect(collisionsIn(hookHomes(planted))).toStrictEqual([]);
  });
});

describe("an exported literal is written once per directory", () => {
  it("no two modules in one directory export the same name with the same literal", () => {
    const homes = literalHomes(scanConsole({ tests: true }));
    // Non-vacuity: the tree is full of exported fixture literals, so an empty map means
    // the parse found no initializers rather than no duplicates.
    expect(homes.size).toBeGreaterThan(100);
    expect(collisionsIn(homes)).toStrictEqual([]);
  });

  it("negative control: one id written twice in one directory is reported", () => {
    // Exactly what `workspace/new-session/` carried: two sibling scaffolding modules,
    // the same name, the same value, neither importing the other.
    const declaration =
      'export const CREATED_SESSION_ID = "019b793b-7b60-75e5-8510-ada11a5ac0de";\n';
    const planted = [
      ...exportedDeclarationsIn(
        "console/workspace/new-session/new-session-draft.test-support.ts",
        declaration,
      ),
      ...exportedDeclarationsIn(
        "console/workspace/new-session/NewSessionControl.test-support.tsx",
        declaration,
      ),
    ];

    expect(collisionsIn(literalHomes(planted))).toStrictEqual([
      'console/workspace/new-session :: CREATED_SESSION_ID = "019b793b-7b60-75e5-8510-ada11a5ac0de" — declared by console/workspace/new-session/new-session-draft.test-support.ts, console/workspace/new-session/NewSessionControl.test-support.tsx',
    ]);
  });

  it("negative control: one name carrying two different values is two facts, not one copy", () => {
    // `sessions/acts/` names its own created session, and it is a different session. A
    // gate keyed on the name alone would call that a duplicate and be wrong about it;
    // this one is keyed on the value as well, which is what "written twice" means.
    const planted = [
      ...exportedDeclarationsIn(
        "console/workspace/new-session/new-session-draft.test-support.ts",
        'export const CREATED_SESSION_ID = "019b793b-7b60-75e5-8510-ada11a5ac0de";\n',
      ),
      ...exportedDeclarationsIn(
        "console/workspace/new-session/other.test-support.ts",
        'export const CREATED_SESSION_ID = "7f3c1a2b-4d5e-4f60-8a71-9c2d3e4f5061";\n',
      ),
    ];

    expect(collisionsIn(literalHomes(planted))).toStrictEqual([]);
  });
});

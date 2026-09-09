// One fold under every surface mount, and the gate that keeps it the only one.
//
// WHY A CHOKEPOINT AND NOT A CONVENTION. A `SessionStore` takes its projector table at
// construction, and that table decides which partitions everything mounted over the
// store can read. A family mount that names its own registrars is therefore choosing
// its surface's readable state — and the choice is invisible in review, because a
// partition nobody projected renders exactly like a partition with nothing in it. The
// composer family's approvals mount registered the approval-flow fold alone: the
// `approval` partition folded, the `run` partition did not, and the pane's Execution
// boundary section rendered "Execution boundary unknown" for a run the fixture stamps a
// posture on. Both tiers that mount it passed — the accessibility tier because an
// absence is as auditable as a chip, the screenshot tier because it minted that frame
// as its committed reference.
//
// AN OMITTED ARGUMENT IS THE SAME DEFECT. `projectors` is optional on both store
// constructors, and four other mounts opened stores without it, so every event they
// applied folded into no entity at all. A rule stated only as "do not hand-pick a
// subset" would call the empty set compliant.
//
// SO THE RULE IS TWO CLAIMS OVER `test/console/surfaces/`: no module there reaches a
// projector registrar, and every store it opens names the one composition
// (`surfaces/projector-composition.ts`, which runs `registerConsoleFamilies` into
// boards it owns). The composition module needs no exemption from the first claim —
// it reaches the window's composition root, not a registrar — which is what makes the
// rule stateable without a list of admitted file names.
//
// THE INSTRUMENT IS THE PARSER, on `capture-chokepoint.test.ts`'s reason: the prose
// above names a registrar and the constant several times, and the composition module's
// own header names the registrar this rule exists to keep out. A text scan reports
// every one of them.
//
// THE WALK IS THE TIER'S, never a `readdirSync` of this file's own —
// `source-walk-chokepoint.test.ts` next door fails a gate in this directory that walks
// a tree itself, because a claim is only as good as the set it quantifies over.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  consoleSourceModules,
  readConsoleSourceModule,
  toPosixSeparators,
} from "../console-source-modules.js";
import { forEachDescendant, parseSourceText } from "../typescript-source.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SURFACES_DIRECTORY = resolve(HERE, "..", "surfaces");

/** The one module the mounts take their fold from, as this file's walk names it. */
const FOLD_COMPOSITION_MODULE = "surfaces/projector-composition.ts";

/** A family mount, named the same way, so a wrong root cannot look like a clean tree. */
const A_FAMILY_MOUNT = "surfaces/composer.tsx";

/** The name every store opening has to reach the composition through. */
const COMPOSED_FOLD_IDENTIFIER = "COMPOSED_CONSOLE_PROJECTORS";

/**
 * The constructors that take a projector table and hand it to the stores they open.
 *
 * Both, because they are the same claim at two scopes: `SessionStore` folds one
 * session's events, and `SessionStoreRegistry` hands its table to every store it opens
 * later. A rule naming only the first passes a surface that opens its sessions through
 * the second.
 */
const FOLD_TAKING_CONSTRUCTORS: readonly string[] = ["SessionStore", "SessionStoreRegistry"];

/** One store opening, and whether it reaches the shared fold. */
interface StoreOpening {
  readonly constructorName: string;
  readonly line: number;
  readonly reachesComposedFold: boolean;
}

/** The trailing name of a callee, whether it is bare or reached through a receiver. */
function calleeName(callee: ts.Expression): string | undefined {
  if (ts.isIdentifier(callee)) {
    return callee.text;
  }
  if (ts.isPropertyAccessExpression(callee)) {
    return callee.name.text;
  }
  return undefined;
}

/** Whether a name is one of the projector registrars a family exports. */
function isProjectorRegistrar(name: string): boolean {
  return name.startsWith("register") && name.endsWith("Projectors");
}

/**
 * Every line in one module that CALLS a projector registrar.
 *
 * A pure function over text, so the controls at the foot of this file can drive it with
 * inputs whose verdict is known rather than by perturbing a real mount.
 */
export function projectorRegistrarCallLines(source: string, fileName: string): readonly number[] {
  const parsed = parseSourceText(fileName, source);
  const lines: number[] = [];
  forEachDescendant(parsed, (node) => {
    if (!ts.isCallExpression(node)) {
      return;
    }
    const name = calleeName(node.expression);
    if (name === undefined || !isProjectorRegistrar(name)) {
      return;
    }
    lines.push(parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1);
  });
  return lines;
}

/** Whether `node` or anything under it names the shared fold. */
function reachesComposedFold(node: ts.Node): boolean {
  if (ts.isIdentifier(node) && node.text === COMPOSED_FOLD_IDENTIFIER) {
    return true;
  }
  let found = false;
  forEachDescendant(node, (descendant) => {
    if (ts.isIdentifier(descendant) && descendant.text === COMPOSED_FOLD_IDENTIFIER) {
      found = true;
    }
  });
  return found;
}

/**
 * Every fold-taking store this module opens, and whether each reaches the composition.
 *
 * The ARGUMENTS are read rather than the surrounding function, because the table is
 * passed at construction: a store opened inside a helper that happens to mention the
 * constant elsewhere is still opened with whatever it was handed.
 *
 * Every opening is returned rather than only the offending ones, so the populated-set
 * claim and the offence claim read the same walk — a reader that matched no
 * construction at all would otherwise report zero offences and look clean.
 */
export function storeOpenings(source: string, fileName: string): readonly StoreOpening[] {
  const parsed = parseSourceText(fileName, source);
  const openings: StoreOpening[] = [];
  forEachDescendant(parsed, (node) => {
    if (!ts.isNewExpression(node) || !ts.isIdentifier(node.expression)) {
      return;
    }
    const constructorName = node.expression.text;
    if (!FOLD_TAKING_CONSTRUCTORS.includes(constructorName)) {
      return;
    }
    openings.push({
      constructorName,
      line: parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1,
      reachesComposedFold: (node.arguments ?? []).some((argument) => reachesComposedFold(argument)),
    });
  });
  return openings;
}

/** Every module under `test/console/surfaces/`, with its text, through the tier's walk. */
function surfaceModuleSources(): readonly { readonly path: string; readonly text: string }[] {
  return consoleSourceModules({ roots: [SURFACES_DIRECTORY], tests: true }).map((module) => ({
    path: `surfaces/${toPosixSeparators(module.relativePath)}`,
    text: readConsoleSourceModule(module),
  }));
}

describe("surface mounts open every store with the composed console fold", () => {
  const sources = surfaceModuleSources();
  const openings = sources.flatMap((source) =>
    storeOpenings(source.text, source.path).map((opening) => ({ ...opening, path: source.path })),
  );

  it("finds the mount directory, and finds stores being opened in it", () => {
    // Without this a wrong root would scan an empty set and both claims below would be
    // satisfied by nothing at all. The two names are one per class the rule covers: a
    // family mount, and the composition every family mount reaches through.
    expect(sources.map((source) => source.path)).toEqual(
      expect.arrayContaining([A_FAMILY_MOUNT, FOLD_COMPOSITION_MODULE]),
    );
    expect(openings.length, "the walk found no store opening at all").toBeGreaterThan(3);
  });

  it("reaches no projector registrar from any mount", () => {
    const offenders = sources.flatMap((source) =>
      projectorRegistrarCallLines(source.text, source.path).map(
        (line) => `${source.path}:${String(line)}`,
      ),
    );
    expect(offenders).toStrictEqual([]);
  });

  it("opens no store without the composed fold", () => {
    const offenders = openings
      .filter((opening) => !opening.reachesComposedFold)
      .map(
        (opening) =>
          `${opening.path}:${String(opening.line)} new ${opening.constructorName}() takes no ${COMPOSED_FOLD_IDENTIFIER}`,
      );
    expect(offenders).toStrictEqual([]);
  });

  it("keeps that fold in exactly one module, which the mounts share", () => {
    // The other half of "one composition": the claim above is also satisfied by every
    // mount declaring a constant of that name for itself, which is the same defect
    // wearing the rule's own vocabulary.
    const declaring = sources.filter((source) =>
      source.text.includes(`export const ${COMPOSED_FOLD_IDENTIFIER}`),
    );
    expect(declaring.map((source) => source.path)).toStrictEqual([FOLD_COMPOSITION_MODULE]);
  });
});

describe("the surface-fold readers, against planted text", () => {
  // The shape this rule exists to catch: the mount that picks its own partitions.
  it("reports a hand-picked projector registrar", () => {
    expect(
      projectorRegistrarCallLines(
        "const registry = new ConsoleEntityProjectorRegistry();\nregisterApprovalFlowProjectors(registry);",
        "planted.ts",
      ),
    ).toStrictEqual([2]);
  });

  // Reached through a receiver rather than bare, which is the same act.
  it("reports a registrar reached through a receiver", () => {
    expect(
      projectorRegistrarCallLines("families.registerRunLifecycleProjectors(board);", "planted.ts"),
    ).toStrictEqual([1]);
  });

  // A mention is not a call, which is why this gate parses: the header above names a
  // registrar four times, and `projector-composition.ts` names one in its own prose.
  it("mints no offence from a registrar named in a comment or a string", () => {
    expect(
      projectorRegistrarCallLines(
        '// call registerApprovalFlowProjectors here\nconst name = "registerRunLifecycleProjectors";\n',
        "planted.ts",
      ),
    ).toStrictEqual([]);
  });

  // The composition root is not a registrar, and needs no exemption to be admitted.
  it("admits the window's own composition", () => {
    expect(
      projectorRegistrarCallLines(
        "registerConsoleFamilies(surfaces, panes, projectors, sidebar, cards);",
        "planted.ts",
      ),
    ).toStrictEqual([]);
  });

  // The omitted-argument arm, which a subset-only rule would call compliant.
  it("reports a store opened with no fold at all", () => {
    expect(
      storeOpenings('const store = new SessionStore({ sessionId: "s" });', "planted.ts"),
    ).toStrictEqual([{ constructorName: "SessionStore", line: 1, reachesComposedFold: false }]);
  });

  // The subset arm: a real table, and not the composed one.
  it("reports a store opened with a hand-picked fold", () => {
    expect(
      storeOpenings(
        "const store = new SessionStore({ sessionId, projectors: RUN_LIFECYCLE_PROJECTORS });",
        "planted.ts",
      ),
    ).toStrictEqual([{ constructorName: "SessionStore", line: 1, reachesComposedFold: false }]);
  });

  // The registry arm, which hands its table to every store it opens later.
  it("reports a registry opened with no fold", () => {
    expect(
      storeOpenings(
        "const registry = new SessionStoreRegistry({ read: () => Promise.resolve(undefined) });",
        "planted.ts",
      ),
    ).toStrictEqual([
      { constructorName: "SessionStoreRegistry", line: 1, reachesComposedFold: false },
    ]);
  });

  // The positive half. Without it the cases above are ambiguous between "the reader
  // reads the arguments" and "the reader says no to everything".
  it("admits both constructors once they name the composed fold", () => {
    const composed = [
      "const store = new SessionStore({",
      "  sessionId: scenario.sessionId,",
      "  projectors: COMPOSED_CONSOLE_PROJECTORS,",
      "});",
      "const registry = new SessionStoreRegistry({",
      "  read: () => Promise.resolve(undefined),",
      "  projectors: COMPOSED_CONSOLE_PROJECTORS,",
      "});",
    ].join("\n");
    expect(
      storeOpenings(composed, "composed.ts").map((opening) => opening.reachesComposedFold),
    ).toStrictEqual([true, true]);
  });

  // The line the constructor list draws. A registry that takes no fold is not a store
  // opening, so demanding one of it would make the rule unsatisfiable rather than
  // stricter — `projector-composition.ts` builds four of them.
  it("reports no opening from a construction that takes no fold", () => {
    expect(
      storeOpenings(
        "const board = new ConsoleEntityProjectorRegistry();\nconst panes = new ConsolePaneRegistry();",
        "planted.ts",
      ),
    ).toStrictEqual([]);
  });
});

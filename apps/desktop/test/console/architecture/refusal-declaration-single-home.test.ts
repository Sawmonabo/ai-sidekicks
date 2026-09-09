// One home for every refusal name the console declares.
//
// `apps/desktop/AGENTS.md` §Shared code says "A helper used by two modules is hoisted
// on the second use. Never write it twice", and refusal composition is where that rule
// was broken twice at once. `bannerClassRefusalAmong` was declared in `store/` and
// again in the approvals pane's read fold, under one name, with two different
// selection rules — so which rule a call site got depended on which import it happened
// to write, and one file imported BOTH. `unreadableDeliveryRefusal` was declared in
// `bridge/queue/` and again in `bridge/quotas/`, character-for-character apart from
// the origin and the noun, with the second file's own header admitting the copy.
//
// NEITHER WAS REPORTABLE BY THE GATES THIS PACKAGE ALREADY RUNS. knip asks whether an
// export is REACHED and both were; dependency-cruiser asks whether an import is
// ALLOWED and both were; the barrel census asks whether a door line has a reader and
// neither name was on a door twice. A second declaration of one name is invisible to
// all three, and it is the shape a refusal vocabulary drifts through: two spellings of
// one fact, each green.
//
// WHY THE VOCABULARY IS `refusal` AND NOT A ROSTER OF THE TWO NAMES. A gate scoped to
// the names that already went wrong reports nothing the day a third does. Every
// refusal this console composes, selects, or classifies says so in its identifier —
// that is the naming rule `.claude/rules/coding-standards.md` states and this tree
// keeps — so the word is the subject, and the claim is that no console module declares
// a refusal name another console module already declares.
//
// VALUES ONLY, AND THAT LINE IS DELIBERATE. A type and a value may share a name in
// TypeScript because they occupy different declaration spaces, and this tree uses that
// idiom: `repos/artifacts/artifact-refusal-copy.ts` declares the INTERFACE
// `ArtifactRefusalRecovery` and `ArtifactRefusalRecovery.tsx` declares the COMPONENT,
// which imports the type under an alias precisely because the two are distinct. A gate
// that counted both spaces together would report that pair and be wrong about it.
//
// A DECLARATION IS A PARSE QUESTION, SO THE PARSER ANSWERS IT, per this tier's rule and
// `test/console/typescript-source.ts`' reason: a pattern cannot see a declaration
// boundary, and `export const { X } = Y`, a name Prettier wrapped onto its own line,
// and a mention inside a comment all read alike to one.
//
// Test files are excluded by the shared walk, which is the exemption this needs: the
// negative controls below have to be able to write the thing the rule forbids.

import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  CONSOLE_DIRECTORY,
  consoleRelativePaths,
  consoleSourceModules,
  readConsoleSourceModule,
} from "../console-source-modules.js";
import { boundNamesOf, parseSourceText } from "../typescript-source.js";

/**
 * The word that makes an identifier this gate's business.
 *
 * A plain containment test rather than a token split: no English word carries
 * "refusal" as a proper part of a longer word, so there is no `CAPABILITIES`-shaped
 * false positive for a token rule to exclude here.
 */
const REFUSAL_WORD = "refusal";

/**
 * Every refusal-named VALUE `source` declares at its top level, in declaration order.
 *
 * A pure function over text rather than a loop inside a case, so the controls below
 * can drive it with a module body whose verdict is known and prove the checker bites
 * without planting a violation in the tree.
 *
 * Top level only. A refusal-named local inside a function body is that function's, and
 * two functions in two modules holding one named local is not a second home for
 * anything — it is two callers reading the same answer.
 */
function declaredRefusalNames(fileName: string, source: string): readonly string[] {
  const parsed = parseSourceText(fileName, source);
  const declared: string[] = [];
  for (const statement of parsed.statements) {
    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
      if (statement.name !== undefined) {
        declared.push(statement.name.text);
      }
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        boundNamesOf(declaration.name, declared);
      }
    }
  }
  return declared.filter((name) => name.toLowerCase().includes(REFUSAL_WORD));
}

/** One refusal name and every console module that declares it, in scan order. */
interface RefusalNameHomes {
  readonly name: string;
  readonly modules: readonly string[];
}

/** Every refusal name the console declares, paired with the modules declaring it. */
function refusalNameHomes(): readonly RefusalNameHomes[] {
  const modules = consoleSourceModules({ roots: [CONSOLE_DIRECTORY] });
  const paths = consoleRelativePaths(modules);
  const homes = new Map<string, string[]>();
  modules.forEach((module, index) => {
    for (const name of declaredRefusalNames(module.displayPath, readConsoleSourceModule(module))) {
      const declaringModules = homes.get(name) ?? [];
      declaringModules.push(paths[index] ?? module.displayPath);
      homes.set(name, declaringModules);
    }
  });
  return [...homes].map(([name, declaringModules]) => ({ name, modules: declaringModules }));
}

describe("console refusals — every refusal name is declared in one module", () => {
  const homes = refusalNameHomes();

  it("finds refusal names to scan at all", () => {
    // Without this a wrong console directory, a broken walk, or a parse that returned
    // nothing would scan an empty tree and the assertion below would pass over it.
    expect(homes.length).toBeGreaterThan(100);
    expect(homes.map((home) => home.name)).toContain("preferredBannerClassRefusalAmong");
    expect(homes.map((home) => home.name)).toContain("unreadableDeliveryRefusalComposerFor");
  });

  it("declares no refusal name in two modules", () => {
    const secondHomes = homes
      .filter((home) => home.modules.length > 1)
      .map((home) => `${home.name}: ${home.modules.join(" | ")}`);
    expect(secondHomes).toStrictEqual([]);
  });

  it("negative control: it catches the selector that was declared twice", () => {
    // The approvals pane's copy, reduced to its declaration. Run against the reader
    // rather than against a planted file, so the case states what would fail without
    // writing the violation back into the tree.
    const paneCopy = [
      "export function bannerClassRefusalAmong(",
      "  candidates: readonly (ConsoleRefusal | undefined)[],",
      "): ConsoleRefusal | undefined {",
      "  return candidates.find(",
      "    (candidate) =>",
      '      candidate !== undefined && refusalRemedyFor(candidate.code)?.rendering === "banner",',
      "  );",
      "}",
    ].join("\n");
    expect(declaredRefusalNames("approvals/pane/body/approvals-read-fold.ts", paneCopy)).toContain(
      "bannerClassRefusalAmong",
    );
  });

  it("negative control: it catches the composer that was written out twice", () => {
    // The quotas copy of the queue's composer, which differed in the origin and the
    // noun and in nothing else.
    const quotasCopy = [
      "export function unreadableDeliveryRefusal(issues: UnreadableDeliveryIssues): ConsoleRefusal {",
      "  return refuse(PROVIDER_QUOTA_REFUSAL_ORIGIN, 'delivery-unreadable', 'x');",
      "}",
    ].join("\n");
    expect(declaredRefusalNames("bridge/quotas/provider-quota-refusals.ts", quotasCopy)).toContain(
      "unreadableDeliveryRefusal",
    );
  });

  it("negative control: it reads the shapes a pattern would read past", () => {
    // Each of these declares a refusal name, and none of them writes one on a line a
    // `^export (function|const) <name>` pattern would match. They are why the reader
    // is a parse.
    expect(
      declaredRefusalNames(
        "clause.ts",
        [
          "const bannerClassRefusalAmong = () => undefined;",
          "export { bannerClassRefusalAmong };",
        ].join("\n"),
      ),
    ).toStrictEqual(["bannerClassRefusalAmong"]);
    expect(
      declaredRefusalNames("pattern.ts", "export const { unreadableDeliveryRefusal } = composers;"),
    ).toStrictEqual(["unreadableDeliveryRefusal"]);
    expect(
      declaredRefusalNames(
        "wrapped.ts",
        ["export const", "  queueDeliveryRefusal: Composer =", "  composerFor(stream);"].join("\n"),
      ),
    ).toStrictEqual(["queueDeliveryRefusal"]);
  });

  it("negative control: a refusal-named local is not a declaration this gate counts", () => {
    // Two panes may both hold `const bannerRefusal = …` inside a hook body, and that
    // is two readers of one answer rather than two homes for one rule. Without this
    // the gate would report every such pair and would have to be exempted into
    // uselessness.
    const insideAFunction = [
      "export function usePaneRefusalHandover(): void {",
      "  const bannerRefusal = preferredBannerClassRefusalAmong(refusals);",
      "  raise(bannerRefusal);",
      "}",
    ].join("\n");
    expect(declaredRefusalNames("pane.ts", insideAFunction)).toStrictEqual([
      "usePaneRefusalHandover",
    ]);
  });

  it("negative control: a type and a value may share one refusal name", () => {
    // `artifact-refusal-copy.ts` declares the interface and `ArtifactRefusalRecovery.tsx`
    // the component; the component file imports the type under an alias because the two
    // are genuinely distinct. A gate reading both declaration spaces would report that
    // pair, so this pins the value-only line.
    expect(
      declaredRefusalNames(
        "copy.ts",
        "export interface ArtifactRefusalRecovery extends RefusalRecoveryCopy {}",
      ),
    ).toStrictEqual([]);
  });
});

// Every settings page is a projection.
//
// `Spec-023 §Console Design (Meridian)`'s settings sections put the same two
// obligations on every page: a page renders what a wire says and derives no
// eligibility of its own, and no page renders a credential-bearing value. Both are
// invisible to the type system and both go wrong quietly — a renderer that decides
// a control is unavailable becomes a second authority on a question the daemon
// answers, and a page that prints a token has already leaked it by the time anyone
// reads the diff.
//
// SOURCE TEXT, NOT MOUNTED PAGES. The architecture tier reads modules as text and
// imports no console module, for its siblings' reason: the claim is about what the
// tree may CONTAIN, and a mounted page can only ever demonstrate the paths one
// fixture happened to take.
//
// WHERE THE LINE IS DRAWN, and why it is drawn there:
//
//   • **Eligibility.** The signature is a page deciding, from wire data, that a
//     control may not be used — a `disabled` computed from a role, a permission, or
//     a state name. A page may still disable a control while its OWN write is in
//     flight, which is a fact about this window rather than about authority, so the
//     check reads the operands rather than the word: a page naming a role, a
//     permission, a policy, or a `canEdit`-shaped predicate is deriving eligibility,
//     and so is a `disabled` computed from a wire state name — the third operand the
//     retired signature list carried no form of at all.
//   • **Credentials.** The console's bridge contract already forbids auth material
//     structurally, so the residual risk is a page inventing a field name and
//     rendering it. The needles are the same family the contracts package's own
//     negative type-test flattens.

// THE QUESTION IS A DECLARATION QUESTION, SO THE PARSER ANSWERS IT. This gate used
// to be `source.includes(signature)` over the whole module, comments included — so a
// page whose header prose read "the daemon decides whether the caller's role permits
// this" turned the gate red on a sentence, which is exactly how a pinned count gets
// raised to fix a test, and the failure `daemon-call-census.ts` records having
// already happened once. `test/console/typescript-source.ts` exists for this class:
// a regular expression cannot see a declaration boundary and every question asked
// here is about one. Comments carry no AST node, so prose is out of scope by
// construction rather than by a stripping pass that would have its own edge cases.

import { describe, expect, it } from "vitest";

import ts from "typescript";

import {
  CONSOLE_DIRECTORY,
  consoleSourceModules,
  moduleNamed,
  readConsoleSourceModule,
  type ConsoleSourceModule,
} from "../console-source-modules.js";
import { forEachDescendant, parseSourceText } from "../typescript-source.js";

/** The prefix a settings module's display path carries. */
const SETTINGS_PREFIX = "console/settings/";

/**
 * Names that are an eligibility decision wherever they appear in an expression.
 *
 * Each one is a predicate a page would have to compute for itself, and none of them
 * has a second meaning in a renderer — which is why these are matched as bare names
 * while `role` and `state` are matched only inside a comparison. `role` alone is an
 * ARIA attribute this console writes on ordinary elements, and a gate that flagged
 * the read would forbid accessible markup to catch an authority check.
 */
const ELIGIBILITY_PREDICATE_NAMES: readonly string[] = [
  "canEdit",
  "canManage",
  "canWrite",
  "isOwner",
  "isAdmin",
  "hasPermission",
  "cedar",
];

/** Operands that are an eligibility decision when a page COMPARES them. */
const ELIGIBILITY_COMPARISON_OPERANDS: readonly string[] = ["role", "permission", "permissions"];

/**
 * Field names that carry authentication material, in the shapes a renderer could
 * invent. The same family the preload contract's negative type-test flattens.
 */
const CREDENTIAL_SIGNATURES: readonly string[] = [
  "sessionToken",
  "accessToken",
  "refreshToken",
  "bearer",
  "dpop",
  "prfOutput",
  "apiKey",
  "clientSecret",
];

/** The two comparison operators an eligibility check is written with. */
const EQUALITY_OPERATORS: readonly ts.SyntaxKind[] = [
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
];

/** The name a node contributes to the census, or `undefined` where it names nothing. */
function namedIdentifierOf(node: ts.Node): string | undefined {
  if (ts.isPropertyAccessExpression(node)) {
    return node.name.text;
  }
  if (ts.isIdentifier(node)) {
    return node.text;
  }
  return undefined;
}

/** Whether `node` is an equality comparison naming one of `operands` on either side. */
function comparesOneOf(node: ts.Node, operands: readonly string[]): boolean {
  if (!ts.isBinaryExpression(node) || !EQUALITY_OPERATORS.includes(node.operatorToken.kind)) {
    return false;
  }
  const left = namedIdentifierOf(node.left);
  const right = namedIdentifierOf(node.right);
  return operands.some((operand) => left === operand || right === operand);
}

/** Whether `attribute` is a `disabled` computed from a compared wire state name. */
function disablesOnAStateName(attribute: ts.Node): boolean {
  if (!ts.isJsxAttribute(attribute)) {
    return false;
  }
  // The name node's own text, never `getText()`: the shared parse runs with
  // `setParentNodes` off, so a node cannot climb to the source file it came from.
  if (!ts.isIdentifier(attribute.name) || attribute.name.text !== "disabled") {
    return false;
  }
  let derivesFromState = false;
  forEachDescendant(attribute, (descendant) => {
    if (comparesOneOf(descendant, ["state"])) {
      derivesFromState = true;
    }
  });
  return derivesFromState;
}

/**
 * Every signature `source` carries, or `[]`.
 *
 * A pure function over text so the negative controls can drive it with strings whose
 * verdict is known, proving the checker bites without perturbing a module — and over
 * a PARSE of that text, so a needle in prose is not a finding and a needle split
 * across a wrapped expression still is.
 */
function projectionViolations(source: string, fileName = "settings-page.tsx"): readonly string[] {
  const parsed = parseSourceText(fileName, source);
  const found = new Set<string>();
  forEachDescendant(parsed, (node) => {
    const name = namedIdentifierOf(node);
    if (name !== undefined && ELIGIBILITY_PREDICATE_NAMES.includes(name)) {
      found.add(name);
    }
    if (name !== undefined && CREDENTIAL_SIGNATURES.includes(name)) {
      found.add(name);
    }
    if (comparesOneOf(node, ELIGIBILITY_COMPARISON_OPERANDS)) {
      found.add("a compared role or permission");
    }
    if (disablesOnAStateName(node)) {
      found.add("a disabled computed from a state name");
    }
  });
  return [...found].sort();
}

/**
 * Every settings module, through the one walk every source-text gate shares.
 *
 * The console root alone rather than both, because this claim is about the settings
 * family and nothing else; the shared walk excludes co-located tests and their
 * support modules by default, which is exactly the set this gate wants.
 */
function settingsPageModules(): readonly ConsoleSourceModule[] {
  return consoleSourceModules({ roots: [CONSOLE_DIRECTORY] }).filter((module) =>
    module.displayPath.startsWith(SETTINGS_PREFIX),
  );
}

/** What a settings module is named by inside its own family. */
function nameInsideSettings(module: ConsoleSourceModule): string {
  return module.displayPath.slice(SETTINGS_PREFIX.length);
}

describe("settings pages are projections", () => {
  const modules = settingsPageModules();

  it("finds the settings family to scan at all", () => {
    // Without this, a wrong SETTINGS_DIRECTORY would scan nothing and every
    // assertion below would pass over the empty set.
    expect(modules.length).toBeGreaterThan(3);
    expect(modules.map(nameInsideSettings)).toContain("SettingsSurface.tsx");
    expect(
      modules.filter((module) => nameInsideSettings(module).startsWith("pages")),
    ).not.toStrictEqual([]);
  });

  it("no page derives eligibility or renders a credential-bearing value", () => {
    const offenders = modules
      .map((module) => ({
        module,
        signatures: projectionViolations(readConsoleSourceModule(module), module.displayPath),
      }))
      .filter((entry) => entry.signatures.length > 0)
      .map((entry) => `${entry.module.displayPath}: ${entry.signatures.join(", ")}`);
    expect(offenders).toStrictEqual([]);
  });

  it("negative control: the checker bites on both classes", () => {
    // The clean result above is only worth reading if these fail. Both sides of the
    // line the header draws, asserted against the predicate itself.
    expect(projectionViolations("const canEdit = membership.role === 'owner';")).not.toStrictEqual(
      [],
    );
    expect(projectionViolations("<span>{response.sessionToken}</span>")).toStrictEqual([
      "sessionToken",
    ]);
  });

  it("negative control: a page disabling its own in-flight control is not eligibility", () => {
    // The distinction the header draws, asserted: a write this window started is a
    // fact about this window, and forbidding it would forbid a spinner.
    expect(projectionViolations("isPending={preferences.isPending(key)}")).toStrictEqual([]);
  });

  it("bites on the third operand its own header names: a disabled read off a state", () => {
    // The retired signature list carried no state-name form at all, so
    // `disabled={account.state === "revoked"}` — the header's own third case —
    // matched nothing and this gate reported a page deriving eligibility as clean.
    expect(
      projectionViolations('const row = <button disabled={account.state === "revoked"} />;'),
    ).toStrictEqual(["a disabled computed from a state name"]);
  });

  it("negative control: an ARIA role attribute is not an authority check", () => {
    // `role` is read on ordinary elements all over this console. A gate that flagged
    // the READ rather than the COMPARISON would forbid accessible markup to catch an
    // eligibility decision, so only a comparison counts.
    expect(projectionViolations("const row = <span role={traits.role} />;")).toStrictEqual([]);
  });

  it("reads a real module's code and not its prose", () => {
    // The real-file control. `DiagnosticsPage` explains in its header WHY it never
    // decides that a person may not use something — a sentence naming permissions —
    // and the retired substring predicate could only tell that sentence apart from
    // an authority check by not containing its exact spelling. This asserts both
    // halves: the word is really in the file, and the parser finds nothing.
    const diagnostics = moduleNamed(
      modules,
      "console/settings/pages/diagnostics/DiagnosticsPage.tsx",
      "the page whose header prose names permissions",
    );
    const source = readConsoleSourceModule(diagnostics);

    expect(source).toContain("permissions");
    expect(projectionViolations(source, diagnostics.displayPath)).toStrictEqual([]);
  });

  it("reads a real module that DOES compare a role, and bites on it", () => {
    // The other half of the real-file control: driven over hand-written strings
    // alone, a checker proves only that four fragments match themselves. This is a
    // module in the tree that genuinely compares a membership role in code — it is
    // outside the settings family, which is why it is not a violation of anything,
    // and it is exactly the shape this gate exists to catch inside one.
    const menu = moduleNamed(
      consoleSourceModules({ roots: [CONSOLE_DIRECTORY] }),
      "console/collaboration/members/MembershipActionsMenu.tsx",
      "a real module comparing a membership role",
    );

    expect(projectionViolations(readConsoleSourceModule(menu), menu.displayPath)).toStrictEqual([
      "a compared role or permission",
    ]);
  });
});

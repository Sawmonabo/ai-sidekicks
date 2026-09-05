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
//     permission, a policy, or `canEdit`-shaped predicate is deriving eligibility.
//   • **Credentials.** The console's bridge contract already forbids auth material
//     structurally, so the residual risk is a page inventing a field name and
//     rendering it. The needles are the same family the contracts package's own
//     negative type-test flattens.

import { describe, expect, it } from "vitest";

import {
  CONSOLE_DIRECTORY,
  consoleSourceModules,
  readConsoleSourceModule,
  type ConsoleSourceModule,
} from "../console-source-modules.js";

/** The prefix a settings module's display path carries. */
const SETTINGS_PREFIX = "console/settings/";

/**
 * Identifiers a page would have to name to decide, itself, that a control is not
 * available to this person.
 *
 * Written as identifier fragments rather than as prose, because the offending code
 * is always an expression: the console's rule is that the daemon's typed refusal
 * renders, and a renderer reaching for a role or a permission has stopped waiting
 * for one.
 */
const ELIGIBILITY_SIGNATURES: readonly string[] = [
  "canEdit",
  "canManage",
  "canWrite",
  "isOwner",
  "isAdmin",
  "hasPermission",
  "permissions.",
  "role ===",
  "role !==",
  ".role ",
  "cedar",
];

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

/**
 * Every signature `source` carries, or `[]`.
 *
 * A pure function over text so the negative controls can drive it with strings
 * whose verdict is known, proving the checker bites without perturbing a module.
 */
function projectionViolations(source: string): readonly string[] {
  return [...ELIGIBILITY_SIGNATURES, ...CREDENTIAL_SIGNATURES].filter((signature) =>
    source.includes(signature),
  );
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
        signatures: projectionViolations(readConsoleSourceModule(module)),
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
});

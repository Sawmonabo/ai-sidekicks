// A contracts SCHEMA is a parser, and a parser lives at one door.
//
// WHY THIS FILE EXISTS. The console's single-reading chokepoint banned `zod`, which
// stopped a surface BUILDING a validator and did nothing about the ones already
// built: `@ai-sidekicks/contracts` publicly exports the ready-made schema objects the
// reply registry composes, and the console is otherwise free to import that package.
// A surface could take `QueueItemListResponseSchema`, call `.safeParse()` on a reply
// it obtained directly, and be exactly the second per-surface parser the gate claims
// to reject — with no lint error anywhere. The ban is therefore on the NAME as well
// as on the package, and this file is what says so mechanically.
//
// TWO CLAIMS, AND THE SECOND IS WHY THE FIRST IS ENOUGH. The engine cases below plant
// the ban's own subject list in both directions: a schema value refused outside
// `bridge/**`, and the legitimate imports left alone — a type-only import, and the
// non-schema values (`SESSION_EVENT_CATEGORY_BY_TYPE`, `createTier1Bridge`) the
// console reads today. That is a claim about the IMPORT, and the import is the whole
// gate only if a schema cannot arrive any other way. It cannot: `zod` is banned, this
// package is banned, and the third route — a console barrel that re-exported a schema
// — is closed by the census at the bottom, which reads every door with the TypeScript
// parser rather than with a regular expression over the text.
//
// Nothing here restates the pattern the config declares: a copy would pass with the
// config deleted, which is the failure every gate in this directory exists to prevent.

import { relative } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  consoleSourceModules,
  readConsoleSourceModule,
  type ConsoleSourceModule,
} from "../console-source-modules.js";
import {
  createDesktopLinter,
  DESKTOP_PACKAGE_ROOT,
  ESLINT_CASE_BUDGET_MS,
  rendererProbePath,
  ruleMessagesAt,
  RENDERER_SOURCE_ROOT,
} from "../eslint-harness.js";
import { readModuleSyntax, type CensusModule } from "./barrel-syntax.js";

vi.setConfig({ testTimeout: ESLINT_CASE_BUDGET_MS });

const AUDITED_RULE = "no-restricted-imports";

/** How this corpus spells a parser, which is the whole of the ban's subject. */
const SCHEMA_NAME_SUFFIX = /Schema$/u;

async function restrictedImportMessages(
  source: string,
  filePath: string,
): Promise<readonly string[]> {
  return ruleMessagesAt(createDesktopLinter(), source, filePath, AUDITED_RULE);
}

/** The import the finding was written against, verbatim. */
const IMPORTS_A_REPLY_SCHEMA = [
  `import { QueueItemListResponseSchema } from "@ai-sidekicks/contracts";`,
  `export const parsed = QueueItemListResponseSchema.safeParse({});`,
  ``,
].join("\n");

describe("contracts-schema chokepoint — a schema value stops at the bridge", () => {
  it("refuses a reply schema in a console surface", async () => {
    const messages = await restrictedImportMessages(
      IMPORTS_A_REPLY_SCHEMA,
      rendererProbePath("console", "workspace", "schema-probe.ts"),
    );
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.join("\n")).toContain("callDaemon");
  });

  it("refuses a schema that is not a reply's, because the suffix is the rule", async () => {
    // `MembershipRoleSchema` parses a MEMBER rather than a message, and it is still a
    // canonical parse: the two body reads that need one moved into `bridge/` for this
    // reason rather than being excused where they sat.
    const messages = await restrictedImportMessages(
      [
        `import { MembershipRoleSchema } from "@ai-sidekicks/contracts";`,
        `export const parsed = MembershipRoleSchema.safeParse("owner");`,
        ``,
      ].join("\n"),
      rendererProbePath("console", "store", "schema-probe.ts"),
    );
    expect(messages.length).toBeGreaterThan(0);
  });

  it("refuses one in the shell subtree the console composes seats for", async () => {
    // Asserted synthetically because that subtree does not exist on this branch. A
    // typo in the second half of the `files` selector would otherwise be invisible
    // until the subtree landed carrying a parse.
    const messages = await restrictedImportMessages(
      IMPORTS_A_REPLY_SCHEMA,
      rendererProbePath("shell", "schema-probe.ts"),
    );
    expect(messages.length).toBeGreaterThan(0);
  });

  it("allows one inside `console/bridge/`, which is where the schemas are bound", async () => {
    const messages = await restrictedImportMessages(
      IMPORTS_A_REPLY_SCHEMA,
      rendererProbePath("console", "bridge", "schema-probe.ts"),
    );
    expect(messages).toHaveLength(0);
  });

  it("leaves a type-only import of the same package alone", async () => {
    const messages = await restrictedImportMessages(
      [
        `import type { SidekicksBridge, MembershipRole } from "@ai-sidekicks/contracts";`,
        `export type Probe = { bridge: SidekicksBridge; role: MembershipRole };`,
        ``,
      ].join("\n"),
      rendererProbePath("console", "workspace", "type-probe.ts"),
    );
    expect(messages).toHaveLength(0);
  });

  it("leaves the non-schema VALUES the console reads today alone", async () => {
    // Both are live imports outside `bridge/` on this branch — the event-category
    // census in `frame/run-lifecycle-projector.ts`, and the Tier-1 bridge factory the
    // frame's own suites construct. A ban that swept these up would be wrong in the
    // direction that gets a ban turned off.
    const messages = await restrictedImportMessages(
      [
        `import { SESSION_EVENT_CATEGORY_BY_TYPE, createTier1Bridge } from "@ai-sidekicks/contracts";`,
        `export const probe = { SESSION_EVENT_CATEGORY_BY_TYPE, createTier1Bridge };`,
        ``,
      ].join("\n"),
      rendererProbePath("console", "frame", "value-probe.ts"),
    );
    expect(messages).toHaveLength(0);
  });

  it("negative control: a NON-console renderer path may still import a schema", async () => {
    // The ban is path-scoped and has to be: other plans' renderer subtrees are not
    // bound by this chokepoint. A failure here means the `files` selector had been
    // widened past the console, which is the rule being wrong the other way.
    const messages = await restrictedImportMessages(
      IMPORTS_A_REPLY_SCHEMA,
      rendererProbePath("session-members", "schema-probe.ts"),
    );
    expect(messages).toHaveLength(0);
  });
});

/** Every console module, as the syntax reader takes them. */
function consoleCensusModules(): readonly CensusModule[] {
  return consoleSourceModules({ roots: [RENDERER_SOURCE_ROOT], tests: true }).map(
    (module: ConsoleSourceModule) => ({
      path: relative(DESKTOP_PACKAGE_ROOT, module.absolutePath).split("\\").join("/"),
      source: readConsoleSourceModule(module),
      isTest: /\.test(-support)?\.tsx?$/u.test(module.absolutePath),
    }),
  );
}

describe("contracts-schema chokepoint — no door hands a schema across a family", () => {
  it("publishes no name ending in `Schema` from any console barrel", () => {
    // The premise the import ban rests on. Banning the import is the whole gate only
    // if a schema cannot reach a surface another way, and the one remaining way is a
    // barrel that re-exported one — which no `no-restricted-imports` entry can see,
    // because the surface would be importing a console path.
    const published = readModuleSyntax(consoleCensusModules())
      .filter((module) => module.path.endsWith("/index.ts"))
      .flatMap((module) =>
        module.doorSpecifiers
          .filter((specifier) => SCHEMA_NAME_SUFFIX.test(specifier.exportedName))
          .map((specifier) => `${module.path}: ${specifier.exportedName}`),
      );
    expect(published).toStrictEqual([]);
  });

  it("negative control: the reader finds a planted one", () => {
    // Without this the clean result above would also hold for a reader that parsed
    // nothing, or one whose door filter matched no file.
    const planted = readModuleSyntax([
      {
        path: "src/renderer/src/console/workspace/index.ts",
        source: `export { QueueItemListResponseSchema } from "@ai-sidekicks/contracts";\n`,
        isTest: false,
      },
    ]);
    expect(
      planted[0]?.doorSpecifiers.filter((specifier) =>
        SCHEMA_NAME_SUFFIX.test(specifier.exportedName),
      ),
    ).toHaveLength(1);
  });

  it("negative control: the census reaches the real doors at all", () => {
    const doors = readModuleSyntax(consoleCensusModules()).filter((module) =>
      module.path.endsWith("/index.ts"),
    );
    expect(doors.length).toBeGreaterThan(5);
    expect(doors.flatMap((door) => door.doorSpecifiers).length).toBeGreaterThan(20);
  });
});

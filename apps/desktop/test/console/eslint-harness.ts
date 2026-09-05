// The real ESLint engine over the real flat config, for the gates that assert on it.
//
// Not a test file — no `include` glob reaches it; the architecture tier imports it, the
// way it imports `console-source-modules.ts`. It exists because three gates now drive
// `ESLint.lintText` against `apps/desktop/eslint.config.mjs`, and `apps/desktop`
// AGENTS.md hoists a helper on its second use. The three had already begun to diverge:
// two spelled the desktop root differently and each carried its own timeout constant
// with its own derivation, so a change to the engine's cost had two places to land.
//
// WHY THE ENGINE AND NEVER A COPY OF THE RULE. A gate carrying its own selector list
// would pass with the config deleted, which is the failure every one of these gates
// exists to prevent. `lintText` lints the text it is given AS a path, and the path is
// what decides which config objects match — so a claim about the console's bans is made
// by handing the engine console-shaped source at a console-shaped path and reading what
// comes back.

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";

const HERE = dirname(fileURLToPath(import.meta.url));

/** `console/` → `test/` → the desktop package. */
export const DESKTOP_PACKAGE_ROOT: string = resolve(HERE, "..", "..");

/** The renderer source root every probe path is composed under. */
export const RENDERER_SOURCE_ROOT: string = join(DESKTOP_PACKAGE_ROOT, "src", "renderer", "src");

/**
 * A console path the syntax-ban block covers and no `ignores` entry names.
 *
 * It does not exist on disk and does not need to. `eslint-exemption-census.test.ts`
 * asserts it is genuinely non-exempt, so the probe cannot silently become one.
 */
export const NON_EXEMPT_CONSOLE_PROBE_PATH: string = join(
  RENDERER_SOURCE_ROOT,
  "console",
  "exemption-probe.ts",
);

/**
 * A TIER path the syntax-ban block covers, and no `ignores` entry names.
 *
 * The tiers joined the block's `files` after a family adversarial review found two
 * `Date.parse` calls that had landed under `test/console/` — a test reads the same
 * wire stamps the console does, and a fixture built with a lenient reading records the
 * host's zone into the expectation the surface is then measured against. It does not
 * exist on disk and does not need to; what it is for is asking the real engine which
 * rules a tier file would be linted under.
 */
export const NON_EXEMPT_TIER_PROBE_PATH: string = join(
  DESKTOP_PACKAGE_ROOT,
  "test",
  "console",
  "exemption-probe.ts",
);

/**
 * The per-case budget, sized to the machine rather than to the work.
 *
 * Every case that drives the engine additionally pays the config's whole module graph
 * (`typescript-eslint`, and `typescript` behind it) on whichever case runs first. The
 * figure and its derivation belong to
 * `runtime-node-attach/__tests__/renderer-import-boundary.test.ts`, which measured a
 * 17.6x cold-plus-contended blow-up under a full-workspace `pnpm test` and settled on
 * this number; the same graph, engine, and exposure apply to every consumer here, so it
 * is borrowed rather than re-derived. Nothing in `lintText` has a deadline for this to
 * sit above, and no failure these gates exist to catch is a hang.
 */
export const ESLINT_CASE_BUDGET_MS = 30_000;

/**
 * An engine anchored on the desktop package, so the config under audit is the one that
 * runs — it spreads the repo-root config, and flat-config discovery starts at `cwd`.
 */
export function createDesktopLinter(): ESLint {
  return new ESLint({ cwd: DESKTOP_PACKAGE_ROOT });
}

/** A path under the renderer source root, absolute, for lint-as-if-this-file. */
export function rendererProbePath(...segments: readonly string[]): string {
  return join(RENDERER_SOURCE_ROOT, ...segments);
}

/** Every message one rule reports for `source` linted as `filePath`. */
export async function ruleMessagesAt(
  linter: ESLint,
  source: string,
  filePath: string,
  ruleId: string,
): Promise<readonly string[]> {
  const results = await linter.lintText(source, { filePath });
  return results
    .flatMap((result) => result.messages)
    .filter((message) => message.ruleId === ruleId)
    .map((message) => message.message);
}

// `--fixture <scenario>`, optionally with `--session <session-id>`. The command line is read
// in every build, so a build with no scenarios can refuse `--fixture` at startup (`./index.ts`
// does) instead of launching normally. The catalog is reached only through the dynamic import
// in `checkFixtureLaunchAgainstCatalog`, so a release bundle carries no scenario. Every refusal
// is a startup error with no fallback scenario.

import { parseArgs } from "node:util";

import type { FixtureLaunch } from "#shared/fixture-launch.js";

const LAUNCH_OPTIONS = {
  fixture: { type: "string" },
  session: { type: "string" },
} as const;

/**
 * The fixture launch a command line asks for, or `undefined` when it names none.
 *
 * `argv` is the command line after the executable; other arguments (the app path,
 * Chromium's switches) are left alone. Tokens are read rather than parsed values because a
 * lenient parse turns a bare `--fixture` into `true`, `--fixture --session s` into the scenario
 * `"--session"`, and a repeated option into its last value; each is a mistake to refuse.
 */
export function parseFixtureLaunch(argv: readonly string[]): FixtureLaunch | undefined {
  const { tokens } = parseArgs({
    args: [...argv],
    options: LAUNCH_OPTIONS,
    strict: false,
    allowPositionals: true,
    tokens: true,
  });
  const values = new Map<string, string>();
  for (const token of tokens) {
    if (token.kind !== "option" || !Object.hasOwn(LAUNCH_OPTIONS, token.name)) {
      continue;
    }
    if (token.value === undefined || (token.inlineValue !== true && token.value.startsWith("-"))) {
      throw new Error(`${token.rawName} needs a value`);
    }
    if (values.has(token.name)) {
      throw new Error(`${token.rawName} was given more than once`);
    }
    values.set(token.name, token.value);
  }
  const scenarioId = values.get("fixture");
  const sessionId = values.get("session");
  if (scenarioId === undefined) {
    if (sessionId !== undefined) {
      throw new Error("--session opens a session in a fixture scenario, so it needs --fixture");
    }
    return undefined;
  }
  return sessionId === undefined ? { scenarioId } : { scenarioId, sessionId };
}

/**
 * Refuse a launch the catalog cannot play: a scenario it does not hold, or a session that
 * scenario does not hold.
 */
export async function checkFixtureLaunchAgainstCatalog(launch: FixtureLaunch): Promise<void> {
  const { findScenario } = await import("#fixtures/index.js");
  // Throws, naming every scenario the catalog holds, for an unknown one.
  const scenario = findScenario(launch.scenarioId);
  if (launch.sessionId !== undefined && launch.sessionId !== scenario.sessionId) {
    throw new Error(
      `the scenario "${scenario.id}" holds the session ` +
        `"${scenario.sessionId}", not "${launch.sessionId}"`,
    );
  }
}

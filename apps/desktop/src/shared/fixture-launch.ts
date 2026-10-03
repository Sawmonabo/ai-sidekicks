// A fixture launch as it crosses from the main process into a window.
//
// Main checks `--fixture <scenario>` and `--session <session-id>` against the scenario catalog
// and hands the result to the window as renderer switches through
// `webPreferences.additionalArguments`. The preload reads them off its own `process.argv` and
// exposes the launch to the page, where `services/platform/live-bridge.ts` reads it. Both
// spellings, the switches and the page property, live here once.

/** A checked fixture launch: the scenario a window plays and, optionally, the session it opens. */
export interface FixtureLaunch {
  readonly scenarioId: string;
  readonly sessionId?: string;
}

/**
 * The page property the preload exposes a launch on. Distinctive so the release-absence sweep
 * can prove a shipped bundle free of it by searching for the string.
 */
export const FIXTURE_LAUNCH_GLOBAL = "__fixtureLaunch__";

const SCENARIO_SWITCH = "--sidekicks-fixture-scenario=";
const SESSION_SWITCH = "--sidekicks-fixture-session=";

/** The renderer switches that carry a launch into a window; each value is URI-encoded. */
export function fixtureLaunchSwitches(launch: FixtureLaunch): string[] {
  const scenarioSwitch = `${SCENARIO_SWITCH}${encodeURIComponent(launch.scenarioId)}`;
  return launch.sessionId === undefined
    ? [scenarioSwitch]
    : [scenarioSwitch, `${SESSION_SWITCH}${encodeURIComponent(launch.sessionId)}`];
}

/** The launch a window's switches carry, or `undefined` for a window started without one. */
export function readFixtureLaunchSwitches(argv: readonly string[]): FixtureLaunch | undefined {
  const scenarioId = switchValue(argv, SCENARIO_SWITCH);
  if (scenarioId === undefined) {
    return undefined;
  }
  const sessionId = switchValue(argv, SESSION_SWITCH);
  return sessionId === undefined ? { scenarioId } : { scenarioId, sessionId };
}

function switchValue(argv: readonly string[], prefix: string): string | undefined {
  const argument = argv.find((candidate) => candidate.startsWith(prefix));
  return argument === undefined ? undefined : decodeURIComponent(argument.slice(prefix.length));
}

// What command line a launched console is given, and who gets to decide it.
//
// The harness owns two arguments and always has: the private `--user-data-dir`
// that keeps a launch off Electron's machine-wide `SingletonLock`, and the built
// main entry that says which application this is. Neither is negotiable — a tier
// that could drop the profile flag would lose `requestSingleInstanceLock()` to
// any other Electron on the box and quit before opening a window, which surfaces
// as a timeout with no error.
//
// But a tier sometimes needs a switch of its own. The browser-terminal family's
// endurance test has to force ANGLE onto SwiftShader on the ubuntu runner before
// it can assert that a terminal really took the WebGL renderer tier rather than
// silently falling back to canvas; on a headless runner with no GPU that is a
// property of the command line and of nothing else.
//
// There was no way to say it. `LaunchConsoleOptions` carried `env` and
// `scenarioId`, `electron.launch` took a fixed array, and the one environment
// variable that might have covered it — `ELECTRON_EXTRA_LAUNCH_ARGS` — is
// measured inert at the pinned Electron 44.1.0.
//
// APPENDED, AND THE HARNESS'S OWN SWITCHES REFUSED
//
// A caller's arguments go AFTER the harness's. Position alone is NOT what keeps
// the fixed set authoritative, and an earlier revision of this module claimed it
// was: it said Chromium takes the first occurrence of a repeated switch, so a
// caller's own `--user-data-dir` would be inert. That is false, and measured
// false — `base::CommandLine` parses into a `switches_` map and assigns each
// value as it goes, so the LAST duplicate wins. A launch given
// `--user-data-dir=/tmp/elsewhere` after the harness's own reported
// `/private/tmp/elsewhere` from `app.getPath("userData")`. The claim's test
// passed because it asserted on array positions rather than on Chromium, which
// is the shape of a test that proves nothing about what it names.
//
// The consequence was not cosmetic. A caller could have discarded the private
// profile, put the launch back on Electron's machine-wide `SingletonLock`, lost
// `requestSingleInstanceLock()` to any other Electron on the box, and quit before
// opening a window — which reaches the tier as a timeout with no error, the
// opaque failure this whole area exists to eliminate.
//
// So the guarantee is enforced instead of inferred: a `launchArgs` entry naming
// a switch the harness owns is REFUSED, loudly, before anything is spawned. The
// owned set is derived from the fixed arguments rather than listed by hand, so a
// switch added to the launch is protected by the act of adding it.
//
// Chromium collects switches from the whole command line rather than only from
// what precedes the positional app path, so a switch appended here reaches the
// GPU process the same as one placed first — measured, across five launches
// whose unmasked WebGL renderer string changes with the flags and not without
// them. What appending ALSO does is land the switch in the launched app's own
// `process.argv`, which is harmless for this fixture — the main process reads its
// scenario from the environment and parses no argv of its own — and is the reason
// this is stated rather than left to be discovered.

/**
 * Raised when a caller tries to pass a switch the harness owns.
 *
 * A named class rather than a bare `Error` so a caller can catch this one
 * specifically, and so the offending switch is a field rather than something to
 * be parsed back out of a sentence.
 */
export class HarnessOwnedSwitchError extends Error {
  /** The switch that was refused, without its value — for example `--user-data-dir`. */
  readonly switchName: string;

  constructor(switchName: string) {
    super(
      `\`${switchName}\` is owned by the console harness and cannot be passed in \`launchArgs\`. ` +
        "Chromium's `base::CommandLine` assigns each parsed switch into a map, so a later duplicate " +
        "REPLACES the earlier one rather than being ignored — passing this would silently take the " +
        "launch off its private profile, back onto Electron's machine-wide `SingletonLock`, where it " +
        "loses `requestSingleInstanceLock()` to any other Electron on the machine and quits before " +
        "opening a window, reaching the tier as a timeout with no error.",
    );
    this.name = "HarnessOwnedSwitchError";
    this.switchName = switchName;
  }
}

/**
 * The switch a command-line argument names, or `undefined` if it names none.
 *
 * `--use-gl=angle` and `--use-gl` both name `--use-gl`; a positional path names
 * nothing. Splitting on the FIRST `=` matters: a value may contain one, and
 * `--user-data-dir=/tmp/a=b` still names `--user-data-dir`.
 */
function switchName(argument: string): string | undefined {
  if (!argument.startsWith("--") || argument === "--") {
    return undefined;
  }
  const valueAt = argument.indexOf("=");
  return valueAt === -1 ? argument : argument.slice(0, valueAt);
}

/**
 * Compose the command line for one launch.
 *
 * A free function in its own module rather than an expression inside the
 * harness, because the properties worth checking — that a caller appends, and
 * that it cannot displace what the harness owns — are properties of the ARRAY,
 * and reaching them through `electron.launch` would mean launching Electron to
 * assert on a string.
 *
 * Throws rather than dropping or de-duplicating the offending entry. A caller
 * that passed `--user-data-dir` meant something by it, and silently ignoring the
 * argument would leave it believing the launch honoured a profile it did not.
 */
export function composeLaunchArgs(
  userDataDirectory: string,
  mainEntryPath: string,
  launchArgs: readonly string[] = [],
): string[] {
  const fixedArgs = [`--user-data-dir=${userDataDirectory}`, mainEntryPath];
  // DERIVED from the fixed arguments, never listed separately: a switch added to
  // the launch becomes protected by the act of adding it, and a hand-kept list
  // that fell out of step would be a guarantee stated in one place and enforced
  // in another.
  const harnessOwnedSwitches = new Set(
    fixedArgs.map(switchName).filter((name): name is string => name !== undefined),
  );
  for (const argument of launchArgs) {
    const name = switchName(argument);
    if (name !== undefined && harnessOwnedSwitches.has(name)) {
      throw new HarnessOwnedSwitchError(name);
    }
  }
  return [...fixedArgs, ...launchArgs];
}

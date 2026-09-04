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
// APPENDED, NEVER MERGED
//
// A caller's arguments go AFTER the harness's, and the harness's are copied in
// first from a single source. So a caller can add a switch and cannot remove
// one, cannot reorder the pair, and cannot point the launch at a different
// application: the composition is a concatenation rather than a merge, which is
// what makes "the fixed set stays authoritative" a property of the code instead
// of a convention a reader has to honour.
//
// Chromium collects switches from the whole command line rather than only from
// what precedes the positional app path, so a switch appended here reaches the
// GPU process the same as one placed first. What it ALSO does is land in the
// launched app's own `process.argv`, which is harmless for this fixture — the
// main process reads its scenario from the environment and parses no argv of its
// own — and is the reason this is stated rather than left to be discovered.

/**
 * Compose the command line for one launch.
 *
 * A free function in its own module rather than an expression inside the
 * harness, because the property worth checking — that a caller appends and never
 * displaces — is a property of the ARRAY, and reaching it through
 * `electron.launch` would mean launching Electron to assert on a string.
 */
export function composeLaunchArgs(
  userDataDirectory: string,
  mainEntryPath: string,
  launchArgs: readonly string[] = [],
): string[] {
  return [`--user-data-dir=${userDataDirectory}`, mainEntryPath, ...launchArgs];
}
